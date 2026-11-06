// Second-pass point refinement (zoom-refine) IO: crop + upscale a screenshot
// region, hand it to a vision provider with a strict single-coordinate prompt,
// and map the answer back into the screenshot's image pixels. The pure
// planning/parsing/mapping lives in zoom-refine.ts; this module is the only
// part that touches Electron's nativeImage and the provider chain.
//
// The coordinate contract: everything enters and leaves in the ANNOTATION
// image space (the pixels of the screenshot the answering model saw). The
// crop is extracted from that same exact image so a refined point can never
// drift onto content of a different screenshot.

import { nativeImage } from 'electron';
import type { Message } from './prompt';
import type { RequestRequirements } from './providers/types';
import { resolveProviderChain } from './providers/router';
import { runWithRoundRetries } from './providers/round-retry';
import { isCoolingDown } from './providers/circuit';
import {
  applyRefineResults,
  parseRefineReply,
  planRefineCrops,
  refineSpecForCenter,
  type RefineCropSpec,
  type RefineOptions,
  type RefineOutcome,
} from './zoom-refine';
import type { AnnotationTag } from './point';
import type { PointGeo } from './point';
import { regionCropScale } from './point';
import type { SceneElement } from '../capture/scene';
import {
  anchorSnap,
  fitGroupShift,
  imageGeomOf,
  nearSnap,
  nearestContentCenter,
  NEAR_RADIUS,
  shiftTag,
  targetPixel,
  type ResolvedGeom,
} from './annotation-resolver';
export type { ResolvedGeom } from './annotation-resolver';

// Refine runs SEQUENTIALLY, not in parallel. A parallel fan-out of 8 small
// vision calls got the provider chain rate-limited or hung on every real run
// (the "0/8 re-aimed" logs) — one slow crop stalled the whole batch. Each crop
// gets a generous per-call timeout and the whole pass has a wall-clock budget
// so refine can never drag a final answer into minutes. Crops that miss the
// budget are left untouched (their pass-1 estimate stands). The budget is kept
// tight now that anchor-snap deterministically glues the label-less UI tags
// before refine ever runs — the LLM only re-reads truly anchorless leftovers.
const REFINE_TIMEOUT_MS = 30000;
const REFINE_BUDGET_MS = 45000;
const REFINE_JPEG_QUALITY = 85;
// Cap for a NATIVE-resolution crop payload. Native crops already carry real
// detail; a longer edge just costs image tokens for no further gain.
const REFINE_NATIVE_MAX_EDGE = 768;

export const REFINE_SYSTEM_PROMPT =
  'You are a precise computer-vision pointer. A first model estimated a screen ' +
  'location and may be off by tens of pixels. You are shown a ZOOMED-UP crop ' +
  'around that estimate, in its own coordinate system.\n' +
  'Your ONLY job: measure the described target in the crop image.\n' +
  'For a POINT or arrow-head target, reply with the exact pixel CENTER as a ' +
  'single line of two integers, comma-separated — `x,y` measured in the crop ' +
  'image from its top-left corner (0,0 is the top-left pixel).\n' +
  'For a BOX target, reply with the exact bounding box as four integers — ' +
  '`x,y,w,h` (top-left corner, then width and height) measured in the crop ' +
  'image from its top-left corner. The box covers the WHOLE enclosed region, ' +
  'not a guess-size: measure where the region actually starts and ends.\n' +
  'No prose, no units, no prefix. Ignore visually similar neighbors: only the ' +
  'target that was named counts. If the target is not present in this crop, ' +
  'reply exactly `none`.';

