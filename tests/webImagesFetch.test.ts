import { describe, expect, it } from 'vitest';
import {
  extractDdgVqd,
  parseBingM,
  parseBingResults,
  parseDdgResults,
  parseOpenverseResults,
  parseWikimediaResults,
  setWebImagesSink,
  emitWebImages,
  MAX_IMAGES,
} from '../electron/llm/web-images';
import type { WebImage } from '../electron/types';

const DDG_FIXTURE = JSON.stringify({
  results: [
    {
      image: 'https://cdn.example.com/cow.jpg',
      thumbnail: 'https://cdn.example.com/cow-t.jpg',
      title: 'Angus cow on pasture',
      url: 'https://farm.example.com/article',
    },
    {
      image: 'https://img.example.com/two.png',
      thumbnail: 'https://img.example.com/two-t.png',
      title: ' <b>Holstein</b> cow ',
      url: 'https://dairy.example.com/holstein',
    },
    {
      // private-host image must be dropped by the URL filter
      image: 'http://192.168.1.5/private.jpg',
      thumbnail: 'http://192.168.1.5/private-t.jpg',
      title: 'private',
      url: 'https://page.example.com/private',
    },
    {
      image: 'https://cdn.example.com/four.jpg',
      title: 'No thumbnail',
    },
  ],
});

describe('extractDdgVqd', () => {
  it('1. finds an unquoted vqd token', () => {
    expect(extractDdgVqd('...&vqd=123456-789012&...')).toBe('123456-789012');
  });

  it('2. finds a quoted JS-assigned vqd token', () => {
    expect(extractDdgVqd("var vqd = '123456-789012';")).toBe('123456-789012');
  });

  it('3. returns null when missing', () => {
    expect(extractDdgVqd('<html><body>no token</body></html>')).toBeNull();
  });
});

describe('parseDdgResults', () => {
  it('1. parses the image list, cleans titles, drops private hosts', () => {
    const images = parseDdgResults(DDG_FIXTURE);
    expect(images).toHaveLength(3);
    expect(images[0]).toEqual({
      url: 'https://cdn.example.com/cow.jpg',
      thumb: 'https://cdn.example.com/cow-t.jpg',
      title: 'Angus cow on pasture',
      source: 'https://farm.example.com/article',
    });
    expect(images[1].title).toBe('Holstein cow');
    // no thumbnail → falls back to the image URL
    expect(images[2].thumb).toBe('https://cdn.example.com/four.jpg');
  });

  it('2. returns [] for junk JSON', () => {
    expect(parseDdgResults('not json at all')).toEqual([]);
    expect(parseDdgResults('{"results": "nope"}')).toEqual([]);
    expect(parseDdgResults('{}')).toEqual([]);
  });

  it('3. caps the list at MAX_IMAGES', () => {
    const many = JSON.stringify({
      results: Array.from({ length: 30 }, (_, i) => ({ image: `https://cdn.picturedomain.com/${i}.jpg` })),
    });
    expect(parseDdgResults(many)).toHaveLength(MAX_IMAGES);
  });
});

describe('parseBingM', () => {
  it('1. parses a Bing m-payload', () => {
    const img = parseBingM(
      '{"murl":"https://cdn.example.com/cow.jpg","turl":"https://thumb.example.com/t.jpg","t":"A cow","purl":"https://page.example.com/cow"}',
    );
    expect(img).toEqual({
      url: 'https://cdn.example.com/cow.jpg',
      thumb: 'https://thumb.example.com/t.jpg',
      title: 'A cow',
      source: 'https://page.example.com/cow',
    });
  });

  it('2. returns null for junk or a missing murl', () => {
    expect(parseBingM('not json')).toBeNull();
    expect(parseBingM('{"turl":"https://t.example/t.jpg","t":"no image"}')).toBeNull();
  });
});

describe('parseBingResults', () => {
  it('1. extracts m-payloads from search HTML', () => {
    const html =
      '<a class="iusc" m="{&quot;murl&quot;:&quot;https://cdn.example.com/a.jpg&quot;,&quot;turl&quot;:&quot;https://t.examplecdn.com/a.jpg&quot;,&quot;t&quot;:&quot;Alpha&quot;,&quot;purl&quot;:&quot;https://p.examplecdn.com/a&quot;}"></a>' +
      '<a class="iusc" m="{&quot;murl&quot;:&quot;https://cdn.example.com/b.jpg&quot;,&quot;purl&quot;:&quot;https://p.examplecdn.com/b&quot;}"></a>';
    const images = parseBingResults(html);
    expect(images).toHaveLength(2);
    expect(images[0].title).toBe('Alpha');
    expect(images[0].source).toBe('https://p.examplecdn.com/a');
    // missing thumb falls back to url; missing title empty
    expect(images[1].thumb).toBe('https://cdn.example.com/b.jpg');
    expect(images[1].title).toBe('');
  });

  it('2. returns [] when no results are present', () => {
    expect(parseBingResults('<html><body>no images</body></html>')).toEqual([]);
  });
});

