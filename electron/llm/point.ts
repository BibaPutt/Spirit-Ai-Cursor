// POINT protocol (Phase 4) + screen annotations (Phase 7). The answering model
// emits inline tags in its stream — [POINT:x,y:label:screenN], [BOX:x,y,w,h:
// label:screenN], [BOX:el123:label] and [ARROW:x1,y1:x2,y2:label:screenN] —
// to point at, box and draw arrows between UI elements on the user's screen.
// Main parses them per token-delta, maps image-pixel coordinates into absolute
// screen DIP space, and streams them to the renderer, which animates a cursor
// fly-to over a persistent annotation overlay (annotation boxes, arrows
// and numbered chips). This module is deliberately free of Electron imports so
// it can be unit-tested in isolation.

export type PointTag = {
  x: number;
  y: number;
  label: string;
  screen: number;
};

// A parsed annotation tag in IMAGE-PIXEL space (except box-el, which names a
// scene element id — its frame is resolved on the main side).
export type AnnotationTag =
  | { kind: 'point'; x: number; y: number; label: string; screen: number }
  | { kind: 'box'; x: number; y: number; w: number; h: number; label: string; screen: number }
  | { kind: 'box-el'; id: string; label: string }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; label: string; screen: number };

// Where a POINT/BOX/ARROW tag's coordinates live. Tags are written in the
// PIXEL space of the screenshot the model was last shown; this geometry
// translates that image space into the absolute screen DIP space the overlay
// uses (primary-monitor origin — the same space click/move_mouse use).
//
// The geometry always describes the CANONICAL image = the full-display shot:
// absLeft/absTop = display.bounds origin, winW/winH = display.size (DIP),
// imgW/imgH = the display's native pixel grid. A tag written against that
// image maps exactly as `absLeft + (px/imgW)*winW`.
//
// CROPPED images (see_screen window shots, user-dragged rectangles) describe
// the SAME canonical frame plus a `region`: where the crop sits within the
// canonical image's pixel grid and how big it is (in canonical pixels). Tags
// are written in the CROP's pixels; mapping adds region.x/y before scaling,
// and bounds checks use region.w/h. Since crops are captured at the display's
// native resolution, one crop pixel == one canonical pixel — no rescale.
export type PointGeo = {
  imgW: number;
  imgH: number;
  absLeft: number;
  absTop: number;
  winW: number;
  winH: number;
  region?: { x: number; y: number; w: number; h: number };
  // When a region crop was DOWNSCALED before the model saw it (resizeImageMaxEdge),
  // region.w/h are the RESIZED (model) pixels while cropSize.w/h are what those
  // pixels actually covered in canonical display px. The ratio un-resizes a tag:
  // canonical = region.x + tag.x * (cropSize.w / region.w). Absent → 1:1, the
  // pre-scale behavior every consumer already relies on.
  cropSize?: { w: number; h: number };
  // Scene elements are stored in AGENT units (= native physical pixels on
  // Windows, DIP/points on macOS). The geo's image/grid spaces are DIP-aligned
  // (mapPointToScreen maps into absolute screen DIP). On scaled Windows
  // displays a scene rect in physical px must be divided by this factor (the
  // per-display scaleFactor) before it can be placed in the DIP image grid —
  // otherwise whole annotation groups shift by (scaleFactor - 1) * distance.
  agentUnitsPerDip?: number;
};

