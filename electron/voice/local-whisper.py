#!/usr/bin/env python3
"""Spirit local speech-to-text sidecar.

Runs a small Flask server on 127.0.0.1:5100 that transcribes audio.
Model loading is lazy (first /transcribe) and there is exactly ONE model:
X-Turbo (Whisper large-v3-turbo). Backend order:
  1. whisper.cpp — reuse the GGML model + whisper-cli that X-Whisper already
     installed on this machine (CUDA when available). Zero download.
  2. faster-whisper with cached CT2 turbo weights (the same large-v3-turbo
     model, different format) when whisper.cpp assets are absent.
  3. download the CT2 turbo weights as a last resort (first run, network).
Electron main spawns this process on startup, polls /health, and kills it
on quit.

Endpoints
---------
GET  /health            -> { ok, ready, model, device, compute_type, ... }
POST /transcribe        body = raw audio bytes (Content-Type: <mime>)
                         ?language=<2-letter> optional (default: auto-detect)
                         -> { text, language, language_probability,
                              duration_seconds }

If the sidecar is missing or the model has not finished loading, the
main process keeps /health reporting not-ready and the voice pipeline
falls back to the existing cloud transcribeAudio.
"""

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave

try:
    from flask import Flask, jsonify, request
except ImportError:
    print(
        "[local-whisper] Flask not installed. Run: pip install flask faster-whisper",
        file=sys.stderr,
        flush=True,
    )
    sys.exit(1)

logging.getLogger("werkzeug").setLevel(logging.ERROR)

app = Flask(__name__)

HOST = os.environ.get("SPIRIT_STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("SPIRIT_STT_PORT", "5100"))
MODEL = os.environ.get("SPIRIT_STT_MODEL", "turbo")

# whisper.cpp reuse (X-Whisper on this machine). Electron resolves these and
# passes them in; if they are empty the whisper.cpp backend is simply skipped.
WHISPER_CLI = os.environ.get("SPIRIT_STT_WHISPER_CLI", "")
GGML_MODEL = os.environ.get("SPIRIT_STT_GGML_MODEL", "")
FFMPEG_BIN = os.environ.get("SPIRIT_STT_FFMPEG", "")
BACKEND_HINT = os.environ.get("SPIRIT_STT_BACKEND", "auto").lower()
WC_TIMEOUT_SEC = float(os.environ.get("SPIRIT_STT_WHISPER_TIMEOUT", "300"))
_wc_lock = threading.Lock()
_wc_flags = None

SUPPORTED_SUFFIX = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp3": ".mp3",
    "audio/mpeg": ".mp3",
    "audio/m4a": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
}

_model = None
_backend = None  # 'faster' | 'openai' — which engine actually loaded
_model_lock = threading.Lock()
# Phase + byte-level download progress for the first-run model download.
# Electron polls /health and forwards this to the renderer so the tiny
# capsule can show "STT setup 46%" instead of a frozen "Transcribing…".
_download_progress = None  # 0..100 float, or None when not downloading
_download_error: str | None = None  # set when the download gives up (phase=error)
_phase = "idle"  # idle | downloading | installing | ready | error
_model_info = {
    "ok": False,  # server up (set True in main() before app.run)
    "ready": False,  # model loaded
    "model": MODEL,
    "device": None,
    "compute_type": None,
    "backend": None,  # 'faster' | 'openai' once loaded
    "phase": _phase,
    "download_progress": _download_progress,
    "pid": os.getpid(),
    "load_seconds": None,
}

# faster-whisper model name -> HuggingFace repo id. Unknown sizes fall back
# to the generic Systran/faster-whisper-<size> convention.
REPO_IDS = {
    # faster-whisper upstream maps both names to this repo; the old
    # `Systran/faster-whisper-turbo` never existed (it 404'd every download).
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3",
}


def _cache_dir():
    default = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
    return os.environ.get("SPIRIT_STT_CACHE_DIR") or default


def _faster_whisper_cached():
    """True when the faster-whisper weights for REPO_IDS[MODEL] are already on
    disk (no download needed). Checks for the actual model file, NOT a
    pristine snapshot: faster-whisper's own downloader skips .gitattributes /
    README.md, so huggingface_hub's local_files_only check ALWAYS reports
    "incomplete" for weights it downloaded itself (this silently pinned
    everyone to the slow openai-whisper fallback — the v1.2.x slowness bug).
    """
    repo_id = REPO_IDS.get(MODEL, f"Systran/faster-whisper-{MODEL}")
    return _snapshot_has_model(repo_id, _cache_dir())


