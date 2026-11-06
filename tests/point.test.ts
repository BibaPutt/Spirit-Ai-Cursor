import { describe, expect, it } from 'vitest';
import {
  annotationImageNote,
  annotationKey,
  beginAnnotationRuler,
  coversNearlyWholeFrame,
  createAnnotationScanner,
  findUnparseableAnnotationTokens,
  fitGeoForTag,
  getCurrentPointGeo,
  getLaunchPointGeo,
  imageScale,
  isBoxOutOfImageBounds,
  isOutOfImageBounds,
  isPhysicalSpaceEvidence,
  isScreenSpaceEvidence,
  mapArrowToScreen,
  mapBoxToScreen,
  mapPointToScreen,
  maskAnnotationTags,
  parseAnnotations,
  parsePoints,
  physicalImageScale,
  physicalSpaceConsensus,
  pointsSince,
  regionCropScale,
  rescalePhysicalTagToImage,
  rescaleTagToImage,
  screenSpaceConsensus,
  setCurrentPointGeo,
  stripAnnotations,
  stripPoints,
  type PointGeo,
} from '../electron/llm/point';

const FULL_DISPLAY: PointGeo = {
  imgW: 1920,
  imgH: 1080,
  absLeft: 0,
  absTop: 0,
  winW: 1920,
  winH: 1080,
};

const SECONDARY_WINDOW: PointGeo = {
  imgW: 800,
  imgH: 600,
  absLeft: 2560,
  absTop: 120,
  winW: 800,
  winH: 600,
};

describe('parsePoints', () => {
  it('parses inline POINT tags with label + screen', () => {
    const text = 'click the banner [POINT:412,180:announcement banner:screen0] then fill the form.';
    const tags = parsePoints(text);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ x: 412, y: 180, label: 'announcement banner', screen: 0 });
  });

  it('parses multiple tags in story order', () => {
    const text =
      '[POINT:10,20:first:screen0] then [POINT:30,40:second thing:screen0] and [POINT:50,60:third:screen0]';
    const tags = parsePoints(text);
    expect(tags.map((t) => t.label)).toEqual(['first', 'second thing', 'third']);
    expect(tags[1].x).toBe(30);
  });

  it('ignores a half-streamed (unclosed) tag', () => {
    expect(parsePoints('open the [POINT:412,180:announ')).toHaveLength(0);
    expect(parsePoints('[POINT:412,180:')).toHaveLength(0);
  });

  it('does not match malformed or out-of-pixel tags', () => {
    expect(parsePoints('text [POINT:abc,def:label:screen0] text')).toHaveLength(0);
    // A label-less POINT is VALID now (the weak model emits them constantly and
    // a visible point beats a dropped one) — but a token with no digits at all
    // is garbage and still rejected.
    expect(parsePoints('text [POINT:10,20].x?')).toHaveLength(1);
    expect(parsePoints('text [POINT:abc,def] text')).toHaveLength(0);
  });
});

describe('pointsSince (incremental streaming scan)', () => {
  it('returns the first tag once its final character closes it', () => {
    const grown = '[POINT:412,18';
    expect(pointsSince(grown, 0).count).toBe(0);
    expect(pointsSince(grown + '0:label:screen0]', 0).count).toBe(1);
  });

  it('returns only the delta beyond the known count', () => {
    const acc = '[POINT:10,20:one:screen0] and [POINT:30,40:two:screen0]';
    const first = pointsSince(acc, 0);
    expect(first.count).toBe(2);
    expect(first.points).toHaveLength(2);
    const second = pointsSince(acc, 1);
    expect(second.count).toBe(2);
    expect(second.points).toHaveLength(1);
    expect(second.points[0].label).toBe('two');
    const done = pointsSince(acc + ' tail', 2);
    expect(done.points).toHaveLength(0);
  });
});

describe('stripPoints', () => {
  it('removes tags but keeps the surrounding prose intact', () => {
    const text = 'See the red banner [POINT:412,180:red banner:screen0] above the form.';
    expect(stripPoints(text)).toBe('See the red banner  above the form.');
  });

  it('leaves non-tag text untouched', () => {
    const text = 'No point here — just prose. [POINT:10,20:x:screen0] is data.';
    expect(stripPoints(text)).not.toContain('[POINT:');
    expect(stripPoints(text)).toContain('No point here');
  });
});

describe('mapPointToScreen', () => {
  it('maps full-display image pixels onto the display (primary origin)', () => {
    // img == display size → 1:1.
    expect(mapPointToScreen({ x: 960, y: 540, label: '', screen: 0 }, FULL_DISPLAY)).toEqual({
      x: 960,
      y: 540,
    });
  });

  it('scales a downscaled screenshot still to full display space', () => {
    const downscaled: PointGeo = { ...FULL_DISPLAY, imgW: 1280, imgH: 720 };
    expect(mapPointToScreen({ x: 640, y: 360, label: '', screen: 0 }, downscaled)).toEqual({
      x: 960,
      y: 540,
    });
  });

  it('off-sets into window space for a see_screen shot', () => {
    // 800x600 window at (2560,120); middle of the image = middle of the window.
    expect(mapPointToScreen({ x: 400, y: 300, label: '', screen: 0 }, SECONDARY_WINDOW)).toEqual({
      x: 2560 + 400,
      y: 120 + 300,
    });
  });

  it('handles a window taller than its image (letterbox strip offset)', () => {
    const geo: PointGeo = { ...SECONDARY_WINDOW, imgH: 400, imgW: 400 };
    expect(mapPointToScreen({ x: 200, y: 200, label: '', screen: 0 }, geo)).toEqual({
      x: 2560 + 400,
      y: 120 + 300,
    });
  });

  it('returns null for unusable geometry', () => {
    const zero: PointGeo = { imgW: 0, imgH: 0, absLeft: 0, absTop: 0, winW: 0, winH: 0 };
    expect(mapPointToScreen({ x: 0, y: 0, label: '', screen: 0 }, zero)).toBeNull();
    const bad: PointGeo = { ...FULL_DISPLAY, imgW: -5 };
    expect(mapPointToScreen({ x: 0, y: 0, label: '', screen: 0 }, bad)).toBeNull();
  });
});