// Labels may contain colons ("direction:From search box to close button"), and
// the trailing :screenN suffix is optional (the attached screenshot is always
// screen0). The suffix is matched LAST so a label that merely ends in a digit
// ("step 2") is never mistaken for a screen id — only a literal `:screen<num>`
// preceding the closing bracket counts. Numbers tolerate stray whitespace (the
// model writes "[POINT:10, 20:…]" and "[ARROW:300, 620, 1500, 620:…]" — a hard
// space would otherwise silently kill the tag) and labels are optional
// ("[POINT:1000,760]", "[BOX:50,100,200,150]") so a missing label never drops
// a drawable pointer.
export const POINT_TAG_REGEX = /\[POINT:\s*(\d+)\s*,\s*(\d+)\s*(?::([^\]]*?)(?::screen(\d+))?)?\]/g;
export const POINT_STRIP_REGEX = /\[POINT:[^\]]+\]/g;
const BOX_EL_TAG_REGEX = /\[BOX:(el[0-9a-z]+):([^\]]+)\]/g;
const BOX_PX_TAG_REGEX = /\[BOX:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?::([^\]]*?)(?::screen(\d+))?)?\]/g;
// Repair: a BOX written with only x,y (no width/height) — the model does
// "[BOX:12,12:Media Library]" when it means a spot, not a region. Coercing it
// to a labeled POINT at (x,y) preserves the intent instead of dropping it.
const BOX_2INT_TAG_REGEX = /\[BOX:\s*(\d+)\s*,\s*(\d+)\s*:([^\]]*?)(?::screen(\d+))?\]/g;
// ARROW coordinates. The model fills the y1→x2 slot with a literal arrow glyph
// ("→"), a dash, a comma or stray spaces instead of the bare colon — accept
// any short non-digit gap there so near-valid tags still parse ("228,360:→:
// 398,330", "300, 620, 1500, 620", "100,760→120,760"). The gap must stay
// DIGIT-FREE so labels containing numbers never masquerade as a second pair.
// The label itself is optional ("[ARROW:100,760→120,760]").
const ARROW_TAG_REGEX = /\[ARROW:\s*(\d+)\s*,\s*(\d+)\s*[,:→>\-\s]{1,8}\s*(\d+)\s*,\s*(\d+)\s*(?::([^\]]*?)(?::screen(\d+))?)?\]/g;
// LAST-RESORT leak cleaner. Any complete [POINT:…]/[BOX:…]/[ARROW:…] token —
// however malformed (missing coordinate pairs, label-first, stray glyphs) —
// is annotation DATA, never answer text. Both parse and strip run against the
// STRICT regexes above, so an unparseable tag would otherwise survive every
// strip and leak raw into the displayed answer, TTS and session history. The
// colon is required so bare prose mentions like "[BOX] tool in Figma" (shape
// name, no data) stay intact.
const TAG_LEAK_REGEX = /\[(?:POINT|BOX|ARROW)[^\]\n]*:[^\]\n]*\]/g;

// JSON-object fallback (weak-model annotation form)
// The weak local model frequently writes annotations as inline JSON objects
// instead of bracket tags: "The Canvas Area {"point": [700, 500]}" or
// "pane {"box": [20, 40, 120, 175]}". Same IMAGE-pixel coordinate space, same
// task — so both forms parse and strip identically. The optional "label" key
// carries the chip label; when it is absent the label stays in the surrounding
// prose (the label-snap/ocr-ground pipeline anchors by position anyway).
// screen is always 0 (the attached screenshot) for this form.
const POINT_JSON_REGEX = /\{\s*"point"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]\s*(?:,\s*"label"\s*:\s*"([^"]*)"\s*)?\}/g;
const BOX_JSON_REGEX =
  /\{\s*"box"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*(?:,\s*"label"\s*:\s*"([^"]*)"\s*)?\}/g;
const ARROW_JSON_REGEX =
  /\{\s*"arrow"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*(?:,\s*"label"\s*:\s*"([^"]*)"\s*)?\}/g;
// Strip ANY complete JSON annotation object (same shape the parser accepts)
// so it never leaks into the displayed answer, TTS or history.
const ANNOTATION_JSON_STRIP_REGEX =
  /\{\s*"(?:point|box|arrow)"\s*:\s*\[[^\]]*\]\s*(?:,\s*"label"\s*:\s*"[^"]*"\s*)?\}/g;

// All complete POINT tags in a body of text.
export function parsePoints(text: string): PointTag[] {
  const tags: PointTag[] = [];
  POINT_TAG_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = POINT_TAG_REGEX.exec(text)) !== null) {
    tags.push({
      x: parseInt(m[1], 10),
      y: parseInt(m[2], 10),
      label: (m[3] ?? '').trim(),
      screen: m[4] ? parseInt(m[4], 10) : 0,
    });
  }
  return tags;
}

