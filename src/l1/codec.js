/** Inverse of the writer's encodeDoc: { $b64 } back to bytes. */
export function decodeDoc(doc) {
  let out = null;
  for (const [k, v] of Object.entries(doc)) {
    if (v && typeof v === 'object' && typeof v.$b64 === 'string') {
      out ??= { ...doc };
      out[k] = typeof Buffer !== 'undefined' ? Buffer.from(v.$b64, 'base64')
        : Uint8Array.from(atob(v.$b64), c => c.charCodeAt(0));
    }
  }
  return out ?? doc;
}