// Crop a region out of a base64 JPEG/PNG image and JPEG-encode it, optionally
// up-/down-scaled to outW/outH. Returns null when the source can't be decoded
// or the region is empty (callers treat that as "refine unknown", not failure).
function cropRegionJpegB64(
  imageB64: string,
  x: number,
  y: number,
  w: number,
  h: number,
  outW?: number,
  outH?: number,
): string | null {
  try {
    const src = nativeImage.createFromBuffer(Buffer.from(imageB64, 'base64'));
    if (src.isEmpty()) return null;
    const region = src.crop({ x, y, width: w, height: h });
    if (region.isEmpty()) return null;
    const sized =
      outW && outH ? region.resize({ width: outW, height: outH }) : region;
    const jpeg = sized.toJPEG(REFINE_JPEG_QUALITY);
    if (!jpeg || jpeg.length === 0) return null;
    return jpeg.toString('base64');
  } catch {
    return null;
  }
}

// Extract and upscale one crop to a JPEG data payload the provider can see.
// Returns null when the source image can't be decoded or the region is empty
// (callers treat that as "refine unknown", not a failure).
export function cropToJpegB64(imageB64: string, spec: RefineCropSpec): string | null {
  return cropRegionJpegB64(
    imageB64,
    spec.crop.x,
    spec.crop.y,
    spec.crop.w,
    spec.crop.h,
    spec.outW,
    spec.outH,
  );
}

// Decoded size of a base64 JPEG/PNG screenshot, or null when undecodable.
function imageSizeOf(imageB64: string): { width: number; height: number } | null {
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(imageB64, 'base64'));
    if (img.isEmpty()) return null;
    return img.getSize();
  } catch {
    return null;
  }
}

// Build the provider payload from a NATIVE full-display copy of the same
// screen whose downscaled shot produced the specs (re-read the native pixels
// so small icons/bonds are real detail, not crossed-downscale mush). The
// spec's image-space crop rect is scaled into the
// native copy's pixel grid and either sent at native size (capped at
// REFINE_NATIVE_MAX_EDGE) or upsampled to the requested target when the
// screen is too small to have real pixels there. Returns the payload b64 and
// pxPerImage — the payload pixels per IMAGE pixel, the inverse of
// spec.scale but for the denser source. Null when the copies don't match
// (different screen/region → falling back to the downscaled shot is safer
// than refining against the wrong content).
function nativeCropPayload(
  nativeB64: string,
  spec: RefineCropSpec,
  imgW: number,
  imgH: number,
): { payloadB64: string; pxPerImage: number } | null {
  const nat = imageSizeOf(nativeB64);
  if (!nat || nat.width < 2 || nat.height < 2) return null;
  const sx = nat.width / imgW;
  const sy = nat.height / imgH;
  if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.02) return null;
  const nx = Math.round(spec.crop.x * sx);
  const ny = Math.round(spec.crop.y * sy);
  const nw = Math.max(1, Math.min(Math.round(spec.crop.w * sx), nat.width));
  const nh = Math.max(1, Math.min(Math.round(spec.crop.h * sy), nat.height));
  const longEdge = Math.max(nw, nh);
  if (longEdge >= Math.max(spec.outW, spec.outH)) {
    const k = Math.min(1, REFINE_NATIVE_MAX_EDGE / longEdge);
    const payloadW = Math.max(1, Math.round(nw * k));
    const payloadH = Math.max(1, Math.round(nh * k));
    const payloadB64 = cropRegionJpegB64(nativeB64, nx, ny, nw, nh, payloadW, payloadH);
    if (!payloadB64) return null;
    return { payloadB64, pxPerImage: payloadW / spec.crop.w };
  }
  const payloadB64 = cropRegionJpegB64(nativeB64, nx, ny, nw, nh, spec.outW, spec.outH);
  if (!payloadB64) return null;
  return { payloadB64, pxPerImage: spec.outW / spec.crop.w };
}

