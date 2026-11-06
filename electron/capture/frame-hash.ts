// FNV-1a hash over the base64 frame string. Same pixels produce the same
// JPEG/PNG bytes, so this is a stable identity for a captured screen: the
// submit path uses it to skip recapture/OCR work when nothing changed, and
// the OCR pipeline uses it as a result-cache key. Pure node, no Electron —
// unit-testable. Full-string hash (not a sample): a false "unchanged" would
// silently show the model a stale screen.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function frameHash(s: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h.toString(36) + ':' + s.length.toString(36);
}
