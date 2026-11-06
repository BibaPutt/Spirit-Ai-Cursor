import { describe, expect, it } from 'vitest';
import { linkifyImageUrls } from '../renderer/components/Markdown';
import { stripAnnotationLabels } from '../renderer/components/QuestionWizard';

describe('stripAnnotationLabels', () => {
  it('collapses point/box/arrow tags to labels', () => {
    expect(stripAnnotationLabels('click [POINT:100,200:Buy] now')).toBe('click Buy now');
    expect(stripAnnotationLabels('[BOX:1,2,3,4:Cart] and [ARROW:1,2:3,4:here]')).toBe('Cart and here');
  });

  it('leaves plain text alone', () => {
    expect(stripAnnotationLabels('plain question?')).toBe('plain question?');
  });
});

describe('linkifyImageUrls', () => {
  it('converts standalone image URLs to markdown images', () => {
    expect(linkifyImageUrls('https://x.com/a.png')).toBe('![](https://x.com/a.png)');
    expect(linkifyImageUrls('see https://x.com/a.png here')).toBe('see https://x.com/a.png here');
  });

  it('leaves [IMAGE] lines and non-image urls alone', () => {
    expect(linkifyImageUrls('[IMAGE] a cat')).toBe('[IMAGE] a cat');
    expect(linkifyImageUrls('https://x.com/page')).toBe('https://x.com/page');
  });
});