describe('region geometry (window / drag-rect crops)', () => {
  // A user-dragged rect: 800x600 crop starting at screen (100,200) on a 1920x1080
  // display rooted at the origin. The canonical geometry still describes the
  // FULL display; `region` says where the crop sits inside it.
  const RECT_CROP: PointGeo = {
    imgW: 1920,
    imgH: 1080,
    absLeft: 0,
    absTop: 0,
    winW: 1920,
    winH: 1080,
    region: { x: 100, y: 200, w: 800, h: 600 },
  };

  it('maps crop pixels to screen by adding the region offset (primary origin)', () => {
    // Middle of the crop == middle of the rect on screen.
    expect(mapPointToScreen({ x: 400, y: 300, label: '', screen: 0 }, RECT_CROP)).toEqual({
      x: 100 + 400,
      y: 200 + 300,
    });
    // Crop corner (0,0) is the rect's top-left, not the display's.
    expect(mapPointToScreen({ x: 0, y: 0, label: '', screen: 0 }, RECT_CROP)).toEqual({
      x: 100,
      y: 200,
    });
  });

  it('maps crop pixels onto a NON-primary display via display origin + region', () => {
    // Display at (2560,0); rect spans screen (2620,40)→(3420,640) so the crop's
    // top-left sits at region (60,40) inside the display's canonical image.
    const RECT_CROP_SECONDARY: PointGeo = {
      imgW: 1280,
      imgH: 1024,
      absLeft: 2560,
      absTop: 0,
      winW: 1280,
      winH: 1024,
      region: { x: 60, y: 40, w: 800, h: 600 },
    };
    expect(
      mapPointToScreen({ x: 400, y: 300, label: '', screen: 0 }, RECT_CROP_SECONDARY),
    ).toEqual({ x: 2560 + 60 + 400, y: 40 + 300 });
  });

  it('maps boxes and arrows with the same region offset, sizes unscaled', () => {
    expect(mapBoxToScreen({ x: 100, y: 100, w: 80, h: 60 }, RECT_CROP)).toEqual({
      x: 100 + 100,
      y: 200 + 100,
      w: 80,
      h: 60,
    });
    expect(
      mapArrowToScreen({ x1: 0, y1: 0, x2: 50, y2: 50, label: '', screen: 0 }, RECT_CROP),
    ).toEqual({ x1: 100, y1: 200, x2: 150, y2: 250 });
  });

  it('bounds checks and the caption note use the CROP dimensions, not the canonical image', () => {
    // Well inside the 800x600 crop.
    expect(isOutOfImageBounds({ x: 790, y: 590 }, RECT_CROP)).toBe(false);
    // Past the crop's right edge (but would fit a 1920-wide image).
    expect(isOutOfImageBounds({ x: 881, y: 0 }, RECT_CROP)).toBe(true);
    expect(isBoxOutOfImageBounds({ x: 880, y: 0, w: 10, h: 10 }, RECT_CROP)).toBe(true);
    // The model is told the image is the 800x600 crop.
    expect(annotationImageNote(RECT_CROP)).toContain('800x600 px');
  });

  it('keeps the classic window geo behavior when no region is present', () => {
    expect(mapPointToScreen({ x: 400, y: 300, label: '', screen: 0 }, SECONDARY_WINDOW)).toEqual(
      { x: 2560 + 400, y: 120 + 300 },
    );
  });
});

describe('region geometry with a downscaled crop (cropSize)', () => {
  // User's bug repro: 125% display (img 1920x1080 phys / win 1536x864 DIP), a
  // window crop whose MODEL image was 1512x810 (resizeImageMaxEdge) but which
  // covered canonical physical 1890x1012 at offset (-9,-9). Pre-cropSize the
  // mapper treated the 1512-space pixels as canonical → 0.79x compression
  // toward the top-left (observed: box(140,180,200x100) → screen(105,137,160x80);
  // correct is 133,173,200x100).
  const WINDOW_CROP_RESIZED: PointGeo = {
    imgW: 1920,
    imgH: 1080,
    absLeft: 0,
    absTop: 0,
    winW: 1536,
    winH: 864,
    region: { x: -9, y: -9, w: 1512, h: 810 },
    cropSize: { w: 1890, h: 1012 },
  };

  it('un-resizes a scaled window crop before mapping (the top-left-corner bug)', () => {
    expect(mapBoxToScreen({ x: 140, y: 180, w: 200, h: 100 }, WINDOW_CROP_RESIZED)).toEqual({
      x: 133,
      y: 173,
      w: 200,
      h: 100,
    });
    expect(
      mapPointToScreen({ x: 140, y: 180, label: '', screen: 0 }, WINDOW_CROP_RESIZED),
    ).toEqual({ x: 133, y: 173 });
  });

  it('regionCropScale is identity without cropSize and ratios with it', () => {
    expect(regionCropScale({ ...WINDOW_CROP_RESIZED, cropSize: undefined })).toEqual({
      sx: 1,
      sy: 1,
    });
    expect(regionCropScale(WINDOW_CROP_RESIZED).sx).toBeCloseTo(1.25, 4);
    expect(regionCropScale(WINDOW_CROP_RESIZED).sy).toBeCloseTo(1012 / 810, 4);
    // A region whose model image WASN'T resized maps 1:1 even with cropSize.
    expect(
      regionCropScale({
        ...WINDOW_CROP_RESIZED,
        region: { x: -9, y: -9, w: 1890, h: 1012 },
      }),
    ).toEqual({ sx: 1, sy: 1 });
  });

  it('keeps OOB guards on the MODEL image dims, not the canonical crop', () => {
    // 1700 is inside the 1890-wide canonical crop but past the model's 1512x1.05
    // tolerance — if bounds used cropSize dims this wouldn't be out of bounds.
    expect(isOutOfImageBounds({ x: 1700, y: 700 }, WINDOW_CROP_RESIZED)).toBe(true);
    expect(isOutOfImageBounds({ x: 1500, y: 700 }, WINDOW_CROP_RESIZED)).toBe(false);
  });
});

