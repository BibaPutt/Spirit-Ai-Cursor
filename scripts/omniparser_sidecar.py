#!/usr/bin/env python3
"""Spirit visual-grounding sidecar for Microsoft OmniParser V2/V3.

Electron main spawns one instance per screenshot: this script decodes the
PNG, runs OmniParser's icon detector + Florence captioner when a checkout is
present, and prints ONE JSON line to stdout:

    {"ok": true, "objects": [{"label": "...", "box": [x1, y1, x2, y2]}, ...]}

    {"ok": false, "error": "..."}

Boxes are in the SOURCE IMAGE's pixel space (the same grid the LLM's [POINT]/
[BOX] tags use); Electron maps them to screen DIPs. All logs go to stderr so
stdout stays parseable. When OmniParser (or any of its hard deps) is missing
the script reports ok:false and exits 1 — Electron treats that as
"grounding unavailable" and leaves the annotation pipeline untouched.

Args:
    --image  path to the PNG to examine
    --width  image width in pixels (sanity only)
    --height image height in pixels
    --dir    path to an OmniParser checkout
"""

import argparse
import json
import os
import sys


def fatal(error):
    print(json.dumps({"ok": False, "error": error}, ensure_ascii=False), flush=True)
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--width", type=int, default=0)
    parser.add_argument("--height", type=int, default=0)
    parser.add_argument("--dir", required=True)
    args = parser.parse_args()

    if not os.path.isfile(args.image):
        fatal("image not found")

    sys.path.insert(0, args.dir)

    # OmniParser's public entry point: utils/... varies across V2/V3 tags. Try
    # the stable bits first; anything missing degrades to a clear error.
    try:
        from ultralytics import YOLO  # badge icon detector dependency
    except ImportError:
        fatal("omniparser deps missing: pip install onnxruntime ultralytics etc.")

    try:
        from PIL import Image
    except ImportError:
        fatal("Pillow missing")

    # ---- icon detection (the universal OmniParser V2/V3 YOLO-based model) ----
    model_pt = None
    for candidate in (
        os.path.join(args.dir, "icon_detect", "model.pt"),
        os.path.join(args.dir, "icon_detect_v2", "model.pt"),
        os.path.join(args.dir, "icon_detect_v3", "model.pt"),
        os.path.join(args.dir, "weights", "icon_detect", "model.pt"),
    ):
        if os.path.isfile(candidate):
            model_pt = candidate
            break
    if model_pt is None:
        fatal("icon_detect model.pt not found under the OmniParser dir")

    try:
        det = YOLO(model_pt)
        image = Image.open(args.image).convert("RGB")
        w, h = image.size
        results = det.predict(image, conf=0.3, imgsz=640, verbose=False)
        boxes = results[0].boxes if len(results) else None
        detected = []
        if boxes is not None and boxes.xyxy is not None:
            for xyxy in boxes.xyxy.cpu().numpy():
                x1, y1, x2, y2 = [float(v) for v in xyxy]
                detected.append({"box": [x1, y1, x2, y2]})
    except Exception as exc:  # pragma: no cover - error hygiene across versions
        fatal(f"icon detection failed: {exc}")

    # ---- captioning (Florence gave best labels in OmniParser V2/V3) ---------
    try:
        from transformers import AutoModelForCausalLM, AutoProcessor
    except ImportError:
        fatal("transformers missing for icon captioning")

    caption_id = AutoProcessor.from_pretrained(
        os.path.join(args.dir, "icon_caption_florence"), local_files_only=True
    )
    caption_model = AutoModelForCausalLM.from_pretrained(
        os.path.join(args.dir, "icon_caption_florence"), local_files_only=True
    )
    try:
        if caption_id is None or caption_model is None:  # type: ignore
            raise RuntimeError("caption components empty")
    except Exception as exc:
        fatal(f"florence caption model unavailable: {exc}")

    objects = []
    for d in detected:
        x1, y1, x2, y2 = d["box"]
        if x2 - x1 < 8 or y2 - y1 < 8:
            continue
        crop = image.crop((x1, y1, x2, y2))
        prompt = "<MORE_DETAILED_CAPTION>"
        try:
            inputs = caption_id(prompt, return_tensors="pt")
            out = caption_model.generate(**inputs, max_new_tokens=16, num_beams=1)
            label = caption_id.batch_decode(out, skip_special_tokens=True)[0].strip()
        except Exception:
            label = "object"
        if not label:
            label = "object"
        objects.append({"label": label, "box": [x1, y1, x2, y2]})

    print(json.dumps({"ok": True, "objects": objects}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()