def _openai_whisper_cached():
    """True when an openai-whisper weights file for MODEL is cached in
    ~/.cache/whisper (whisper's standard download root — the WhatsApp RAG
    bot's `whisper.load_model("small")` populates exactly this file)."""
    return os.path.exists(
        os.path.join(os.path.expanduser("~"), ".cache", "whisper", f"{MODEL}.pt")
    )


# ---- whisper.cpp backend (reuses X-Whisper's installed model + binary) ----

def _wc_ready():
    return bool(WHISPER_CLI) and bool(GGML_MODEL) and os.path.isfile(WHISPER_CLI) and os.path.isfile(GGML_MODEL)


def _wc_device():
    hinted = (os.environ.get("SPIRIT_STT_WC_DEVICE") or "").strip().lower()
    if hinted in ("cuda", "vulkan", "cpu"):
        return hinted
    lower = WHISPER_CLI.lower()
    if "cuda" in lower:
        return "cuda"
    if "vulkan" in lower:
        return "vulkan"
    return "cpu"


def _wc_supported_flags():
    """Probe `whisper-cli --help` once. X-Whisper's build may add/rename flags
    between releases, so the caller only ever passes flags this binary
    advertises. If the probe fails, assume the documented set."""
    global _wc_flags
    if _wc_flags is not None:
        return _wc_flags
    known = [
        "--output-json",
        "--output-file",
        "--no-timestamps",
        "--suppress-nst",
        "--no-fallback",
        "--threads",
        "--beam-size",
        "--best-of",
        "--language",
        "--prompt",
        "--no-prints",
    ]
    try:
        res = subprocess.run(
            [WHISPER_CLI, "--help"],
            cwd=os.path.dirname(WHISPER_CLI) or None,
            capture_output=True,
            timeout=15,
        )
        text = (res.stdout or b"") + (res.stderr or b"")
        help_text = text.decode("utf-8", "ignore")
        _wc_flags = {f for f in known if f in help_text}
        if not _wc_flags:
            _wc_flags = set(known)
    except Exception as err:
        print(f"[local-whisper] whisper-cli --help probe failed: {err}", flush=True)
        _wc_flags = set(known)
    print(f"[local-whisper] whisper-cli flags: {sorted(_wc_flags)}", flush=True)
    return _wc_flags


def _decode_with_av(src_path, out_path):
    """PyAV fallback when no ffmpeg binary is available (faster-whisper
    already depends on av + numpy)."""
    import av

    frames = []
    with av.open(src_path) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in container.decode(stream):
            out = resampler.resample(frame)
            if out is None:
                continue
            for rf in out if isinstance(out, list) else [out]:
                frames.append(rf.to_ndarray().tobytes())
        tail = resampler.resample(None)
        if tail is not None:
            for rf in tail if isinstance(tail, list) else [tail]:
                frames.append(rf.to_ndarray().tobytes())
    with wave.open(out_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"".join(frames))


def _decode_to_wav16k(src_path):
    """Any mic container/codec -> 16 kHz mono PCM WAV for whisper-cli."""
    fd, out_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    ffmpeg = FFMPEG_BIN if FFMPEG_BIN and os.path.isfile(FFMPEG_BIN) else shutil.which("ffmpeg")
    if ffmpeg:
        try:
            subprocess.run(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    src_path,
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-f",
                    "wav",
                    out_path,
                ],
                check=True,
                timeout=120,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            return out_path
        except Exception as err:
            print(f"[local-whisper] ffmpeg decode failed, trying PyAV: {err}", flush=True)
    try:
        _decode_with_av(src_path, out_path)
        return out_path
    except Exception:
        try:
            os.unlink(out_path)
        except OSError:
            pass
        raise