// Run the second-pass calls for a set of crops, one at a time (parallel
// fan-out throttled/hung the real runs; see above). Every crop resolves
// independently — success, miss, or timeout each settle to a result entry —
// and the whole pass stops once the wall-clock budget is spent, leaving the
// remaining crops at their pass-1 estimates. When nativeSource is a
// full-display native-resolution copy of the same screen, per-crop payloads
// are built from it (real pixels); otherwise the crops come from the
// downscaled screenshot itself.
export async function refineAnnotationCrops(
  imageB64: string,
  specs: RefineCropSpec[],
  nativeSource?: string | null,
  regionOffset?: { x: number; y: number; sx?: number; sy?: number },
  budgetMs: number = REFINE_BUDGET_MS,
): Promise<{ outcomes: RefineOutcome[]; provider: string; model: string }> {
  if (specs.length === 0) return { outcomes: [], provider: 'none', model: 'none' };
  const { chain } = resolveProviderChain();
  if (chain.length === 0) {
    console.warn('[refine] skipped: no provider chain resolvable');
    return { outcomes: [], provider: 'none', model: 'none' };
  }
  const req: RequestRequirements = {
    web: false,
    vision: true,
    allowTools: false,
    tier: 'fast',
  };
  // Prefer a vision lane that is not on an open circuit; fall back to a
  // cooling one rather than skipping the refine entirely (best-effort path).
  const usable =
    chain.find(({ provider }) => !isCoolingDown(provider.id) && provider.supports('vision', req)) ??
    chain.find(({ provider }) => provider.supports('vision', req));
  if (!usable) {
    console.warn('[refine] skipped: no vision-capable provider in chain');
    return { outcomes: [], provider: 'none', model: 'none' };
  }
  const { provider, apiKey } = usable;
  const imgSz = imageSizeOf(imageB64);
  const nativeReady = !!nativeSource && !!imgSz;
  // When the crop source is the CANONICAL full-display image and the tags live
  // in a window/rect REGION of it, sample the image at region + spec.crop. The
  // region offset moved the crop into canonical px; sx/sy un-resize a
  // downscaled region so the sampling lands on the real pixels. The spec
  // itself (and applyRefineResults) stays in the tag's own pixel space.
  const sampleSpec = (spec: RefineCropSpec): RefineCropSpec =>
    regionOffset
      ? {
          ...spec,
          crop: {
            x: spec.crop.x * (regionOffset.sx ?? 1) + regionOffset.x,
            y: spec.crop.y * (regionOffset.sy ?? 1) + regionOffset.y,
            w: spec.crop.w * (regionOffset.sx ?? 1),
            h: spec.crop.h * (regionOffset.sy ?? 1),
          },
        }
      : spec;

  const runOne = async (spec: RefineCropSpec): Promise<RefineOutcome> => {
    let cropB64: string | null = null;
    let pxPerImage: number | undefined;
    const sourceSpec = sampleSpec(spec);
    if (nativeReady) {
      const native = nativeCropPayload(nativeSource!, sourceSpec, imgSz!.width, imgSz!.height);
      if (native) {
        cropB64 = native.payloadB64;
        // native's per is out px per CANONICAL crop px; multiply up to the
        // tag's own space so applyRefineResults (which divides spec.crop.x
        // space) lands refined coordinates in the same pixels the tag used.
        pxPerImage = native.pxPerImage * (regionOffset?.sx ?? 1);
      }
    }
    if (!cropB64) {
      cropB64 = cropToJpegB64(imageB64, sourceSpec);
      pxPerImage = undefined;
    }
    if (!cropB64) {
      console.warn(`[refine] "${spec.label || 'target'}": no crop pixels (region ${JSON.stringify(spec.crop)})`);
      return { spec, result: null };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), REFINE_TIMEOUT_MS);
    try {
      const model = provider.pickModel(req);
      const label = spec.label || 'the target';
      const messages: Message[] = [
        { role: 'system', content: REFINE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `Target: "${label}". Find its exact pixel center in the crop and reply \`x,y\`.\n` +
                (spec.model === 'box'
                  ? 'The target is the enclosed region the crop is centered on; reply its bounding box as `x,y,w,h`.'
                  : spec.model === 'arrow-head'
                    ? 'Aim at the exact spot the arrow is pointing to.'
                    : ''),
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${cropB64}` },
            },
          ],
        },
      ];
      // Background path: 2 attempts max, same reason as chips — fail fast.
      const round = await runWithRoundRetries(provider.id, controller.signal, () =>
        provider.runRound(
          model,
          messages,
          apiKey,
          undefined,
          controller.signal,
          () => {},
        ),
        undefined,
        2,
      );
      const result = parseRefineReply(round.contentText);
      if (!result) {
        console.warn(
          `[refine] "${spec.label || 'target'}": unparsed reply: ${JSON.stringify(round.contentText.slice(0, 120))}`,
        );
      }
      return { spec, result, pxPerImage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[refine] "${spec.label || 'target'}": call failed: ${message}`);
      return { spec, result: null };
    } finally {
      clearTimeout(timer);
    }
  };

  const startedAt = Date.now();
  const outcomes: RefineOutcome[] = [];
  for (let i = 0; i < specs.length; i += 1) {
    if (Date.now() - startedAt > budgetMs) {
      console.warn(`[refine] budget (${budgetMs}ms) spent after ${i}/${specs.length} crops — keeping pass-1 estimates for the rest`);
      for (let rest = i; rest < specs.length; rest += 1) {
        outcomes.push({ spec: specs[rest], result: null });
      }
      break;
    }
    outcomes.push(await runOne(specs[i]));
  }
  return {
    outcomes,
    provider: provider.displayName,
    model: provider.pickModel(req),
  };
}