describe('parseAnnotations', () => {
  it('parses a pixel BOX with label + screen', () => {
    const tags = parseAnnotations('the panel [BOX:120,340,300,60:login form:screen0] below');
    expect(tags).toEqual([
      { kind: 'box', x: 120, y: 340, w: 300, h: 60, label: 'login form', screen: 0 },
    ]);
  });

  it('parses an element-id BOX (el form)', () => {
    const tags = parseAnnotations('hit [BOX:el3:Save button] to continue');
    expect(tags).toEqual([{ kind: 'box-el', id: 'el3', label: 'Save button' }]);
  });

  it('parses POINT and el-BOX without cross-matching', () => {
    const tags = parseAnnotations('[POINT:10,20:dot:screen0] and [BOX:el123:n]');
    expect(tags).not.toContainEqual({ kind: 'box', x: 123 });
    expect(tags).toContainEqual({ kind: 'box-el', id: 'el123', label: 'n' });
  });

  it('parses an ARROW with both endpoints and optional label', () => {
    const withLabel = parseAnnotations('[ARROW:100,50:400,50:to the right:screen0]');
    expect(withLabel).toEqual([
      { kind: 'arrow', x1: 100, y1: 50, x2: 400, y2: 50, label: 'to the right', screen: 0 },
    ]);
    const noLabel = parseAnnotations('bond [ARROW:10,10:90,90::screen0] here');
    expect(noLabel[0]).toMatchObject({ kind: 'arrow', x2: 90, label: '' });
  });

  it('returns mixed kinds in story order', () => {
    const text =
      'first [POINT:10,20:dot:screen0], then [ARROW:100,50:400,50:goes to:screen0], box [BOX:120,340,300,60:form:screen0], el [BOX:el2:field]';
    expect(parseAnnotations(text).map((t) => t.kind)).toEqual([
      'point',
      'arrow',
      'box',
      'box-el',
    ]);
  });

  it('ignores half-streamed and malformed annotation tags', () => {
    expect(parseAnnotations('open [BOX:120,340,300,')).toHaveLength(0);
    expect(parseAnnotations('[BOX:abc,def:label:screen0]')).toHaveLength(0);
    expect(parseAnnotations('[ARROW:10,10:90:label:screen0]')).toHaveLength(0);
  });

  it('parses an ARROW with a stray arrow glyph between its endpoints', () => {
    // The model wrote the separator as a literal → mark ("228,360:→:398,330")
    // instead of the bare colon. Ac-cepted — one short non-digit gap.
    const tags = parseAnnotations(
      'the arrow [ARROW:228,360:→:398,330:new C–S bond forming:screen0] is the path',
    );
    expect(tags).toEqual([
      { kind: 'arrow', x1: 228, y1: 360, x2: 398, y2: 330, label: 'new C–S bond forming', screen: 0 },
    ]);
  });

  it('parses an ARROW with a dash (or empty) separator slot', () => {
    const dash = parseAnnotations('bond [ARROW:100,50:-:400,50:rel:screen0] here');
    expect(dash[0]).toMatchObject({ kind: 'arrow', x1: 100, y1: 50, x2: 400, y2: 50, label: 'rel' });
    const plain = parseAnnotations('bond [ARROW:100,50:400,50:rel:screen0] here');
    expect(plain[0]).toMatchObject({ kind: 'arrow', x1: 100, y1: 50, x2: 400, y2: 50, label: 'rel' });
  });

  it('parses JSON-object annotations (weak-model fallback form)', () => {
    const text =
      '1. **The Canvas Area** `{"point": [700, 500]}`: the workspace. ' +
      '2. **The Properties Panel** `{"box": [20, 840, 300, 980]}` here. ' +
      '3. path `{"arrow": [100, 50, 400, 50]}` flows.';
    const tags = parseAnnotations(text);
    expect(tags).toEqual([
      { kind: 'point', x: 700, y: 500, label: '', screen: 0 },
      { kind: 'box', x: 20, y: 840, w: 300, h: 980, label: '', screen: 0 },
      { kind: 'arrow', x1: 100, y1: 50, x2: 400, y2: 50, label: '', screen: 0 },
    ]);
  });

  it('parses JSON-object annotations carrying an explicit label key', () => {
    const tags = parseAnnotations(
      'hit {"point": [10, 20], "label": "Search field"} or {"box": [30, 40, 50, 60], "label": "Panel"}',
    );
    expect(tags).toEqual([
      { kind: 'point', x: 10, y: 20, label: 'Search field', screen: 0 },
      { kind: 'box', x: 30, y: 40, w: 50, h: 60, label: 'Panel', screen: 0 },
    ]);
  });

  it('blends bracket tags and JSON objects in story order', () => {
    const text =
      'a [POINT:10,20:dot:screen0], then {"box": [100, 100, 200, 200]}, then [ARROW:1,1:9,9:rel:screen0]';
    expect(parseAnnotations(text).map((t) => t.kind)).toEqual(['point', 'box', 'arrow']);
  });

  it('ignores malformed / half-streamed JSON annotations', () => {
    expect(parseAnnotations('{"point":}')).toHaveLength(0);
    expect(parseAnnotations('{"point": [700,')).toHaveLength(0);
    expect(parseAnnotations('{"point": [abc, 500]}')).toHaveLength(0);
    expect(parseAnnotations('{"color": [1, 2, 3]}')).toHaveLength(0);
  });
});

describe('createAnnotationScanner (incremental delta)', () => {
  it('emits a tag once, on the call that closes it', () => {
    const s = createAnnotationScanner();
    expect(s.scan('[BOX:120,34')).toHaveLength(0);
    expect(s.scan('0,300,60:form:screen0]')).toHaveLength(1);
    expect(s.scan(' trailing')).toHaveLength(0);
  });

  it('returns only new tags across mixed kinds and does not re-emit', () => {
    const s = createAnnotationScanner();
    const first = s.scan('[POINT:10,20:dot:screen0] and [BOX:el2:field] and [ARROW:1,1:9,9::screen0]');
    expect(first).toHaveLength(3);
    const again = s.scan('[POINT:10,20:dot:screen0] and [BOX:el2:field]');
    expect(again).toHaveLength(0);
    const later = s.scan(' now [BOX:10,10,20,20:new:screen0]');
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ kind: 'box', x: 10 });
  });

  it('emits a JSON-object tag exactly once, on the call that closes it', () => {
    const s = createAnnotationScanner();
    expect(s.scan('**The Canvas** `{"point": [700, 5')).toHaveLength(0);
    expect(s.scan('00]}`: workspace.')).toHaveLength(1);
    expect(s.scan(' more text')).toHaveLength(0);
    const more = s.scan(' and {"box": [1, 2, 3, 4]}');
    expect(more).toHaveLength(1);
    expect(more[0]).toMatchObject({ kind: 'box', x: 1, w: 3 });
  });
});

