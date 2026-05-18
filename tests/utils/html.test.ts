import { describe, it, expect } from 'bun:test';
import { extractImageUrls, stripHtmlToText } from '../../src/utils/html.ts';

describe('extractImageUrls', () => {
  it('extracts ADO attachment URLs from <img> tags', () => {
    const html = `<p>Bug<img src="https://dev.azure.com/org/_apis/wit/attachments/abc?download=true" alt="repro" /></p>`;
    const out = extractImageUrls(html);
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe(
      'https://dev.azure.com/org/_apis/wit/attachments/abc?download=true',
    );
    expect(out[0]?.alt).toBe('repro');
  });

  it('ignores <img> tags that are not ADO attachments', () => {
    const html = `<img src="https://example.com/logo.png" alt="logo" />`;
    expect(extractImageUrls(html)).toEqual([]);
  });

  it('returns empty array when no <img> tags present', () => {
    expect(extractImageUrls('<p>no images here</p>')).toEqual([]);
  });

  it('honors limit when more images than the limit are present', () => {
    const html = Array.from({ length: 10 })
      .map(
        (_, i) =>
          `<img src="https://dev.azure.com/org/_apis/wit/attachments/${i}" alt="img${i}" />`,
      )
      .join('');
    const out = extractImageUrls(html, 3);
    expect(out).toHaveLength(3);
  });

  it('produces empty alt when alt attribute is absent', () => {
    const html = `<img src="https://dev.azure.com/org/_apis/wit/attachments/x" />`;
    const out = extractImageUrls(html);
    expect(out).toHaveLength(1);
    expect(out[0]?.alt).toBe('');
  });
});

describe('stripHtmlToText', () => {
  it('strips simple tags and decodes basic entities', () => {
    const html = `<p>Hello &amp; <strong>world</strong></p>`;
    expect(stripHtmlToText(html)).toBe('Hello & world');
  });

  it('converts <br>, </p>, </div>, </li> to newlines', () => {
    const html = `<p>one</p><div>two</div><br>three<br/>four`;
    const out = stripHtmlToText(html);
    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).toContain('three');
    expect(out).toContain('four');
    expect(out.split('\n').length).toBeGreaterThanOrEqual(3);
  });

  it('removes <img> tags entirely', () => {
    const html = `Before <img src="x" alt="y" /> after`;
    expect(stripHtmlToText(html)).toBe('Before  after');
  });

  it('renders <li> as bullet lines', () => {
    const html = `<ul><li>one</li><li>two</li></ul>`;
    const out = stripHtmlToText(html);
    expect(out).toContain('- one');
    expect(out).toContain('- two');
  });

  it('collapses runs of blank lines to a maximum of one', () => {
    const html = `<p>a</p>\n\n\n\n<p>b</p>`;
    const out = stripHtmlToText(html);
    expect(out).not.toMatch(/\n{3,}/);
  });
});