// Decide where a tag's round-2 crop should re-center, given the tag kind.
function altModelOf(t: AnnotationTag): RefineCropSpec['model'] {
  switch (t.kind) {
    case 'box':
      return 'box';
    case 'arrow':
      return 'arrow-head';
    default:
      return 'point';
  }
}

// One-shot wrapper used by the annotate finalize pass: milk the run's
// un-snapped small tags through the second-pass refine and return the tags
// with refined coordinates. Skips entirely when the current image geometry
// does not match the screenshot we have (a later see_screen run can swap the
// geometry mid-task — refining against the wrong image would be worse than
// not refining at all). nativeSource, when present, is a full-display native
// copy of the same screen the image maps onto — pass-2 crops come from it.
export async function zoomRefineRun(
  tags: AnnotationTag[],
  imageB64: string,
  geo: PointGeo,
  scene: SceneElement[] | null,
  opts: RefineOptions = {},
  nativeSource?: string | null,
): Promise<AnnotationTag[]> {
  const size = tags.length > 0 ? imageSizeOf(imageB64) : null;
  if (!size) return tags;
  // Tag space: the crop's own pixels for a region geometry, the full image
  // otherwise (bounds checks + applyRefineResults stay there).
  const tagW = geo.region ? geo.region.w : geo.imgW;
  const tagH = geo.region ? geo.region.h : geo.imgH;
  // The crop source is the CANONICAL full-display image (submit shot) whenever
  // its decoded dims match the canonical grid — then window/rect tags sample at
  // region + spec.crop. Otherwise the source must BE the tags' own image.
  const canonicalDims = size.width === geo.imgW && size.height === geo.imgH;
  if (!canonicalDims && !(size.width === tagW && size.height === tagH)) return tags;
  const rc = regionCropScale(geo);
  const regionOffset =
    canonicalDims && geo.region
      ? { x: geo.region.x, y: geo.region.y, sx: rc.sx, sy: rc.sy }
      : undefined;
  const specs = planRefineCrops(tags, tagW, tagH, scene, opts);
  if (specs.length === 0) return tags;
  const roundStarted = Date.now();
  const res = await refineAnnotationCrops(imageB64, specs, nativeSource, regionOffset);
  let { outcomes } = res;
  // Round-2 (multi-hypothesis): a crop that MISSED its target (explicit
  // `none` or an unparsed reply) is re-cropped at a nearby real-content
  // anchor and asked once more, still inside the pass budget. The amber
  // passed round-1 (`altCenters` aligned with the tags array) decides where.
  const altCenters = opts.altCenters;
  if (altCenters && outcomes.some((o) => o.result === null)) {
    const remaining = REFINE_BUDGET_MS - (Date.now() - roundStarted);
    const round2Specs: RefineCropSpec[] = [];
    for (const o of outcomes) {
      if (o.result !== null) continue;
      const alt = altCenters[o.spec.tagIndex];
      if (!alt) continue;
      const t = tags[o.spec.tagIndex];
      const spec = refineSpecForCenter(
        o.spec.tagIndex,
        alt.x,
        alt.y,
        o.spec.label,
        altModelOf(t),
        tagW,
        tagH,
        opts,
      );
      if (spec) {
        console.log(
          `[refine] "${o.spec.label || 'target'}": round-1 miss, re-aiming at content ${Math.round(alt.x)},${Math.round(alt.y)}`,
        );
        round2Specs.push(spec);
      }
    }
    if (round2Specs.length > 0) {
      const res2 = await refineAnnotationCrops(imageB64, round2Specs, nativeSource, regionOffset, Math.max(5000, remaining));
      // Round-2 outcomes override round-1 for the same tag index (a later
      // applyRefineResults entry wins) — even a round-2 miss/`none` beats
      // nothing: it keeps the tag on its round-1 estimate as before.
      outcomes = [...outcomes, ...res2.outcomes];
    }
  }
  const applied = applyRefineResults(tags, outcomes, tagW, tagH);
  const ok = outcomes.filter((o) => o.result !== null).length;
  console.log(
    `[annotate] zoom-refine: ${ok}/${specs.length} re-aimed (avg scale ${Math.round(
      specs.reduce((n, s) => n + s.scale, 0) / specs.length,
    )}x via ${res.provider}/${res.model}${regionOffset ? ', canonical source w/ region' : nativeSource ? ', native source' : ''})`,
  );
  return applied;
}

