// UTF-8 and byte arrays: what every module that works on a tiddler's raw bytes shares.

export const encoder = new TextEncoder();

export const decoder = new TextDecoder();

export function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