// All complete annotation tags (POINT / BOX / BOX-el / ARROW) in story order.
// Each regex is scanned independently and the results merge-sorted by their
// index in the source text, so mixed tag kinds keep the order the model wrote.
export function parseAnnotations(text: string): AnnotationTag[] {
  const found: { index: number; tag: AnnotationTag }[] = [];
  const scan = (re: RegExp, make: (m: RegExpExecArray) => AnnotationTag) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      found.push({ index: m.index, tag: make(m) });
    }
  };
  scan(POINT_TAG_REGEX, (m) => ({
    kind: 'point',
    x: parseInt(m[1], 10),
    y: parseInt(m[2], 10),
    label: (m[3] ?? '').trim(),
    screen: m[4] ? parseInt(m[4], 10) : 0,
  }));
  scan(BOX_EL_TAG_REGEX, (m) => ({ kind: 'box-el', id: m[1], label: m[2].trim() }));
  scan(BOX_PX_TAG_REGEX, (m) => ({
    kind: 'box',
    x: parseInt(m[1], 10),
    y: parseInt(m[2], 10),
    w: parseInt(m[3], 10),
    h: parseInt(m[4], 10),
    label: (m[5] ?? '').trim(),
    screen: m[6] ? parseInt(m[6], 10) : 0,
  }));
  // Repair: "[BOX:x,y:label]" (no w,h) means a SPOT, not a region — deliver it
  // as a labeled point instead of silently dropping the pointer.
  scan(BOX_2INT_TAG_REGEX, (m) => ({
    kind: 'point',
    x: parseInt(m[1], 10),
    y: parseInt(m[2], 10),
    label: (m[3] ?? '').trim(),
    screen: m[4] ? parseInt(m[4], 10) : 0,
  }));
  scan(ARROW_TAG_REGEX, (m) => ({
    kind: 'arrow',
    x1: parseInt(m[1], 10),
    y1: parseInt(m[2], 10),
    x2: parseInt(m[3], 10),
    y2: parseInt(m[4], 10),
    label: (m[5] ?? '').trim(),
    screen: m[6] ? parseInt(m[6], 10) : 0,
  }));
  scan(POINT_JSON_REGEX, (m) => ({
    kind: 'point',
    x: parseInt(m[1], 10),
    y: parseInt(m[2], 10),
    label: (m[3] ?? '').trim(),
    screen: 0,
  }));
  scan(BOX_JSON_REGEX, (m) => ({
    kind: 'box',
    x: parseInt(m[1], 10),
    y: parseInt(m[2], 10),
    w: parseInt(m[3], 10),
    h: parseInt(m[4], 10),
    label: (m[5] ?? '').trim(),
    screen: 0,
  }));
  scan(ARROW_JSON_REGEX, (m) => ({
    kind: 'arrow',
    x1: parseInt(m[1], 10),
    y1: parseInt(m[2], 10),
    x2: parseInt(m[3], 10),
    y2: parseInt(m[4], 10),
    label: (m[5] ?? '').trim(),
    screen: 0,
  }));
  found.sort((a, b) => a.index - b.index);
  return found.map((f) => f.tag);
}

// Find tag-shaped tokens ([POINT/BOX/ARROW…:…]) that NOTHING could parse —
// the model's garbage tags that get stripped from the answer but never drawn.
// The caller logs them as WARNs so a silent "nothing appeared on screen" turn
// becomes diagnosable in the session log.
export function findUnparseableAnnotationTokens(text: string): string[] {
  const tokens: string[] = [];
  TAG_LEAK_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_LEAK_REGEX.exec(text)) !== null) {
    if (parseAnnotations(m[0]).length === 0) tokens.push(m[0]);
  }
  return tokens;
}

// Remove ALL annotation tags (POINT/BOX/ARROW) so they never reach the
// displayed answer, TTS, or session history. The strict per-kind regexes get
// the well-formed ones first; TAG_LEAK_REGEX then removes ANY leftover tag-
// shaped token a model may have written malformed (label-first arrows,
// symbols between numbers, truncated pairs) — unparseable ≠ displayable.
export function stripAnnotations(text: string): string {
  return text
    .replace(POINT_STRIP_REGEX, '')
    .replace(BOX_EL_TAG_REGEX, '')
    .replace(BOX_PX_TAG_REGEX, '')
    .replace(ARROW_TAG_REGEX, '')
    .replace(TAG_LEAK_REGEX, '')
    .replace(ANNOTATION_JSON_STRIP_REGEX, '');
}

// Remove only POINT tags (kept for back-compat / tests).
export function stripPoints(text: string): string {
  return text.replace(POINT_STRIP_REGEX, '');
}

