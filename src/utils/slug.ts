export function slugify(input: string, maxLen = 40): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length === 0) return 'wi';
  if (base.length <= maxLen) return base;
  return base.slice(0, maxLen).replace(/-+$/, '');
}