describe('stripAnnotations', () => {
  it('removes every annotation tag but keeps prose and strips points too', () => {
    const text =
      'Go [POINT:10,20:dot:screen0], box [BOX:120,340,300,60:form:screen0], el [BOX:el3:btn], arrow [ARROW:1,1:9,9:rel:screen0] done.';
    const clean = stripAnnotations(text);
    expect(clean).toContain('Go');
    expect(clean).toContain('done.');
    expect(clean).not.toContain('POINT:');
    expect(clean).not.toContain('BOX:');
    expect(clean).not.toContain('ARROW:');
  });

  it('removes JSON-object annotation blocks but keeps prose', () => {
    const text =
      '**The Canvas Area** `{"point": [700, 500]}`: workspace. ' +
      'pane `{"box": [20, 40, 120, 175], "label": "Layers"}` left. ' +
      'flow `{"arrow": [1, 1, 9, 9]}` ends.';
    const clean = stripAnnotations(text);
    expect(clean).not.toContain('point');
    expect(clean).not.toContain('box');
    expect(clean).not.toContain('arrow');
    expect(clean).not.toContain('Layers');
    expect(clean).toContain('**The Canvas Area**');
    expect(clean).toContain('workspace');
  });

  it('leaves other bracket-y prose intact', () => {
    const text = 'see [images] and the [UI] block plus [BOX:el3:btn].';
    const clean = stripAnnotations(text);
    expect(clean).toContain('[images]');
    expect(clean).toContain('[UI]');
  });

  it('strips MALFORMED tags (label-first arrows, symbols, missing pairs) — no leak', () => {
    // Every one of these survives the strict parsers; TAG_LEAK_REGEX exists so
    // none of them ever reaches the answer text, TTS or session history as raw
    // "[ARROW:…]" noise. These are the exact shapes seen in the debug session.
    const text =
      'Step one [ARROW:600,550:Proton removal] then [ARROW:label:screen0] mid [ARROW:228,360:→:398,330:new C–S bond forming:screen0] tail [POINT:10,20:lab] end.';
    const clean = stripAnnotations(text);
    expect(clean).not.toContain('ARROW:');
    expect(clean).not.toContain('POINT:');
    expect(clean).not.toContain('BOX:');
    expect(clean).not.toContain('→');
    expect(clean.replace(/\s+/g, ' ').trim()).toBe('Step one then mid tail end.');
  });
});

describe('tolerant labels (colons + optional screen suffix)', () => {
  it('parses POINT/BOX/ARROW labels that contain colons', () => {
    const text =
      '[POINT:412,180:direction:point to this:screen0] [BOX:120,340,300,60:label:login form:screen0] [ARROW:10,10:90,90:from search:to close:screen0]';
    const tags = parseAnnotations(text);
    expect(tags[0]).toMatchObject({ kind: 'point', label: 'direction:point to this' });
    expect(tags[1]).toMatchObject({ kind: 'box', label: 'label:login form' });
    expect(tags[2]).toMatchObject({ kind: 'arrow', label: 'from search:to close' });
  });

  it('accepts tags without the :screenN suffix (defaults to screen 0)', () => {
    expect(parsePoints('dot [POINT:10,20:just a dot]').map((t) => t.screen)).toEqual([0]);
    expect(parseAnnotations('box [BOX:120,340,300,60:form area]')[0]).toMatchObject({
      kind: 'box',
      screen: 0,
    });
    expect(parseAnnotations('arrow [ARROW:10,10:90,90:rel]')[0]).toMatchObject({
      kind: 'arrow',
      screen: 0,
    });
    expect(parseAnnotations('el [BOX:el3:Save button]')[0]).toMatchObject({
      kind: 'box-el',
      label: 'Save button',
    });
  });

  it('does not mistake a label ending in a digit for a screen id', () => {
    const tags = parsePoints('[POINT:10,20:step 2]');
    expect(tags[0].label).toBe('step 2');
    expect(tags[0].screen).toBe(0);
  });

  it('strips colon-labels and screen-less tags completely', () => {
    const text =
      'a [POINT:1,2:dir:spot] b [BOX:el3:close:button] c [ARROW:1,1:9,9:to:kept] d';
    const clean = stripAnnotations(text).replace(/\s+/g, ' ').trim();
    expect(clean).not.toContain('[POINT:');
    expect(clean).not.toContain('[BOX:');
    expect(clean).not.toContain('[ARROW:');
    expect(clean).toBe('a b c d');
  });
});

describe('maskAnnotationTags (live-stream leak)', () => {
  it('removes complete tags from streaming text', () => {
    const text =
      'See [POINT:10,20:dot:screen0] and [BOX:120,340,300,60:form:screen0] and [ARROW:1,1:9,9:rel] done.';
    const masked = maskAnnotationTags(text);
    expect(masked).toContain('See');
    expect(masked).toContain('done.');
    expect(masked).not.toContain('POINT:');
    expect(masked).not.toContain('BOX:');
    expect(masked).not.toContain('ARROW:');
  });

  it('hides a still-streaming (unclosed) tag at the end of a chunk', () => {
    expect(maskAnnotationTags('open the [POINT:412,180:announ')).toBe('open the ');
    expect(maskAnnotationTags('now [BOX:120,34')).toBe('now ');
    expect(maskAnnotationTags('[ARROW:10,10:')).toBe('');
  });

  it('keeps ordinary prose and non-annotation brackets intact', () => {
    const text = 'press [POINT] and count [BOX] here.';
    expect(maskAnnotationTags(text)).toBe(text);
  });

  it('masks malformed tags too, so they never flash in the live stream', () => {
    const text = 'see [ARROW:600,550:Proton removal] and [ARROW:label:screen0] talking';
    const masked = maskAnnotationTags(text);
    expect(masked).toBe('see  and  talking');
    expect(masked).not.toContain('ARROW:');
  });
});

describe('annotationKey', () => {
  it('is content-addressed per kind and stable', () => {
    expect(annotationKey({ kind: 'point', x: 1, y: 2, label: 'a', screen: 0 })).toBe(
      annotationKey({ kind: 'point', x: 1, y: 2, label: 'a', screen: 0 }),
    );
    expect(annotationKey({ kind: 'box', x: 1, y: 2, w: 3, h: 4, label: 'a', screen: 0 })).not.toBe(
      annotationKey({ kind: 'point', x: 1, y: 2, label: 'a', screen: 0 }),
    );
    expect(annotationKey({ kind: 'box-el', id: 'el3', label: 'a' })).toBe(
      annotationKey({ kind: 'box-el', id: 'el3', label: 'a' }),
    );
  });
});

