export const MAGIC = Buffer.from([0x4c, 0x30, 0x49, 0x44, 0x58, 0x00, 0x00, 0x01]);
export const FOOTER_LEN = 16;
export const FORMAT_VERSION = 2;
export const DEFAULT_BLOCK_SIZE = 128;
export const DEFAULT_GRANULE = 128;   // sparse-index stride, in POSITIONS (§12.8)

export const S = {
  boolTrue:   f => `bm:${f}:true`,
  exists:     f => `bm:${f}:exists`,
  keyword:    (f, v) => `bm:${f}:kw:${v}`,
  colValues:  f => `col:${f}:values`,
  colDocs:    f => `col:${f}:docs`,
  textValues: f => `txt:${f}:values`,
  trigrams:   f => `tri:${f}:postings`,
  geoBox:     f => `geo:${f}:bbox`,
};

/** Trigrams of a string, lowercased. Used for infix narrowing (Stage C). */
export function trigrams(s) {
  const t = String(s).toLowerCase();
  const out = new Set();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Literal runs of a wildcard pattern, for trigram narrowing. */
export function literalRuns(pattern) {
  return String(pattern).toLowerCase().split(/[*?]+/).filter(r => r.length >= 3);
}

export function wildcardToRegExp(pattern) {
  const body = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]');
  return new RegExp(`^${body}$`, 'i');
}