def _wc_transcribe(wav_path, language, prompt, fast):
    flags = _wc_supported_flags()
    if "--output-json" not in flags or "--output-file" not in flags:
        raise RuntimeError("whisper-cli build has no --output-json support")
    threads = max(2, min(8, (os.cpu_count() or 4) - 2))
    base = os.path.join(tempfile.mkdtemp(prefix="spirit-wc-"), "out")
    cmd = [
        WHISPER_CLI,
        "--model",
        GGML_MODEL,
        "--file",
        wav_path,
        "--output-json",
        "--output-file",
        base,
        "--threads",
        str(threads),
        "--language",
        (language or "auto"),
    ]
    if "--no-timestamps" in flags:
        cmd.append("--no-timestamps")
    if "--suppress-nst" in flags:
        cmd.append("--suppress-nst")
    if "--no-fallback" in flags:
        cmd.append("--no-fallback")
    if "--no-prints" in flags:
        cmd.append("--no-prints")
    if "--beam-size" in flags:
        cmd.extend(["--beam-size", "1" if fast else "5"])
    if "--best-of" in flags:
        cmd.extend(["--best-of", "1"])
    if prompt and "--prompt" in flags:
        cmd.extend(["--prompt", prompt])
    try:
        # whisper.cpp keeps one CUDA context per process; serialize so two
        # live slices can never fight over the GPU.
        with _wc_lock:
            res = subprocess.run(
                cmd,
                cwd=os.path.dirname(WHISPER_CLI) or None,
                capture_output=True,
                timeout=WC_TIMEOUT_SEC,
            )
        if res.returncode != 0:
            err = (res.stderr or res.stdout or b"").decode("utf-8", "ignore")[-500:]
            raise RuntimeError(f"whisper-cli exited {res.returncode}: {err.strip()}")
        json_path = base + ".json"
        with open(json_path, encoding="utf-8") as fh:
            data = json.load(fh)
        segments = data.get("transcription") or []
        text = "".join((seg.get("text") or "") for seg in segments).strip()
        if not text:
            text = (data.get("text") or "").strip()
        result = data.get("result") or {}
        lang_out = result.get("language") or language
        duration = None
        if segments:
            offsets = segments[-1].get("offsets") or {}
            if isinstance(offsets.get("to"), (int, float)):
                duration = round(offsets["to"] / 1000.0, 2)
        return text, lang_out, None, duration
    finally:
        shutil.rmtree(os.path.dirname(base), ignore_errors=True)


def _wc_prewarm(wav_path):
    _wc_transcribe(wav_path, None, None, True)