// Streaming-safe mask for the LIVE answer text. stripAnnotations guards the
// final answer; this runs per-chunk so raw [POINT]/[BOX]/[ARROW] — complete OR
// still-streaming (a `[POINT:10,20:lab` with no closing bracket yet) — never
// flash in the user's view. The trailing-partial rule only masks the LAST
// unfinished opener on the chunk (the renderer REPLACES its live text each
// chunk, so earlier partials are already hidden).
export function maskAnnotationTags(text: string): string {
  return text
    .replace(POINT_STRIP_REGEX, '')
    .replace(BOX_EL_TAG_REGEX, '')
    .replace(BOX_PX_TAG_REGEX, '')
    .replace(ARROW_TAG_REGEX, '')
    .replace(TAG_LEAK_REGEX, '')
    .replace(/\[(POINT|BOX|ARROW)[^\]\n]*$/g, '')
    .replace(ANNOTATION_JSON_STRIP_REGEX, '')
    .replace(/\{\s*"(point|box|arrow)"\s*:\s*\[[^\]]*$/g, '');
}

// Stable identity for a parsed tag — used to dedupe streaming rescans.
export function annotationKey(t: AnnotationTag): string {
  switch (t.kind) {
    case 'point':
      return `point:${t.x},${t.y}:${t.label}:${t.screen}`;
    case 'box':
      return `box:${t.x},${t.y},${t.w},${t.h}:${t.label}:${t.screen}`;
    case 'box-el':
      return `box-el:${t.id}:${t.label}`;
    case 'arrow':
      return `arrow:${t.x1},${t.y1}:${t.x2},${t.y2}:${t.label}:${t.screen}`;
  }
}

// Incremental streaming scan over a growing body of text. Returns only the
// NEWLY-completed tags each call (mixed kinds, story order), never re-emits a
// tag it already returned. Tags are content-addressed so a half-streamed tag
// that closes later is handed over exactly once.
export function createAnnotationScanner(): { scan(chunk: string): AnnotationTag[] } {
  let buffer = '';
  const seen = new Set<string>();
  return {
    scan(chunk: string): AnnotationTag[] {
      buffer += chunk;
      const tags = parseAnnotations(buffer);
      const fresh: AnnotationTag[] = [];
      for (const t of tags) {
        const key = annotationKey(t);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(t);
      }
      return fresh;
    },
  };
}

// Incremental streaming scan: given the accumulated stream text and how many
// POINT tags were already consumed, return only the NEWLY-completed POINT
// tags plus the running count. Call once per received delta.
export function pointsSince(
  accumulated: string,
  knownCount: number,
): { points: PointTag[]; count: number } {
  const all = parsePoints(accumulated);
  return {
    points: all.length > knownCount ? all.slice(knownCount) : [],
    count: all.length,
  };
}

// Map an image-pixel tag into absolute screen DIP coordinates via the current
// screenshot geometry. Returns null when the geometry is unusable.
export function mapPointToScreen(
  tag: PointTag,
  geo: PointGeo,
): { x: number; y: number } | null {
  if (!usableGeo(geo)) return null;
  const r = geoRegion(geo);
  const s = regionCropScale(geo);
  const x = clampToDisplayStart(geo.absLeft, r.x + Math.max(0, tag.x) * s.sx, geo.imgW, geo.winW);
  const y = clampToDisplayStart(geo.absTop, r.y + Math.max(0, tag.y) * s.sy, geo.imgH, geo.winH);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

// Map a pixel-space BOX tag (top-left + size) into absolute screen DIP space,
// scaling each axis by the same ratios mapPointToScreen uses.
export function mapBoxToScreen(
  tag: { x: number; y: number; w: number; h: number },
  geo: PointGeo,
): { x: number; y: number; w: number; h: number } | null {
  if (!usableGeo(geo) || tag.w <= 0 || tag.h <= 0) return null;
  const r = geoRegion(geo);
  const s = regionCropScale(geo);
  const x = clampToDisplayStart(geo.absLeft, r.x + Math.max(0, tag.x) * s.sx, geo.imgW, geo.winW);
  const y = clampToDisplayStart(geo.absTop, r.y + Math.max(0, tag.y) * s.sy, geo.imgH, geo.winH);
  const w = Math.max(1, Math.round(((tag.w * s.sx) / geo.imgW) * geo.winW));
  const h = Math.max(1, Math.round(((tag.h * s.sy) / geo.imgH) * geo.winH));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, w, h };
}

// Map a pixel-space ARROW tag (both endpoints) into screen DIP space.
export function mapArrowToScreen(
  tag: { x1: number; y1: number; x2: number; y2: number; screen: number },
  geo: PointGeo,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const a = mapPointToScreen({ x: tag.x1, y: tag.y1, label: '', screen: tag.screen }, geo);
  const b = mapPointToScreen({ x: tag.x2, y: tag.y2, label: '', screen: tag.screen }, geo);
  if (!a || !b) return null;
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

function usableGeo(geo: PointGeo): boolean {
  return geo.imgW > 0 && geo.imgH > 0 && geo.winW > 0 && geo.winH > 0;
}

// When the geometry describes a CROP of the canonical image, the crop's
// top-left in canonical-image pixels ({x,y} = offset added to every tag
// coordinate). Identity {0,0} for a full-display geometry.
export function geoRegion(geo: PointGeo): { x: number; y: number } {
  return geo.region ? { x: geo.region.x, y: geo.region.y } : { x: 0, y: 0 };
}

// Ratio converting a region tag's pixels into canonical display pixels (1.25
// for a 1512x810 model image that covered 1890x1012 physical crop). Identity
// when the crop was not resized or the geometry has no region/cropSize.
export function regionCropScale(geo: PointGeo): { sx: number; sy: number } {
  const r = geo.region;
  const c = geo.cropSize;
  if (!r || !c || r.w <= 0 || r.h <= 0 || c.w <= 0 || c.h <= 0) return { sx: 1, sy: 1 };
  return { sx: c.w / r.w, sy: c.h / r.h };
}

// The pixel bounds the model's tags actually live in: the crop's region for a
// cropped geometry, otherwise the full image. Bounds checks and the caption
// note must use these, never the canonical imgW/imgH (which are bigger).
export function geoImageSize(geo: PointGeo): { w: number; h: number } {
  return geo.region ? { w: geo.region.w, h: geo.region.h } : { w: geo.imgW, h: geo.imgH };
}

// A tag coordinate is safely inside the screenshot the model was shown. The
// model is told the image pixel bounds; coordinates beyond ~1.05× the image
// are almost always the screen-space (double-scaled) mistake — but those get
// RESCUED by isScreenSpaceEvidence/rescaleTagToImage BEFORE this guard runs,
// so anything still reaching here is unrescuable garbage. Dropping beats
// parking a chip off-screen or on the wrong element.
const IMAGE_OOB_TOLERANCE = 1.05;

export function isOutOfImageBounds(pt: { x: number; y: number }, geo: PointGeo): boolean {
  if (!usableGeo(geo)) return true;
  const { w: imgW, h: imgH } = geoImageSize(geo);
  return (
    pt.x < 0 ||
    pt.y < 0 ||
    pt.x > imgW * IMAGE_OOB_TOLERANCE ||
    pt.y > imgH * IMAGE_OOB_TOLERANCE
  );
}

export function isBoxOutOfImageBounds(
  tag: { x: number; y: number; w: number; h: number },
  geo: PointGeo,
): boolean {
  if (!usableGeo(geo)) return true;
  const { w: imgW, h: imgH } = geoImageSize(geo);
  return (
    tag.x < 0 ||
    tag.y < 0 ||
    tag.x + tag.w > imgW * IMAGE_OOB_TOLERANCE ||
    tag.y + tag.h > imgH * IMAGE_OOB_TOLERANCE
  );
}

// A BOX tag that covers ~all of the given frame is "boxed the whole screen" —
// nothing specific is pointed at, a giant frame renders instead of a real
// highlight, and it's useless for the answer. The weak model emits
// "[BOX:0,0,1456,819:CapCut main interface]" when it means "the whole app";
// that must never become a screen-filling box. Coverage is computed as the
// intersection of the box with the frame over the frame area, so slightly
// overhanging boxes still count.
export function coversNearlyWholeFrame(
  tag: { x: number; y: number; w: number; h: number },
  frameW: number,
  frameH: number,
): boolean {
  if (frameW <= 0 || frameH <= 0) return false;
  const kw = Math.min(tag.x + tag.w, frameW) - Math.max(tag.x, 0);
  const kh = Math.min(tag.y + tag.h, frameH) - Math.max(tag.y, 0);
  if (kw <= 0 || kh <= 0) return false;
  return (kw * kh) / (frameW * frameH) >= 0.92;
}

export function isArrowOutOfImageBounds(
  tag: { x1: number; y1: number; x2: number; y2: number },
  geo: PointGeo,
): boolean {
  return (
    isOutOfImageBounds({ x: tag.x1, y: tag.y1 }, geo) ||
    isOutOfImageBounds({ x: tag.x2, y: tag.y2 }, geo)
  );
}

// Map an image-pixel coordinate to DIP, never letting a negative pixel (or a
// sub-0px mismatch) escape to the left/top of the display the shot came from.
function clampToDisplayStart(
  absStart: number,
  px: number,
  imgSize: number,
  winSize: number,
): number {
  const raw = absStart + (Math.max(0, px) / imgSize) * winSize;
  return Math.max(absStart, Math.round(raw));
}

// Coordinate-space auto-heal (the 1.5x parser). The screenshot the model is
// shown is a DOWNSCALED copy of the real screen — e.g. a 1920x1080 screen
// becomes a 1280x720 image (long edge capped for vision-token cost). Models
// sometimes write annotation coordinates in the ORIGINAL screen's pixels
// instead of the image pixels they were told to use: every tag then lands
// ~1.5x low/right, and any tag whose numbers exceed the image bounds gets
// dropped by the OOB guard. Rather than trusting the model to do conversion
// math, we detect the wrong-space class from the tags themselves and rescale
// them here in code.

export type AnnotationSpace = 'image' | 'screen';

// Ratio between the source screen pixels and the screenshot image pixels:
// winW/imgW == winH/imgH when the downscale preserved the aspect. Returns 1
// when the image IS the full screen (no downscale), or the geometry can't be
// trusted (unusable, or x/y ratios disagree — not a straight downscale).
export function imageScale(geo: PointGeo): number {
  if (!usableGeo(geo) || geo.winW <= 0 || geo.winH <= 0 || geo.imgW <= 0 || geo.imgH <= 0) return 1;
  const sx = geo.winW / geo.imgW;
  const sy = geo.winH / geo.imgH;
  if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.02) return 1;
  return sx;
}

function fitsInWin(pt: { x: number; y: number }, geo: PointGeo): boolean {
  return pt.x >= 0 && pt.y >= 0 && pt.x <= geo.winW && pt.y <= geo.winH;
}

// The PHYSICAL pixel grid of the display = winW/winH (DIP) × agentUnitsPerDip
// (the scale factor). When the screenshot is a downscale of the PHYSICAL grid
// (DIP-win × sf both match img), a model can write tags in physical px even
// though it was told image px — coordinates that exceed BOTH the image and the
// DIP window, yet fit the physical grid exactly. Ratio: (win × sf)/img, 1 when
// the geometry carries no scale factor or the x/y ratios disagree. On macOS
// agentUnitsPerDip is 1 (DIP == physical) so this never fires there.
export function physicalImageScale(geo: PointGeo): number {
  if (!usableGeo(geo) || !geo.agentUnitsPerDip || geo.agentUnitsPerDip <= 1) return 1;
  const sx = (geo.winW * geo.agentUnitsPerDip) / geo.imgW;
  const sy = (geo.winH * geo.agentUnitsPerDip) / geo.imgH;
  if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.02) return 1;
  return sx;
}