describe('mapBoxToScreen', () => {
  it('maps a full-display image box 1:1 (primary origin)', () => {
    expect(mapBoxToScreen({ x: 100, y: 200, w: 300, h: 60 }, FULL_DISPLAY)).toEqual({
      x: 100,
      y: 200,
      w: 300,
      h: 60,
    });
  });

  it('scales box size with the same ratios as points', () => {
    const downscaled: PointGeo = { ...FULL_DISPLAY, imgW: 1280, imgH: 720 };
    const b = mapBoxToScreen({ x: 640, y: 360, w: 320, h: 120 }, downscaled);
    expect(b).toEqual({ x: 960, y: 540, w: 480, h: 180 });
  });

  it('offsets into window space for a see_screen shot', () => {
    expect(mapBoxToScreen({ x: 50, y: 50, w: 100, h: 100 }, SECONDARY_WINDOW)).toEqual({
      x: 2560 + 50,
      y: 120 + 50,
      w: 100,
      h: 100,
    });
  });

  it('rejects zero/negative sizes and unusable geometry', () => {
    expect(mapBoxToScreen({ x: 0, y: 0, w: 0, h: 10 }, FULL_DISPLAY)).toBeNull();
    expect(mapBoxToScreen({ x: 0, y: 0, w: 10, h: -4 }, FULL_DISPLAY)).toBeNull();
    const bad: PointGeo = { imgW: 0, imgH: 0, absLeft: 0, absTop: 0, winW: 0, winH: 0 };
    expect(mapBoxToScreen({ x: 1, y: 1, w: 1, h: 1 }, bad)).toBeNull();
  });
});

describe('mapArrowToScreen', () => {
  it('maps both endpoints into screen space', () => {
    expect(mapArrowToScreen({ x1: 100, y1: 50, x2: 400, y2: 50, screen: 0 }, FULL_DISPLAY)).toEqual(
      { x1: 100, y1: 50, x2: 400, y2: 50 },
    );
  });

  it('offsets into window space for a secondary shot', () => {
    const a = mapArrowToScreen({ x1: 0, y1: 0, x2: 800, y2: 600, screen: 0 }, SECONDARY_WINDOW);
    expect(a).toEqual({ x1: 2560, y1: 120, x2: 2560 + 800, y2: 120 + 600 });
  });

  it('returns null for unusable geometry', () => {
    const bad: PointGeo = { imgW: 0, imgH: 0, absLeft: 0, absTop: 0, winW: 0, winH: 0 };
    expect(mapArrowToScreen({ x1: 1, y1: 1, x2: 2, y2: 2, screen: 0 }, bad)).toBeNull();
  });
});

describe('current geometry store', () => {
  it('remembers the last attached geometry', () => {
    setCurrentPointGeo(SECONDARY_WINDOW);
    expect(getCurrentPointGeo()).toEqual(SECONDARY_WINDOW);
  });

  it('can be cleared (scoped crop turn)', () => {
    setCurrentPointGeo(SECONDARY_WINDOW);
    setCurrentPointGeo(null);
    expect(getCurrentPointGeo()).toBeNull();
  });
});

// A 1920x1080 screen captured as a 1280x720 image — the exact setup that used
// to make models emit screen-pixel (1.5x) annotation coordinates.
const DOWNSCALED: PointGeo = {
  imgW: 1280,
  imgH: 720,
  absLeft: 0,
  absTop: 0,
  winW: 1920,
  winH: 1080,
};

describe('imageScale (coordinate-space parser)', () => {
  it('returns 1 for an image that is the full screen (no downscale)', () => {
    expect(imageScale(FULL_DISPLAY)).toBe(1);
  });

  it('returns the 1.5 ratio for a 1080p screen shown as 1280x720', () => {
    expect(imageScale(DOWNSCALED)).toBeCloseTo(1.5, 10);
  });

  it('returns 1 when the downscale did not preserve aspect', () => {
    const stretched: PointGeo = { imgW: 1280, imgH: 640, absLeft: 0, absTop: 0, winW: 1920, winH: 1080 };
    expect(imageScale(stretched)).toBe(1);
    expect(imageScale({ imgW: 0, imgH: 0, absLeft: 0, absTop: 0, winW: 0, winH: 0 })).toBe(1);
  });
});

describe('isScreenSpaceEvidence (the 1.5x parser)', () => {
  it('flags a box whose numbers fit the real screen but not the image', () => {
    // The observed failure: box OOB over 1280x720 (bottom 712+128=840 > 756)
    // yet perfectly inside the 1920x1080 screen — written as screen pixels.
    const tag = { kind: 'box', x: 348, y: 712, w: 433, h: 128, label: 'Lewis Acid Catalyst', screen: 0 } as const;
    expect(isScreenSpaceEvidence(tag, DOWNSCALED)).toBe(true);
  });

  it('flags a point past the image bottom that still fits the screen', () => {
    const tag = { kind: 'point', x: 120, y: 780, label: 'x', screen: 0 } as const;
    expect(isOutOfImageBounds({ x: tag.x, y: tag.y }, DOWNSCALED)).toBe(true);
    expect(isScreenSpaceEvidence(tag, DOWNSCALED)).toBe(true);
  });

  it('does NOT flag in-image tags (normal image-pixel tags)', () => {
    const box = { kind: 'box', x: 227, y: 376, w: 145, h: 150, label: 'Sigma Complex', screen: 0 } as const;
    const point = { kind: 'point', x: 468, y: 388, label: 'a', screen: 0 } as const;
    expect(isScreenSpaceEvidence(box, DOWNSCALED)).toBe(false);
    expect(isScreenSpaceEvidence(point, DOWNSCALED)).toBe(false);
  });

  it('does NOT flag numbers beyond the real screen (unrescuable garbage)', () => {
    const oob = { kind: 'box', x: 2000, y: 500, w: 100, h: 100, label: 'x', screen: 0 } as const;
    expect(isScreenSpaceEvidence(oob, DOWNSCALED)).toBe(false);
  });

  it('never fires when the image was not downscaled', () => {
    const tag = { kind: 'box', x: 2000, y: 500, w: 100, h: 100, label: 'x', screen: 0 } as const;
    expect(isScreenSpaceEvidence(tag, FULL_DISPLAY)).toBe(false);
  });
});

describe('screenSpaceConsensus (auto-heal latch guard)', () => {
  it('requires TWO independent screen-space tags, not one', () => {
    // The debug-session failure: a single box that ran wide onto the screen
    // flipped the whole run and moved nine correct tags ~1.9x off. One tag
    // must never be enough.
    expect(screenSpaceConsensus(0, 9)).toBe(false);
    expect(screenSpaceConsensus(1, 9)).toBe(false);
  });

  it('stays image-space when flagged tags are a minority', () => {
    // 2/9 and 2/5 are a few wide guesses, not a wrong coordinate system.
    expect(screenSpaceConsensus(2, 9)).toBe(false);
    expect(screenSpaceConsensus(2, 5)).toBe(false);
  });

  it('latches when the majority of a run is clearly screen-space', () => {
    expect(screenSpaceConsensus(2, 2)).toBe(true);
    expect(screenSpaceConsensus(3, 4)).toBe(true);
    expect(screenSpaceConsensus(5, 9)).toBe(true);
  });

  it('never latches on an empty run', () => {
    expect(screenSpaceConsensus(0, 0)).toBe(false);
    expect(screenSpaceConsensus(2, 0)).toBe(false);
  });
});