// Grounded Annotation Resolver — orchestration (see annotation-resolver.ts for
// the pure pieces). One group of tags (all born under the same screenshot
// geometry) passes through near-snap → zoom-refine → group calibration:
//  1. NEAR-SNAP: label-matched tags glue to their element's REAL frame when it
//     sits near the guess; far captions can never hijack a chip again.
//  2. ZOOM-REFINE: every tag that could NOT be glued (structures, rings, icons
//     — anchorless targets no a11y/OCR tree can serve) is re-read from a
//     zoomed, upscaled crop of the actual screenshot pixels and re-aimed with
//     a strict single-coordinate prompt. A missed crop is re-cropped once at
//     the nearest real content anchor. Slightly-OOB estimates (written just
//     past the image edge) are clamped and refined instead of being dropped —
//     recovery beats losing the tag. Refined results become `image-*` geoms.
//  3. GROUP CALIBRATION: every snap (w=1) and every refined tag (w=0.6) yields
//     a (hint -> true) pair; the provider's silent image-resize shift is
//     measured and applied to the still-unplaced tags, so a whole run with the
//     right SHAPE but wrong absolute spot lands exactly. Refined tags are
//     already individually precise and are never shifted again.
// The refine pass is opted into via opts.refine (the finalize path passes a
// budget-capped config so per-tag re-aiming can never drag an answer into
// minutes); without it this runs near-snap + calibration only.

export type CorrectResult = {
  // Tags in group order; those the group calibration shifted carry corrected
  // coordinates, the rest are unmodified. `resolved` is the authority.
  tags: AnnotationTag[];
  resolved: (ResolvedGeom | null)[];
  logs: string[];
};