function fitsInPhysical(pt: { x: number; y: number }, geo: PointGeo): boolean {
  const s = physicalImageScale(geo);
  if (s <= 1) return false;
  const sf = geo.agentUnitsPerDip ?? 1;
  const px = geo.winW * sf;
  const py = geo.winH * sf;
  return pt.x >= 0 && pt.y >= 0 && pt.x <= px && pt.y <= py;
}

// Fingerprint of the PHYSICAL-pixel tag class: numbers that fit the display's
// native physical grid but exceed BOTH the image the model was shown and the
// DIP window — the "past the window, still on the screen" signature (e.g. the
// observed `y=886` on an 819-tall image / 864-tall DIP window / 1080-tall
// physical grid). Unambiguous: no other coordinate space explains them. These
// are rescued per-tag (they would otherwise be OOB-dropped) and, when enough
// of a run carries them, flip the whole run's space.
export function isPhysicalSpaceEvidence(tag: AnnotationTag, geo: PointGeo): boolean {
  if (physicalImageScale(geo) <= 1) return false;
  switch (tag.kind) {
    case 'point':
      return (
        isOutOfImageBounds({ x: tag.x, y: tag.y }, geo) &&
        !fitsInWin({ x: tag.x, y: tag.y }, geo) &&
        fitsInPhysical({ x: tag.x, y: tag.y }, geo)
      );
    case 'box':
      return (
        isBoxOutOfImageBounds(tag, geo) &&
        !fitsInWin({ x: tag.x, y: tag.y }, geo) &&
        !fitsInWin({ x: tag.x + tag.w, y: tag.y + tag.h }, geo) &&
        fitsInPhysical({ x: tag.x, y: tag.y }, geo) &&
        fitsInPhysical({ x: tag.x + tag.w, y: tag.y + tag.h }, geo)
      );
    case 'arrow':
      return (
        (isOutOfImageBounds({ x: tag.x1, y: tag.y1 }, geo) &&
          !fitsInWin({ x: tag.x1, y: tag.y1 }, geo) &&
          fitsInPhysical({ x: tag.x1, y: tag.y1 }, geo)) ||
        (isOutOfImageBounds({ x: tag.x2, y: tag.y2 }, geo) &&
          !fitsInWin({ x: tag.x2, y: tag.y2 }, geo) &&
          fitsInPhysical({ x: tag.x2, y: tag.y2 }, geo))
      );
    case 'box-el':
      return false;
  }
}