const OPENVERSE_FIXTURE = JSON.stringify({
  results: [
    {
      title: 'Cow',
      url: 'https://live.staticflickr.com/8061/cow_b.jpg',
      thumbnail: 'https://api.openverse.org/v1/images/abc/thumb/',
      foreign_landing_url: 'https://www.flickr.com/photos/71861129@N00/8183766228',
    },
    {
      title: 'Holstein cow',
      url: 'https://live.staticflickr.com/3364/holstein_b.jpg',
      thumbnail: 'https://api.openverse.org/v1/images/def/thumb/',
      foreign_landing_url: 'https://www.flickr.com/photos/32558319@N03/3562536507',
    },
    {
      // private full-image URL must be dropped by the filter
      title: 'private',
      url: 'http://192.168.1.5/private.jpg',
      foreign_landing_url: 'https://p.example.com/private',
    },
    {
      title: 'No thumbnail',
      url: 'https://live.staticflickr.com/1/nothumb_b.jpg',
    },
  ],
});

describe('parseOpenverseResults', () => {
  it('1. maps url/thumbnail/title/foreign_landing_url and drops private URLs', () => {
    const images = parseOpenverseResults(OPENVERSE_FIXTURE);
    expect(images).toHaveLength(3);
    expect(images[0]).toEqual({
      url: 'https://live.staticflickr.com/8061/cow_b.jpg',
      thumb: 'https://api.openverse.org/v1/images/abc/thumb/',
      title: 'Cow',
      source: 'https://www.flickr.com/photos/71861129@N00/8183766228',
    });
    // missing thumbnail/landing URL fall back to the image URL
    expect(images[2].thumb).toBe('https://live.staticflickr.com/1/nothumb_b.jpg');
    expect(images[2].source).toBe('https://live.staticflickr.com/1/nothumb_b.jpg');
  });

  it('2. returns [] for junk / non-object bodies', () => {
    expect(parseOpenverseResults('not json')).toEqual([]);
    expect(parseOpenverseResults('{"result_count":0}')).toEqual([]);
  });
});

const WIKIMEDIA_FIXTURE = JSON.stringify({
  query: {
    pages: {
      '2588846': {
        title: 'File:CH cow 2.jpg',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/f/fb/CH_cow_2.jpg',
            thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fb/CH_cow_2.jpg/330px-CH_cow_2.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:CH_cow_2.jpg',
          },
        ],
      },
      '1234567': {
        title: 'File:Cow meadow.jpg',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/1/12/Cow_meadow.jpg',
            thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Cow_meadow.jpg/330px-Cow_meadow.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Cow_meadow.jpg',
          },
        ],
      },
    },
  },
});

describe('parseWikimediaResults', () => {
  it('1. maps url/thumburl/title (File: stripped)/descriptionurl', () => {
    const images = parseWikimediaResults(WIKIMEDIA_FIXTURE);
    expect(images).toHaveLength(2);
    // pageids are numeric keys, so Object.values iterates them in ascending
    // numeric order — find the CH cow entry rather than assuming index 0.
    const cow = images.find((im) => im.url.includes('CH_cow_2.jpg'))!;
    expect(cow).toEqual({
      url: 'https://upload.wikimedia.org/wikipedia/commons/f/fb/CH_cow_2.jpg',
      thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fb/CH_cow_2.jpg/330px-CH_cow_2.jpg',
      title: 'CH cow 2.jpg',
      source: 'https://commons.wikimedia.org/wiki/File:CH_cow_2.jpg',
    });
  });

  it('2. skips pages without imageinfo and tolerates junk', () => {
    const mixed = JSON.stringify({
      query: {
        pages: {
          '1': { title: 'File:no info.jpg' },
          '2': { title: 'File:ok.jpg', imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/a/b/ok.jpg' }] },
        },
      },
    });
    const images = parseWikimediaResults(mixed);
    expect(images).toHaveLength(1);
    expect(images[0].title).toBe('ok.jpg');
    expect(images[0].source).toBe('https://upload.wikimedia.org/wikipedia/commons/a/b/ok.jpg');
    expect(parseWikimediaResults('not json')).toEqual([]);
  });
});

describe('emitWebImages sink', () => {
  it('1. forwards non-empty results to the registered sink only', () => {
    const received: WebImage[][] = [];
    setWebImagesSink((images) => received.push(images));
    emitWebImages([]);
    emitWebImages([
      { url: 'https://a.example/1.jpg', thumb: 'https://a.example/1.jpg', title: 'One', source: 'https://a.example/1.jpg' },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0][0].title).toBe('One');
    setWebImagesSink(null);
    emitWebImages([
      { url: 'https://a.example/2.jpg', thumb: 'https://a.example/2.jpg', title: 'Two', source: 'https://a.example/2.jpg' },
    ]);
    expect(received).toHaveLength(1);
  });
});