export async function correctAnnotGroup(
  tags: AnnotationTag[],
  imageB64: string | null,
  geo: PointGeo | null,
  scene: SceneElement[] | null,
  opts: {
    refine?: RefineOptions;
    nativeSource?: string | null;
    /** Visual grounding: detect real frames for content the UIA/OCR scene can't
     *  describe (icons, molecules, charts) from the screenshot pixels. Called at
     *  most once per group when tags are still unresolved; results are merged
     *  into the anchor-snap pass as scene-space elements (same grid as UIA/OCR). */
    ground?: (imageB64: string, geo: PointGeo) => Promise<SceneElement[] | null>;
  } = {},
): Promise<CorrectResult> {
  const logs: string[] = [];
  const resolved = new Array<ResolvedGeom | null>(tags.length).fill(null);
  let snapCount = 0;

  // Pass 1 — NEAR-SNAP: glue a label-matched tag to its REAL scene/OCR element
  // frame whenever that frame sits near the guess. Far captions can never pull
  // a chip across the screen. Every snap (and every far name match) also yields
  // a (hint → true) calibration pair in the tag's image space.
  //
  // Group calibration (pass 3, below) is NOT dead: the annotation image here is
  // at the model's computed pre-resize, but that only equals what the provider
  // actually sees for Anthropic/Claude-class models (screenshot.ts resizedSize
  // reproduces their fixed algorithm). OpenRouter/other backends resize images
  // through their OWN heuristics, so a tag's raw coordinates still carry a
  // systematic whole-group shift relative to the real screen. A handful of glue
  // pairs measures that exact shift and applies it to every still-unplaced tag
  // — the "right shape, wrong absolute spot" fix. Un-glued tags therefore keep
  // their raw coords FIRST, then get corrected by the measured group offset.
  const pairs: Parameters<typeof fitGroupShift>[0] = [];
  const usedEls = new Set<string>();
  for (let i = 0; i < tags.length; i += 1) {
    const t = tags[i];
    if (t.kind === 'box-el') continue;
    const snap = nearSnap(t, scene, geo, usedEls);
    if (snap && snap.geom) {
      resolved[i] = snap.geom;
      snapCount += 1;
      pairs.push(snap.pair);
      continue;
    }
    if (snap && snap.pair) {
      pairs.push(snap.pair);
    }
    const g = imageGeomOf(t);
    if (g) resolved[i] = g;
  }

  // Pass 1.4 — VISUAL GROUNDING (opt-in via opts.ground). When any tag is
  // still unresolved in image space, ask the grounding provider (OmniParser
  // sidecar / GroundingDINO ONNX) to find REAL frames from the screenshot
  // pixels — icons, molecule structures and charts have no UIA label to glue
  // to. Called ONCE per group and merged into the effective scene below, so
  // anchor-snap (pass 1.5) gets another shot at a pixel-perfect frame before
  // the slow zoom-refine. Fully unavailable providers degrade to exactly the
  // pre-grounding behavior.
  let gndScene = scene;
  if (opts.ground && imageB64 && geo) {
    // Tags still in raw image space (icons/molecules the a11y tree can't
    // describe) are reason to ground. [BOX:el#] tags resolve OUTSIDE this
    // function (scene-cache) and must never force an inference.
    const stillImage = tags.some((t, i) => {
      if (t.kind === 'box-el') return false;
      const r = resolved[i];
      return !r || !r.kind.startsWith('screen');
    });
    if (stillImage) {
      try {
        const grounded = await opts.ground(imageB64, geo);
        if (grounded && grounded.length > 0) {
          gndScene = [...(scene ?? []), ...grounded];
          logs.push(`grounding: ${grounded.length} element(s) detected for unresolved tag(s)`);
        }
      } catch {
        /* grounding is best-effort; never fail annotation on it */
      }
    }
  }

  // Pass 1.5 — ANCHOR-SNAP (deterministic, instant): tags near-snap could not
  // glue (label-less, or a label whose element sits far away) snap to the
  // NEAREST scene frame when the guess is close enough. Real UIA/OCR bounds
  // are pixel-perfect and cost nothing — this is what makes the common UI
  // case finish in ms instead of minutes of LLM zoom-refine. A BOX whose
  // frame contains an element's center glues DOWN to that element's exact
  // bounds (kills the whole-toolbar box problem). Anchor-snapped tags join
  // the calibration pairs exactly like name snaps.
  const anchoredIdx = new Set<number>();
  for (let i = 0; i < tags.length; i += 1) {
    if (tags[i].kind === 'box-el') continue;
    const existing = resolved[i];
    if (existing && existing.kind.startsWith('screen')) continue;
    const anc = anchorSnap(tags[i], gndScene, geo);
    if (anc && anc.geom) {
      resolved[i] = anc.geom;
      snapCount += 1;
      pairs.push(anc.pair);
      anchoredIdx.add(i);
    }
  }

  // Pass 2 — ZOOM-REFINE (opt-in via opts.refine): re-read the leftover tags
  // that have NO scene anchor at all (structures, rings, icons the a11y/OCR
  // tree can't describe) from a zoomed, upscaled crop of the actual screenshot
  // pixels. Anchored tags are excluded — their frames are already exact. A
  // crop that misses is re-aimed once at the nearest real content (altCenters).
  // Every refined tag contributes a (hint → true) pair, w=0.6, to pass 3.
  // Refined tags are individually precise and are never shifted again.
  let working = tags;
  const refinedIdx = new Set<number>();
  if (opts.refine && imageB64 && geo) {
    const altCenters = tags.map((t) => nearestContentCenter(t, scene, geo));
    const refined = await zoomRefineRun(
      tags,
      imageB64,
      geo,
      scene,
      { ...opts.refine, altCenters, skipIndices: anchoredIdx },
      opts.nativeSource ?? null,
    );
    for (let i = 0; i < tags.length; i += 1) {
      const hint = targetPixel(tags[i]);
      const truthRaw = targetPixel(refined[i]);
      if (!hint || !truthRaw) continue;
      const changed = truthRaw.x !== hint.x || truthRaw.y !== hint.y;
      if (changed) {
        pairs.push({ hx: hint.x, hy: hint.y, tx: truthRaw.x, ty: truthRaw.y, w: 0.6 });
      }
      const g = imageGeomOf(refined[i]);
      if (g && changed) {
        resolved[i] = g;
        refinedIdx.add(i);
      }
    }
    working = refined;
  }

  // Pass 3 — GROUP CALIBRATION: fit the systematic shift from every measured
  // (hint → true) pair and move each tag that is still in RAW image space and
  // was NOT re-aimed by pass 2. Tags glued to real frames (screen-*) are
  // already exact; refined tags (image-* but precisely placed) are untouched.
  // Requiring >= 3 pairs stops a lone pair + an outlier from hijacking the
  // group; fitGroupShift caps the shift + scale (translation-only on
  // implausible scale) and prefers pure translation when scale explains more.
  const maxImg = geo ? Math.max(geo.imgW, geo.imgH) : 4000;
  if (pairs.length >= 3 && geo) {
    const affine = fitGroupShift(pairs, { maxSize: maxImg });
    if (affine) {
      let shiftedCount = 0;
      const shifted = working.map((t, i) => {
        const r = resolved[i];
        if (r && r.kind.startsWith('image') && !refinedIdx.has(i)) {
          shiftedCount += 1;
          return shiftTag(t, affine);
        }
        return t;
      });
      if (shiftedCount > 0) {
        for (let i = 0; i < tags.length; i += 1) {
          if (shifted[i] !== working[i]) {
            const g = imageGeomOf(shifted[i]);
            if (g) resolved[i] = g;
          }
        }
        logs.push(
          `calibration: ${pairs.length} pair(s) -> s=${affine.s.toFixed(3)} tx=${Math.round(affine.tx)} ty=${Math.round(affine.ty)}, applied to ${shiftedCount} still-image tag(s)`,
        );
        return { tags: shifted, resolved, logs };
      }
    }
  }

  logs.push(
    `resolve: ${snapCount} glued to real text (near <=${NEAR_RADIUS}px); ${tags.length - snapCount} kept/refined/calibrated (${refinedIdx.size} re-read from zoomed crops)`,
  );

  return { tags: working, resolved, logs };
}