// Decide whether a run's tags were written in PHYSICAL (native) pixels — the
// scale-factor double-scaled class, rarer and bigger than the DIP-window
// screen-space class. Same guard as screenSpaceConsensus: two independent
// evidence tags AND a clear majority.
export function physicalSpaceConsensus(evidenceCount: number, totalCount: number): boolean {
  return screenSpaceConsensus(evidenceCount, totalCount);
}

// Convert a tag written in physical px back into image pixels (divide by the
// physical/img ratio). box-el tags have no pixels — passed through.
export function rescalePhysicalTagToImage(tag: AnnotationTag, geo: PointGeo): AnnotationTag {
  const s = physicalImageScale(geo);
  if (s <= 1) return tag;
  switch (tag.kind) {
    case 'point':
      return { ...tag, x: Math.round(tag.x / s), y: Math.round(tag.y / s) };
    case 'box':
      return {
        ...tag,
        x: Math.round(tag.x / s),
        y: Math.round(tag.y / s),
        w: Math.round(tag.w / s),
        h: Math.round(tag.h / s),
      };
    case 'arrow':
      return {
        ...tag,
        x1: Math.round(tag.x1 / s),
        y1: Math.round(tag.y1 / s),
        x2: Math.round(tag.x2 / s),
        y2: Math.round(tag.y2 / s),
      };
    case 'box-el':
      return tag;
  }
}