def _load_whispercpp():
    global _model, _backend, _phase
    _phase = "installing"
    if not _wc_ready():
        raise RuntimeError("whisper-cli or X-Turbo GGML model not found")
    flags = _wc_supported_flags()
    if "--output-json" not in flags or "--output-file" not in flags:
        raise RuntimeError("whisper-cli build has no JSON output")
    device = _wc_device()
    _model = {"backend": "whispercpp", "cli": WHISPER_CLI, "model": GGML_MODEL}
    _backend = "whispercpp"
    _model_info.update(
        {
            "ready": True,
            "model": MODEL,
            "device": device,
            "compute_type": "f16" if device != "cpu" else "f32",
            "backend": _backend,
            "load_seconds": 0,
        }
    )
    _phase = "ready"
    print(
        f"[local-whisper] whisper.cpp ready model={GGML_MODEL} device={device}",
        flush=True,
    )
    if device != "cpu":
        # Pay the CUDA context cost once here instead of on the first live
        # chunk (a 1 s silence pass is enough to initialise it).
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            with wave.open(path, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(16000)
                wf.writeframes(b"\x00\x00" * 16000)
            _wc_prewarm(path)
        except Exception as err:
            print(f"[local-whisper] whisper.cpp warmup skipped: {err}", flush=True)
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
    return _model, _backend


def _load_faster_whisper():
    global _model, _backend, _phase
    from faster_whisper import WhisperModel

    # CPU is the reliable default: the ctranslate2 wheel ships CUDA support,
    # so device="auto" tries GPU first and dies with a missing cublas64_12.dll
    # on machines without the CUDA runtime. Users with a working GPU env can
    # opt in via SPIRIT_STT_DEVICE=cuda.
    device = os.environ.get("SPIRIT_STT_DEVICE", "cpu")
    compute_type = os.environ.get("SPIRIT_STT_COMPUTE_TYPE", "int8")
    _phase = "installing"
    print(
        f"[local-whisper] loading faster-whisper '{MODEL}' device={device} "
        f"compute_type={compute_type}",
        flush=True,
    )
    start = time.time()
    _model = WhisperModel(
        MODEL,
        device=device,
        compute_type=compute_type,
        download_root=_cache_dir(),
    )
    _backend = "faster"
    _model_info.update(
        {
            "ready": True,
            "model": MODEL,
            "device": device,
            "compute_type": compute_type,
            "backend": _backend,
            "load_seconds": round(time.time() - start, 2),
        }
    )
    _phase = "ready"
    print(f"[local-whisper] faster-whisper ready in {_model_info['load_seconds']}s", flush=True)
    return _model, _backend


def _load_openai_whisper():
    global _model, _backend, _phase
    import shutil

    import whisper

    # whisper shells out to the ffmpeg CLI; if none is on PATH, borrow the
    # one bundled with imageio-ffmpeg (the WhatsApp RAG bot's dependency).
    if shutil.which("ffmpeg") is None:
        try:
            import imageio_ffmpeg

            ffmpeg_dir = os.path.dirname(imageio_ffmpeg.get_ffmpeg_exe())
            os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
        except Exception:
            pass
    _phase = "installing"
    print(f"[local-whisper] loading openai-whisper '{MODEL}' (cached fallback)", flush=True)
    start = time.time()
    _model = whisper.load_model(MODEL)  # reads ~/.cache/whisper/<size>.pt
    _backend = "openai"
    _model_info.update(
        {
            "ready": True,
            "model": MODEL,
            "device": "cpu",
            "compute_type": None,
            "backend": _backend,
            "load_seconds": round(time.time() - start, 2),
        }
    )
    _phase = "ready"
    print(f"[local-whisper] openai-whisper ready in {_model_info['load_seconds']}s", flush=True)
    return _model, _backend


def load_model():
    """Lazily load a transcription model on the first /transcribe so startup
    stays fast. Backend order:
      1. whisper.cpp reusing X-Whisper's GGML X-Turbo + whisper-cli (no
         download, CUDA when available);
      2. faster-whisper IF the CT2 turbo weights are already cached;
      3. openai-whisper IF its weights are already cached (legacy fallback);
      4. download faster-whisper CT2 turbo as a last resort (first run).
    """
    global _model, _backend
    with _model_lock:
        if _model is not None:
            return _model, _backend

        if BACKEND_HINT != "faster" and _wc_ready():
            try:
                return _load_whispercpp()
            except Exception as err:
                print(
                    f"[local-whisper] whisper.cpp failed, trying faster-whisper: {err}",
                    file=sys.stderr,
                    flush=True,
                )

        if _faster_whisper_cached():
            try:
                return _load_faster_whisper()
            except Exception as err:
                print(
                    f"[local-whisper] faster-whisper failed, trying openai-whisper: {err}",
                    file=sys.stderr,
                    flush=True,
                )

        if _openai_whisper_cached():
            try:
                return _load_openai_whisper()
            except Exception as err:
                print(
                    f"[local-whisper] openai-whisper failed: {err}",
                    file=sys.stderr,
                    flush=True,
                )
                raise

        # Neither backend is cached — download faster-whisper (first run).
        _ensure_model_downloaded()
        return _load_faster_whisper()


# Download resilience: attempts + progressive backoff between them.
DOWNLOAD_RETRIES = 3
DOWNLOAD_BACKOFF_S = (5, 15, 30)


def _repo_cache_dir(repo_id: str, cache: str) -> str:
    return os.path.join(cache, "models--" + repo_id.replace("/", "--"))


def _snapshot_has_model(repo_id: str, cache: str) -> bool:
    """True when a snapshot dir holds an actual model file (not just refs /
    .incomplete crumbs from a failed download)."""
    snap_root = os.path.join(_repo_cache_dir(repo_id, cache), "snapshots")
    try:
        names = os.listdir(snap_root)
    except OSError:
        return False
    for name in names:
        snap = os.path.join(snap_root, name)
        if not os.path.isdir(snap):
            continue
        try:
            for f in os.listdir(snap):
                if f == "model.bin" or f.endswith(".onnx") or f == "model.safetensors":
                    return True
        except OSError:
            continue
    return False


def _wipe_repo_cache(repo_id: str, cache: str) -> None:
    import shutil

    try:
        shutil.rmtree(_repo_cache_dir(repo_id, cache), ignore_errors=True)
    except Exception:
        pass


def _ensure_model_downloaded():
    """Download the model weights via huggingface_hub so we can surface a
    live percentage. Skips when the files are already cached locally.

    Failure handling: up to DOWNLOAD_RETRIES attempts with progressive
    backoff (5s/15s/30s), per-request timeouts via HF env knobs, and a
    full cache-dir wipe on final failure so a half-downloaded repo never
    looks "downloaded" later (resuming a corrupt cache caused the
    tensor-shape crashes we chased in v1.2.x)."""
    global _download_progress, _phase, _download_error
    repo_id = REPO_IDS.get(MODEL, f"Systran/faster-whisper-{MODEL}")
    cache = _cache_dir()
    # Per-request timeouts (huggingface_hub honors these env knobs). Without
    # them one wedged connection stalls the download forever with the
    # progress bar frozen.
    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("[local-whisper] huggingface_hub not found; skipping pre-download", flush=True)
        return

    try:
        snapshot_download(repo_id=repo_id, cache_dir=cache, local_files_only=True)
        if _snapshot_has_model(repo_id, cache):
            return
        print("[local-whisper] cache incomplete (no model file); re-downloading", flush=True)
    except Exception:
        pass

    _phase = "downloading"
    _download_progress = 0.0
    _download_error = None
    print(f"[local-whisper] downloading model '{repo_id}' (first run)", flush=True)
    last_err: Exception | None = None
    for attempt in range(1, DOWNLOAD_RETRIES + 1):
        try:
            try:
                from tqdm import tqdm

                # Subclass real tqdm (huggingface_hub requires the full interface:
                # get_lock, unpause, etc.). Mirror its per-file byte progress into
                # the global download_progress so /health reports a live percent.
                class _ProgressTqdm(tqdm):
                    def update(self, n=1):
                        super().update(n)
                        if self.total:
                            global _download_progress
                            _download_progress = min(100.0, max(0.0, self.n / self.total * 100))

                snapshot_download(repo_id=repo_id, cache_dir=cache, tqdm_class=_ProgressTqdm)
            except TypeError:
                snapshot_download(repo_id=repo_id, cache_dir=cache)
            if _snapshot_has_model(repo_id, cache):
                break
            last_err = RuntimeError("download finished but no model file on disk")
            print(f"[local-whisper] attempt {attempt}: incomplete, retrying", flush=True)
        except Exception as err:
            last_err = err
            print(f"[local-whisper] attempt {attempt} failed: {err}", flush=True)
        if attempt < DOWNLOAD_RETRIES:
            wait = DOWNLOAD_BACKOFF_S[min(attempt - 1, len(DOWNLOAD_BACKOFF_S) - 1)]
            print(f"[local-whisper] retrying in {wait}s…", flush=True)
            time.sleep(wait)
    else:
        # Loop exhausted without break — fall through to the check below.
        pass
    _download_progress = None
    if _snapshot_has_model(repo_id, cache):
        _phase = "installing"
        print("[local-whisper] download complete; installing model", flush=True)
        return
    # Final failure: wipe the repo cache so a partial download never poses
    # as a good model later. Next attempt starts clean and resumes via
    # HTTP range requests anyway.
    _phase = "error"
    _download_error = str(last_err) if last_err else "download failed"
    print(f"[local-whisper] download failed after {DOWNLOAD_RETRIES} attempts: {_download_error}", flush=True)
    _wipe_repo_cache(repo_id, cache)
    raise RuntimeError(_download_error)


@app.get("/health")
def health():
    _model_info["pid"] = os.getpid()
    _model_info["phase"] = _phase
    _model_info["download_progress"] = _download_progress
    _model_info["download_error"] = _download_error
    return jsonify(_model_info)


@app.post("/transcribe")
def transcribe():
    language = (request.args.get("language") or "").strip().lower() or None
    # Phase 7: `fast=1` asks for beam_size=1 (interim live chunks love speed);
    # authoritative transcriptions (final tail) keep beam_size=5 accuracy.
    fast = request.args.get("fast") == "1"
    # Phase 7: `prompt` is fed to faster-whisper's initial_prompt — the running
    # live transcript gives the model sentence context (offsets hallucinations,
    # pins the detected language, keeps app-domain terms stable).
    prompt = (request.args.get("prompt") or "").strip() or None
    mime = (request.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    raw = request.get_data(cache=False)
    if not raw:
        return jsonify({"error": "empty audio body"}), 400

    try:
        model, backend = load_model()
    except Exception as err:
        print(f"[local-whisper] model load failed: {err}", file=sys.stderr, flush=True)
        return jsonify({"error": f"model load failed: {err}"}), 500

    suffix = SUPPORTED_SUFFIX.get(mime, ".webm")
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
        try:
            if backend == "whispercpp":
                wav_path = None
                try:
                    wav_path = _decode_to_wav16k(path)
                    text, lang_out, lang_prob, dur = _wc_transcribe(
                        wav_path, language, prompt, fast
                    )
                finally:
                    if wav_path:
                        try:
                            os.unlink(wav_path)
                        except OSError:
                            pass
            elif backend == "faster":
                segments, info = model.transcribe(
                    path,
                    language=language,
                    initial_prompt=prompt,
                    vad_filter=True,
                    beam_size=1 if fast else 5,
                    condition_on_previous_text=False,
                    # Hallucination guards: skip segments the model itself
                    # flags as non-speech instead of inventing text
                    # ("hell yeah" on silence). The renderer also energy-gates
                    # slices before they are even sent.
                    no_speech_threshold=0.5,
                    # VAD tuned for short voice commands, not podcasts: the
                    # stock 2000ms end-silence is far too lazy and lets
                    # trailing noise/hums get transcribed as words.
                    vad_parameters=dict(
                        threshold=0.5,
                        min_speech_duration_ms=150,
                        min_silence_duration_ms=300,
                        speech_pad_ms=200,
                    ),
                )
                text = "".join(seg.text for seg in segments).strip()
                lang_out = info.language
                lang_prob = (
                    round(info.language_probability, 3)
                    if info.language_probability is not None
                    else None
                )
                dur = round(info.duration, 2) if info.duration else None
            else:
                # openai-whisper (slow fallback) is fragile on crumbs: sub-second
                # slices crash its tensor stack ("Sizes of tensors must match"),
                # and initial_prompt + auto-detect trips the same path. Guard
                # both — short audio returns empty instead of a 500.
                import whisper as _whisper_audio

                try:
                    _samples = _whisper_audio.audio.load_audio(path)
                except Exception:
                    _samples = []
                if len(_samples) < 16000:  # < 1s of audio: nothing to say
                    return jsonify(
                        {
                            "text": "",
                            "language": language,
                            "language_probability": None,
                            "duration_seconds": round(len(_samples) / 16000, 2),
                        }
                    )
                result = model.transcribe(
                    path,
                    language=language,
                    # Prompt only helps when the language is pinned; with
                    # auto-detect it trips the tensor-shape crash above.
                    initial_prompt=prompt if language else None,
                    beam_size=1 if fast else 5,
                    fp16=False,
                    # Same hallucination guards as the faster path: never
                    # condition on previous text (kills loops), skip
                    # model-flagged non-speech instead of inventing words.
                    condition_on_previous_text=False,
                    no_speech_threshold=0.5,
                )
                text = (result.get("text") or "").strip()
                lang_out = result.get("language")
                lang_prob = result.get("language_probability")
                dur = result.get("duration")
        except Exception as err:
            print(f"[local-whisper] transcribe failed: {err}", file=sys.stderr, flush=True)
            return jsonify({"error": f"transcribe failed: {err}"}), 500

        return jsonify(
            {
                "text": text,
                "language": lang_out,
                "language_probability": lang_prob,
                "duration_seconds": dur,
            }
        )
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def main():
    global HOST, PORT, MODEL, _model_info
    parser = argparse.ArgumentParser(description="Spirit local STT sidecar")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--model", default=MODEL)
    args = parser.parse_args()
    HOST, PORT, MODEL = args.host, args.port, args.model
    _model_info["model"] = MODEL
    # ok:true the moment the server answers — the model is loaded lazily on
    # first /transcribe. Electron treats ok as "sidecar is usable" and
    # ready as "model loaded", and keeps polling for download progress.
    _model_info["ok"] = True
    print(f"[local-whisper] starting on {HOST}:{PORT} model={MODEL}", flush=True)
    # Warm the model in the background when its weights are already cached
    # (a few seconds), so /health flips ready quickly and even the FIRST live
    # chunk routes to local instead of hanging on cloud. Machines with no
    # cached model stay lazy — the download happens on first /transcribe.
    if _wc_ready() or _faster_whisper_cached() or _openai_whisper_cached():
        threading.Thread(target=load_model, daemon=True).start()
    try:
        app.run(host=HOST, port=PORT, threaded=True, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
