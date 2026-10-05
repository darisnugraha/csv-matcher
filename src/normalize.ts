export function normalizeMatchName(value: string): string {
  return value.normalize('NFKC').toLocaleUpperCase('id-ID').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').replace(/\s*-\s*/g, ' - ').replace(/[“”]/g, '"').trim()
}