// Fingerprint of the double-scaled (screen-pixel) tag class: the tag's
// numbers don't fit the image the model was shown, but they fit the real
// screen perfectly. Rescuing beats dropping — a genuinely off-screen tag is
// rare, while this exact class was the constant source of misplaced
// annotations.
export function isScreenSpaceEvidence(tag: AnnotationTag, geo: PointGeo): boolean {
  if (imageScale(geo) <= 1) return false;
  switch (tag.kind) {
    case 'point':
      return (
        isOutOfImageBounds({ x: tag.x, y: tag.y }, geo) &&
        fitsInWin({ x: tag.x, y: tag.y }, geo)
      );
    case 'box':
      return (
        isBoxOutOfImageBounds(tag, geo) &&
        fitsInWin({ x: tag.x, y: tag.y }, geo) &&
        fitsInWin({ x: tag.x + tag.w, y: tag.y + tag.h }, geo)
      );
    case 'arrow':
      return (
        (isOutOfImageBounds({ x: tag.x1, y: tag.y1 }, geo) &&
          fitsInWin({ x: tag.x1, y: tag.y1 }, geo)) ||
        (isOutOfImageBounds({ x: tag.x2, y: tag.y2 }, geo) &&
          fitsInWin({ x: tag.x2, y: tag.y2 }, geo))
      );
    case 'box-el':
      return false;
  }
}

// Decide whether a run's tags were written in SCREEN pixels (the double-scaled
// class). A single out-of-frame tag is usually a model GUESS that ran wide,
// not evidence of a wrong coordinate system — in the debug session ONE such
// box flipped the whole run's space and moved nine correct tags ~1.9x off.
// Require a real consensus: at least TWO independent screen-space tags AND a
// clear majority of the run's tags flagged. A lone Mode-B single-tag run is
// never auto-rescaled — it stays image-space, which is what the caption told
// the model.
export function screenSpaceConsensus(evidenceCount: number, totalCount: number): boolean {
  if (evidenceCount < 2) return false;
  if (totalCount <= 0) return false;
  return evidenceCount / totalCount >= 0.5;
}

// Convert a tag written in screen pixels back into image pixels (divide by
// the downscale ratio). box-el tags have no pixels — passed through.
export function rescaleTagToImage(tag: AnnotationTag, geo: PointGeo): AnnotationTag {
  const s = imageScale(geo);
  if (s <= 1) return tag;
  switch (tag.kind) {
    case 'point':
      return { ...tag, x: Math.round(tag.x / s), y: Math.round(tag.y / s) };
    case 'box':
      return {
        ...tag,
        x: Math.round(tag.x / s),
        y: Math.round(tag.y / s),
        w: Math.round(tag.w / s),
        h: Math.round(tag.h / s),
      };
    case 'arrow':
      return {
        ...tag,
        x1: Math.round(tag.x1 / s),
        y1: Math.round(tag.y1 / s),
        x2: Math.round(tag.x2 / s),
        y2: Math.round(tag.y2 / s),
      };
    case 'box-el':
      return tag;
  }
}