describe('rescaleTagToImage (the 1.5x parser)', () => {
  it('divides screen-pixel coords back into image pixels', () => {
    const box = { kind: 'box', x: 300, y: 450, w: 600, h: 300, label: 'L', screen: 0 } as const;
    expect(rescaleTagToImage(box, DOWNSCALED)).toEqual({ kind: 'box', x: 200, y: 300, w: 400, h: 200, label: 'L', screen: 0 });
    expect(rescaleTagToImage({ kind: 'point', x: 300, y: 450, label: 'L', screen: 0 }, DOWNSCALED)).toEqual({
      kind: 'point',
      x: 200,
      y: 300,
      label: 'L',
      screen: 0,
    });
    expect(
      rescaleTagToImage({ kind: 'arrow', x1: 300, y1: 450, x2: 900, y2: 450, label: 'a', screen: 0 }, DOWNSCALED),
    ).toEqual({ kind: 'arrow', x1: 200, y1: 300, x2: 600, y2: 300, label: 'a', screen: 0 });
  });

  it('leaves box-el (frame-resolved) tags untouched', () => {
    const el = { kind: 'box-el', id: 'el12', label: 'L' } as const;
    expect(rescaleTagToImage(el, DOWNSCALED)).toEqual(el);
  });

  it('round-trips back to the exact screen numbers via the normal mapper', () => {
    const screen = { x: 300, y: 450, w: 600, h: 300 };
    const img = rescaleTagToImage({ ...screen, kind: 'box', label: 'L', screen: 0 }, DOWNSCALED);
    const back = mapBoxToScreen(img, DOWNSCALED);
    expect(back).toEqual(screen);
    // And the rescaled coordinates now pass the OOB guard that dropped them.
    expect(isBoxOutOfImageBounds(img, DOWNSCALED)).toBe(false);
  });

  it('rescue path: the observed dropped box now maps onto the screen', () => {
    const dropped = { kind: 'box', x: 348, y: 712, w: 433, h: 128, label: 'Lewis Acid Catalyst', screen: 0 } as const;
    const img = rescaleTagToImage(dropped, DOWNSCALED);
    const back = mapBoxToScreen(img, DOWNSCALED);
    expect(back).not.toBeNull();
    expect(back!.x).toBeGreaterThanOrEqual(348);
    expect(back!.x).toBeLessThanOrEqual(349);
    expect(back!.y).toBeGreaterThanOrEqual(712);
    expect(back!.y).toBeLessThanOrEqual(713);
  });
});

// A 1456x819 screenshot of a 1080p physical display at 1.25x DPI scaling —
// i.e. the DIP window is 1536x864 but the display is actually 1920x1080
// physical pixels. The screenshot is a downscale of the PHYSICAL grid, so a
// model that writes native pixels can emit tags that pass BOTH the image and
// the DIP window yet sit perfectly inside the physical grid (the observed
// `y=886` on an 819-tall image / 864-tall window / 1080-tall physical grid).
const PHYSICAL: PointGeo = {
  imgW: 1456,
  imgH: 819,
  absLeft: 0,
  absTop: 0,
  winW: 1536,
  winH: 864,
  agentUnitsPerDip: 1.25,
};

describe('physicalImageScale (the physical-pixel double-scale)', () => {
  it('returns (win × sf)/img when the x/y ratios agree', () => {
    // 1536×1.25 / 1456 = 1.3187 ; 864×1.25 / 819 = 1.3187
    expect(physicalImageScale(PHYSICAL)).toBeCloseTo(1920 / 1456, 10);
  });

  it('returns 1 without a scale factor or on macOS-style DIP==physical', () => {
    expect(physicalImageScale({ ...PHYSICAL, agentUnitsPerDip: undefined })).toBe(1);
    expect(physicalImageScale({ ...PHYSICAL, agentUnitsPerDip: 1 })).toBe(1);
    expect(physicalImageScale(FULL_DISPLAY)).toBe(1);
  });

  it('returns 1 when physical/aspect ratios disagree', () => {
    const stretched: PointGeo = { ...PHYSICAL, imgH: 640 };
    expect(physicalImageScale(stretched)).toBe(1);
  });
});

describe('isPhysicalSpaceEvidence (the y=886 class)', () => {
  it('flags a point past BOTH the image and the DIP window that fits the physical grid', () => {
    const tag = { kind: 'point', x: 554, y: 886, label: 'Broken Bond', screen: 0 } as const;
    expect(isOutOfImageBounds({ x: tag.x, y: tag.y }, PHYSICAL)).toBe(true);
    // NOT the old screen-space class (doesn't fit the 864-tall DIP window)…
    expect(isScreenSpaceEvidence(tag, PHYSICAL)).toBe(false);
    // …but it IS physical-space — the exact tag that used to be dropped.
    expect(isPhysicalSpaceEvidence(tag, PHYSICAL)).toBe(true);
  });

  it('flags the second independent OOB point of the failing run', () => {
    const tag = { kind: 'point', x: 841, y: 886, label: 'Substitution Product', screen: 0 } as const;
    expect(isPhysicalSpaceEvidence(tag, PHYSICAL)).toBe(true);
  });

  it('does NOT flag in-image or fit-the-win tags', () => {
    const inImg = { kind: 'box', x: 40, y: 477, w: 801, h: 200, label: 'cycloalkene', screen: 0 } as const;
    expect(isPhysicalSpaceEvidence(inImg, PHYSICAL)).toBe(false);
    // a screen-space (fits DIP window) tag must NOT be classed physical
    const scrWin = { kind: 'point', x: 100, y: 700, label: 'in dip window', screen: 0 } as const;
    expect(isPhysicalSpaceEvidence(scrWin, PHYSICAL)).toBe(false);
  });

  it('never fires without a real scale factor', () => {
    const tag = { kind: 'point', x: 554, y: 886, label: 'x', screen: 0 } as const;
    expect(isPhysicalSpaceEvidence(tag, { ...PHYSICAL, agentUnitsPerDip: 1 })).toBe(false);
  });

  it('flags a box whose whole bounds live past both grids yet inside physical', () => {
    const tag = { kind: 'box', x: 300, y: 920, w: 500, h: 140, label: 'sub', screen: 0 } as const;
    // y 920..1060 : past image (819) and DIP window (864), inside physical (1080)
    expect(isOutOfImageBounds({ x: 300, y: 920 }, PHYSICAL)).toBe(true);
    expect(isBoxOutOfImageBounds(tag, PHYSICAL)).toBe(true);
    expect(isPhysicalSpaceEvidence(tag, PHYSICAL)).toBe(true);
  });
});

