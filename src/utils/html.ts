export interface ExtractedImage {
  url: string;
  alt: string;
}

const IMG_TAG_RE = /<img\s[^>]*>/gi;
const SRC_ATTR_RE = /src\s*=\s*["']([^"']+)["']/i;
const ALT_ATTR_RE = /alt\s*=\s*["']([^"']*?)["']/i;
const ADO_ATTACHMENT_RE = /_apis\/wit\/attachments\//;

/**
 * Extract image URLs from HTML that match Azure DevOps attachment pattern.
 * Returns at most `limit` images (default 5).
 */
export function extractImageUrls(
  html: string,
  limit = 5,
): ExtractedImage[] {
  const results: ExtractedImage[] = [];
  const imgTags = html.match(IMG_TAG_RE);
  if (!imgTags) return results;

  for (const tag of imgTags) {
    if (results.length >= limit) break;

    const srcMatch = tag.match(SRC_ATTR_RE);
    if (!srcMatch?.[1]) continue;

    const url = srcMatch[1];
    if (!ADO_ATTACHMENT_RE.test(url)) continue;

    const altMatch = tag.match(ALT_ATTR_RE);
    results.push({ url, alt: altMatch?.[1] ?? '' });
  }

  return results;
}

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

const ENTITY_RE = /&(?:amp|lt|gt|quot|#39|apos|nbsp);/g;
const NUMERIC_ENTITY_RE = /&#(\d+);/g;

/**
 * Strip HTML tags, convert block-level elements to newlines, decode entities.
 * Removes <img> tags entirely (images handled separately).
 */
export function stripHtmlToText(html: string): string {
  let text = html;

  // Remove img tags entirely
  text = text.replace(IMG_TAG_RE, '');

  // Convert block-level elements to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n');

  // Convert list items to bullets (before generic block-level tags)
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');

  // Generic opening block-level tags (excluding li, already handled)
  text = text.replace(/<(?:p|div|tr|h[1-6])\b[^>]*>/gi, '\n');

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = text.replace(ENTITY_RE, (entity) => ENTITY_MAP[entity] ?? entity);
  text = text.replace(NUMERIC_ENTITY_RE, (_, code) =>
    String.fromCharCode(Number(code)),
  );

  // Normalize whitespace: collapse multiple blank lines, trim
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}