// Model-facing note for the submit screenshot: restates the image pixel
// bounds so the model writes annotation coordinates in IMAGE pixels. Kept
// terse, repetitive and free of the real screen's size — models anchor their
// spatial grid to the first number they read, so the source display's
// dimensions are never mentioned (that was the trigger for the double-scaled
// tag class). Coordinate math is the parser's job, not the model's.
export function annotationImageNote(geo: PointGeo | null): string {
  if (!geo || !usableGeo(geo)) return '';
  const { w: imgW, h: imgH } = geoImageSize(geo);
  return (
    `Screens (give annotation coordinates in IMAGE pixels):\n` +
    `  screen0: image is ${imgW}x${imgH} px (actual display ${geo.winW}x${geo.winH} at ${geo.absLeft},${geo.absTop})\n` +
    `Coordinates are pixels of THAT IMAGE: x from 0 to ${imgW}, y from 0 to ${imgH}. ` +
    `Estimate the numbers straight from the image — never multiply, divide, or convert them. ` +
    `A coordinate outside 0-${imgW} by 0-${imgH} is dropped.`
  );
}

// Current image geometry — the screenshot the model is referencing RIGHT NOW.
// Set on every submit (full-display shot) and whenever an agentic see_screen
// attaches a fresh image mid-task. Tags emitted against a given image are
// mapped with whatever geometry is current when the tag completes.
let currentGeo: PointGeo | null = null;

export function setCurrentPointGeo(geo: PointGeo | null): void {
  currentGeo = geo;
}

export function getCurrentPointGeo(): PointGeo | null {
  return currentGeo;
}

// Run baseline geometry — the grid the model was FIRST told this run (the
// submit screenshot). Models anchor their spatial estimates to the first pixel
// bounds they read (see annotationImageNote), so when an agentic see_screen
// swaps the live ruler mid-answer (submit full-screen 1456x819 → window crop
// 791x433) the model keeps writing numbers in the OLD grid. Those numbers no
// longer fit the NEW ruler and the OOB guard would drop them. fitGeoForTag
// rescues exactly that class: a tag that doesn't fit its snapshot grid but
// DOES fit the run baseline was written against the submit screenshot, so map
// it with the baseline geometry instead of dropping it. Nothing that was
// truly out-of-bounds against BOTH grids gets rescued — it stays dropped.
let launchGeo: PointGeo | null = null;

// Called at SUBMIT with the geo the model is about to be shown. Sets the run
// baseline (the anchor grid) AND the live ruler. Mid-run see_screen /
// drag-rect swaps keep calling setCurrentPointGeo (live only) so the baseline
// survives the whole answer.
export function beginAnnotationRuler(geo: PointGeo | null): void {
  launchGeo = geo;
  currentGeo = geo;
}

export function getLaunchPointGeo(): PointGeo | null {
  return launchGeo;
}

type AnyAnnotationTag =
  | { x: number; y: number }
  | { x: number; y: number; w: number; h: number }
  | { x1: number; y1: number; x2: number; y2: number };

// Pick the geometry a tag should be mapped with: its snapshot grid when the
// coordinates fit there, else the run-baseline grid when they fit THAT (the
// model anchored to the submit screenshot's size, not the newer see_screen
// crop), else null (genuinely unrescuable — the caller keeps today's behavior
// and the OOB guard drops it).
export function fitGeoForTag(
  tag: AnyAnnotationTag,
  snapshot: PointGeo | null,
  baseline: PointGeo | null,
): PointGeo | null {
  const fits = (g: PointGeo | null): boolean => {
    if (g === null || !usableGeo(g)) return false;
    if ('x1' in tag && 'y1' in tag) {
      return !isArrowOutOfImageBounds(tag as { x1: number; y1: number; x2: number; y2: number }, g);
    }
    if ('w' in tag && 'h' in tag) {
      return !isBoxOutOfImageBounds(tag as { x: number; y: number; w: number; h: number }, g);
    }
    return !isOutOfImageBounds(tag as { x: number; y: number }, g);
  };
  if (fits(snapshot)) return snapshot;
  if (baseline && baseline !== snapshot && fits(baseline)) return baseline;
  return null;
}