describe('physicalSpaceConsensus', () => {
  it('uses the same two-tags-plus-majority latch as screen space', () => {
    expect(physicalSpaceConsensus(1, 5)).toBe(false);
    expect(physicalSpaceConsensus(2, 5)).toBe(false);
    expect(physicalSpaceConsensus(3, 4)).toBe(true);
    expect(physicalSpaceConsensus(0, 0)).toBe(false);
  });
});

describe('rescalePhysicalTagToImage (the physical-pixel parser)', () => {
  it('divides the observed y=886 back into image pixels and maps to the right DIP', () => {
    const tag = { kind: 'point', x: 554, y: 886, label: 'Broken Bond', screen: 0 } as const;
    const img = rescalePhysicalTagToImage(tag, PHYSICAL);
    // 554/1.3187 = 420 ; 886/1.3187 = 672 — inside the 1456x819 image now
    expect(img).toEqual({ kind: 'point', x: 420, y: 672, label: 'Broken Bond', screen: 0 });
    expect(isOutOfImageBounds({ x: img.x, y: img.y }, PHYSICAL)).toBe(false);
    // and maps to the physical point ÷ sf = the same DIP the user sees
    const dip = mapPointToScreen({ x: img.x, y: img.y, label: '', screen: 0 }, PHYSICAL);
    expect(dip!.x).toBeGreaterThanOrEqual(443);
    expect(dip!.x).toBeLessThanOrEqual(444);
    expect(dip!.y).toBeGreaterThanOrEqual(708);
    expect(dip!.y).toBeLessThanOrEqual(709);
  });

  it('rescales box top-left AND size by the same ratio (the size fix)', () => {
    const tag = { kind: 'box', x: 300, y: 920, w: 500, h: 140, label: 'sub', screen: 0 } as const;
    const img = rescalePhysicalTagToImage(tag, PHYSICAL);
    expect(img).toEqual({ kind: 'box', x: 228, y: 698, w: 379, h: 106, label: 'sub', screen: 0 });
    expect(isBoxOutOfImageBounds(img, PHYSICAL)).toBe(false);
  });

  it('rescales arrow endpoints and leaves box-el alone', () => {
    const arrow = { kind: 'arrow', x1: 554, y1: 886, x2: 841, y2: 886, label: 'a', screen: 0 } as const;
    expect(rescalePhysicalTagToImage(arrow, PHYSICAL)).toEqual({
      kind: 'arrow', x1: 420, y1: 672, x2: 638, y2: 672, label: 'a', screen: 0,
    });
    const el = { kind: 'box-el', id: 'el12', label: 'L' } as const;
    expect(rescalePhysicalTagToImage(el, PHYSICAL)).toEqual(el);
  });

  it('passes through when there is no physical scale', () => {
    const tag = { kind: 'point', x: 554, y: 886, label: 'x', screen: 0 } as const;
    expect(rescalePhysicalTagToImage(tag, { ...PHYSICAL, agentUnitsPerDip: 1 })).toEqual(tag);
  });
});

describe('wonky real-world forms (weak-model tolerance)', () => {
  it('parses spaced tags — every real-log failure shape (T3 234953 / T5 235452)', () => {
    const text =
      '[POINT: 32, 22: CapCut Logo] [BOX:25, 210, 1200, 600: Editing timeline] ' +
      '[ARROW:300, 620, 1500, 620: Pointer here]';
    const anns = parseAnnotations(text);
    expect(anns[0]).toEqual({ kind: 'point', x: 32, y: 22, label: 'CapCut Logo', screen: 0 });
    expect(anns[1]).toEqual({ kind: 'box', x: 25, y: 210, w: 1200, h: 600, label: 'Editing timeline', screen: 0 });
    expect(anns[2]).toEqual({ kind: 'arrow', x1: 300, y1: 620, x2: 1500, y2: 620, label: 'Pointer here', screen: 0 });
  });

  it('parses spaced POINT via parsePoints too (T1 231839)', () => {
    expect(parsePoints('[POINT: 36, 52: Text button]')).toEqual([
      { x: 36, y: 52, label: 'Text button', screen: 0 },
    ]);
  });

  it('coerces a 2-int BOX to a labeled POINT (T1 235452 Media Library)', () => {
    expect(parseAnnotations('[BOX:12,12:Media Library]')).toEqual([
      { kind: 'point', x: 12, y: 12, label: 'Media Library', screen: 0 },
    ]);
  });

  it('parses label-less tags with empty labels (T4/T5 234953, T6 231839)', () => {
    expect(parseAnnotations('[POINT:1000,760]')).toEqual([
      { kind: 'point', x: 1000, y: 760, label: '', screen: 0 },
    ]);
    expect(parseAnnotations('[BOX:50,100,200,150]')).toEqual([
      { kind: 'box', x: 50, y: 100, w: 200, h: 150, label: '', screen: 0 },
    ]);
  });

  it('parses ARROW with an arrow glyph separator and no label (T5 231839)', () => {
    expect(parseAnnotations('[ARROW:100,760→120,760]')).toEqual([
      { kind: 'arrow', x1: 100, y1: 760, x2: 120, y2: 760, label: '', screen: 0 },
    ]);
  });

  it('parses ARROW with a hyphen separator', () => {
    expect(parseAnnotations('[ARROW:10,20-30,40:gap]')).toEqual([
      { kind: 'arrow', x1: 10, y1: 20, x2: 30, y2: 40, label: 'gap', screen: 0 },
    ]);
  });

  it('still drops a one-pair ARROW (chemistry T1 231839) — unusable, counts as leaked', () => {
    const text = '[ARROW:350,330:Alkene bond]';
    expect(parseAnnotations(text)).toEqual([]);
    expect(findUnparseableAnnotationTokens(text)).toEqual(['[ARROW:350,330:Alkene bond]']);
  });

  it('findUnparseableAnnotationTokens only reports tokens nothing drew', () => {
    const text = '[POINT: 32, 22: CapCut Logo] [ARROW:350,330:Alkene bond] [BOX:12,12:Media]';
    expect(parseAnnotations(text).length).toBe(2);
    expect(findUnparseableAnnotationTokens(text)).toEqual(['[ARROW:350,330:Alkene bond]']);
  });

  it('a fully-spaced out tag still matches (spaces everywhere inside brackets)', () => {
    expect(parseAnnotations('[ POINT : 100 , 200 : hi ]').length).toBe(0);
    // Space right after "[POINT:" only — this is the shape the leaked-tag regex
    // catches, and since there are no digits it can't parse either.
    const leaky = '[POINT: abc,def ]';
    expect(findUnparseableAnnotationTokens(leaky)).toEqual(['[POINT: abc,def ]']);
  });
});

describe('coversNearlyWholeFrame (whole-screen box guard)', () => {
  it('rejects a box covering ~the whole frame', () => {
    expect(coversNearlyWholeFrame({ x: 0, y: 0, w: 1456, h: 819 }, 1456, 819)).toBe(true);
  });
  it('rejects a slightly overhanging whole-screen box', () => {
    expect(coversNearlyWholeFrame({ x: -5, y: -5, w: 1470, h: 830 }, 1456, 819)).toBe(true);
  });
  it('allows a real region box', () => {
    expect(coversNearlyWholeFrame({ x: 23, y: 48, w: 300, h: 120 }, 1456, 819)).toBe(false);
  });
  it('is false for empty or zero-size frames', () => {
    expect(coversNearlyWholeFrame({ x: 0, y: 0, w: 100, h: 100 }, 0, 0)).toBe(false);
  });
  it('an 85% box (real app window minus margins) is allowed', () => {
    expect(coversNearlyWholeFrame({ x: 20, y: 20, w: 1400, h: 780 }, 1456, 819)).toBe(false);
  });
});

describe('fitGeoForTag (see_screen grid-swap rescue)', () => {
  const SUBMIT_GRID: PointGeo = {
    imgW: 1456,
    imgH: 819,
    absLeft: 0,
    absTop: 0,
    winW: 1920,
    winH: 1080,
  };
  const WINDOW_CROP: PointGeo = {
    imgW: 1920,
    imgH: 1080,
    absLeft: 0,
    absTop: 0,
    winW: 1920,
    winH: 1080,
    region: { x: 695, y: 99, w: 791, h: 433 },
  };

  it('keeps the snapshot grid when the tag fits it (no rescue)', () => {
    const tag = { x: 168, y: 238 };
    expect(fitGeoForTag(tag, WINDOW_CROP, SUBMIT_GRID)).toBe(WINDOW_CROP);
  });

  it('rescues an out-of-bounds tag that fits the run baseline', () => {
    // The CapCut case: model anchored to the submit grid (1456x819), wrote
    // (599,571) — beyond the 791x433 window crop, but inside the submit grid.
    const tag = { x: 599, y: 571 };
    expect(fitGeoForTag(tag, WINDOW_CROP, SUBMIT_GRID)).toBe(SUBMIT_GRID);
  });

  it('drops a tag out of bounds against BOTH grids (unrescuable)', () => {
    const tag = { x: 5000, y: 9000 };
    expect(fitGeoForTag(tag, WINDOW_CROP, SUBMIT_GRID)).toBe(null);
  });

  it('the same rescue applies to boxes', () => {
    const box = { x: 1100, y: 200, w: 60, h: 40 };
    expect(fitGeoForTag(box, WINDOW_CROP, SUBMIT_GRID)).toBe(SUBMIT_GRID);
  });

  it('a box in-bounds of the snapshot grid stays on it', () => {
    const box = { x: 60, y: 60, w: 50, h: 30 };
    expect(fitGeoForTag(box, WINDOW_CROP, SUBMIT_GRID)).toBe(WINDOW_CROP);
  });

  it('the rescue applies to arrows (either endpoint over a grid is decisive)', () => {
    const arrow = { x1: 1200, y1: 203, x2: 1231, y2: 230 };
    expect(fitGeoForTag(arrow, WINDOW_CROP, SUBMIT_GRID)).toBe(SUBMIT_GRID);
  });

  it('a tag that fits the snapshot but would also fit the baseline stays on the snapshot grid', () => {
    // Both grids hold a small coordinate — mapping with the snapshot (the
    // ruler the model actually saw last) is correct, never the baseline.
    const tag = { x: 40, y: 40 };
    expect(fitGeoForTag(tag, WINDOW_CROP, SUBMIT_GRID)).toBe(WINDOW_CROP);
  });

  it('falls back to the baseline when there is no live grid at all', () => {
    const tag = { x: 168, y: 238 };
    expect(fitGeoForTag(tag, null, SUBMIT_GRID)).toBe(SUBMIT_GRID);
  });

  it('returns null when neither grid is usable', () => {
    expect(fitGeoForTag({ x: 5, y: 5 }, null, null)).toBe(null);
  });

  it('a null baseline never steals an in-bounds snapshot tag', () => {
    const tag = { x: 40, y: 40 };
    expect(fitGeoForTag(tag, WINDOW_CROP, null)).toBe(WINDOW_CROP);
  });
});

describe('beginAnnotationRuler (baseline vs live ruler)', () => {
  const SUBMIT: PointGeo = { imgW: 1456, imgH: 819, absLeft: 0, absTop: 0, winW: 1920, winH: 1080 };
  const FRESH: PointGeo = { imgW: 1920, imgH: 1080, absLeft: 0, absTop: 0, winW: 1920, winH: 1080, region: { x: 695, y: 99, w: 791, h: 433 } };

  it('begin resets both baseline and live; a mid-run swap keeps the baseline', () => {
    beginAnnotationRuler(SUBMIT);
    setCurrentPointGeo(FRESH);
    expect(getCurrentPointGeo()).toBe(FRESH);
    expect(getLaunchPointGeo()).toBe(SUBMIT);
  });

  it('a mid-run see_screen swap then a tribute tag rescues to the baseline', () => {
    beginAnnotationRuler(SUBMIT);
    setCurrentPointGeo(FRESH);
    expect(fitGeoForTag({ x: 599, y: 571 }, getCurrentPointGeo(), getLaunchPointGeo())).toBe(SUBMIT);
  });

  it('begin(null) clears both rulers', () => {
    beginAnnotationRuler(SUBMIT);
    beginAnnotationRuler(null);
    setCurrentPointGeo(FRESH);
    expect(getCurrentPointGeo()).toBe(FRESH);
    expect(getLaunchPointGeo()).toBe(null);
  });
});