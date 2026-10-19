// How a tiddler is stored, and how a save is read (design 1.2).
//
// Every tiddler is stored "flat": every field at the top level, compact JSON, "text" last, then the
// worker's revision, bag and recipe; customMetadata { revision, layout: "flat" }. The conflict guard
// (src/browser/conflict-guard.js) sends exactly that, without revision, bag or recipe (header
// X-Tiddler-Layout: flat): the worker parses only the fields before "text" and appends its own,
// working on the raw bytes, so the text itself (a whole plugin, an image...) is never decoded, parsed
// or re-encoded. Anything else, such as TiddlyWeb JSON (custom fields under "fields", the text
// anywhere) from a tab without the module, is parsed and turned into the flat layout first. Reading
// a stored object back uses the same layout: its fields come before "text", so usually only the
// start of the object is read.

import { concatBytes, decoder, encoder } from "./bytes.js";
import { revisionOf } from "./tiddlers.js";

export const FLAT_LAYOUT = "flat";

const TEXT_KEY = encoder.encode(',"text":');

// Where ',"text":' starts in a flat body. Inside a JSON string every quote is escaped, so this
// sequence can only be the "text" key itself.
function textKeyOffset(bytes) {
  for (let i = bytes.indexOf(TEXT_KEY[0]); i !== -1; i = bytes.indexOf(TEXT_KEY[0], i + 1)) {
    if (TEXT_KEY.every((byte, j) => bytes[i + j] === byte)) return i;
  }
  return -1;
}

// A save whose body isn't a tiddler: answered 400, nothing stored
export class BadSave extends Error {}

function isTiddlerObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.title === "string";
}

function parseJsonBody(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BadSave(`the body is not JSON (${e.message})`);
  }
}

// TiddlyWiki's field values are text, or lists of text (tags). An object can't be stored flat (a
// "text" key inside it would be taken for the tiddler's text), with one exception: a field called
// "fields" stays nested as { fields: value }, the way TiddlyWeb's layout has it, because a flat
// "fields" is where TiddlyWiki's loader looks for nested custom fields.
function isFieldValue(value) {
  return typeof value === "string" || (Array.isArray(value) && value.every(item => typeof item === "string"));
}

function isStorable(name, value) {
  if (name !== "fields") return isFieldValue(value);
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 &&
    Object.hasOwn(value, "fields") && typeof value.fields === "string";
}

// TiddlyWiki unpacks that nested "fields" when it loads a tiddler through sync, but not the tiddlers
// the page hands it at boot (preloadTiddlers): the page build unpacks those
export function hasNestedFields(tiddler) {
  return isStorable("fields", tiddler.fields);
}

const BOOKKEEPING = ["text", "revision", "bag", "recipe"];

// The fields before "text" of a body in the flat layout, or null if it isn't one
function flatFields(bytes, end) {
  if (bytes[0] !== 0x7b || bytes[end - 1] !== 0x7d) return null;
  let cut = textKeyOffset(bytes);
  if (cut === -1) cut = end - 1;   // no text: the fields run up to the closing brace
  else if (!textIsLast(bytes, cut + TEXT_KEY.length, end)) return null;
  if (cut <= 0) return null;
  let fields = null;
  try { fields = JSON.parse(decoder.decode(bytes.subarray(0, cut)) + "}"); } catch (e) { return null; }
  // Pretty-printed, with these before "text", or with a value that isn't text: not the flat layout after all
  if (!isTiddlerObject(fields) || BOOKKEEPING.some(name => Object.hasOwn(fields, name)) ||
      !Object.entries(fields).every(([name, value]) => isStorable(name, value))) return null;
  return fields;
}

// Whether the text, from its opening quote at start, is a string that ends the body (end - 1 is its
// closing brace), as the flat layout has it: it opens with a quote, and the body ends with one that
// isn't escaped. Up to FLAT_CHECK_BYTES, also that no other field follows: the first quote that isn't
// escaped (inside a JSON string, every quote is) must be that last one. A bigger body (a plugin) isn't
// scanned: it costs milliseconds of CPU a megabyte, and the conflict guard always puts the text last.
// Otherwise the body is read in full (toFlat).
const FLAT_CHECK_BYTES = 256 * 1024;

function textIsLast(bytes, start, end) {
  const close = end - 2;
  if (bytes[start] !== 0x22 || close <= start || bytes[close] !== 0x22) return false;
  const escaped = at => {
    let slashes = 0;
    while (bytes[at - 1 - slashes] === 0x5c) slashes++;
    return slashes % 2 === 1;
  };
  if (escaped(close)) return false;
  if (end > FLAT_CHECK_BYTES) return true;
  let i = bytes.indexOf(0x22, start + 1);
  while (i !== -1 && i < close && escaped(i)) i = bytes.indexOf(0x22, i + 1);
  return i === close;
}

// Any other tiddler JSON, TiddlyWeb's layout included, turned into the flat layout
function toFlat(tiddler) {
  // A title that isn't text would make the tiddler list unreadable (and no browser sends one)
  if (!isTiddlerObject(tiddler)) throw new BadSave("the body is not a tiddler (a JSON object with a text title)");
  let { fields: custom = {}, text, revision, bag, recipe, ...fields } = tiddler;
  if (text !== undefined && typeof text !== "string") throw new BadSave('the field "text" isn\'t text');
  // In TiddlyWeb's layout, "fields" holds the custom fields (text there is a field called "fields")
  if (custom === null) custom = {};
  else if (typeof custom !== "object") custom = { fields: custom };
  else if (Array.isArray(custom)) throw new BadSave('"fields" must hold the custom fields');
  for (const [name, value] of Object.entries(custom)) {
    if (!Object.hasOwn(fields, name) && !BOOKKEEPING.includes(name)) fields[name] = value;
  }
  if (Object.hasOwn(fields, "fields")) fields.fields = { fields: fields.fields };   // see isStorable
  const notText = Object.keys(fields).find(name => !isStorable(name, fields[name]));
  if (notText !== undefined) throw new BadSave(`the field "${notText}" isn't text`);
  return { fields, bytes: encoder.encode(JSON.stringify(text === undefined ? fields : { ...fields, text })) };
}

// Returns { fields, stored(revision) }: fields = the tiddler without its text, stored(revision) =
// the bytes to store, with the worker's revision, bag and recipe
export async function readSave(request) {
  let bytes = new Uint8Array(await request.arrayBuffer());
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] <= 0x20) end--;
  let fields = request.headers.get("X-Tiddler-Layout") === FLAT_LAYOUT ? flatFields(bytes, end) : null;
  if (!fields) {
    ({ fields, bytes } = toFlat(parseJsonBody(decoder.decode(bytes))));
    end = bytes.length;
  }
  return flatSave(fields, bytes.subarray(0, end));
}

// A save from its fields and its body in the flat layout (ending with "}")
function flatSave(fields, body) {
  return {
    fields,
    body,
    stored: revision => concatBytes([body.subarray(0, body.length - 1), storedSuffix(revision)])
  };
}

// What the worker appends to a stored tiddler, after its text
function storedSuffix(revision) {
  return encoder.encode(`,"revision":"${revision}","bag":"default","recipe":"default"}`);
}

// A tiddler TiddlyWiki has only the fields of (from the tiddler list; the text loads separately) is
// marked _is_skinny. Changed before its text arrives (a checkbox clicked during the first sync, say),
// it's saved without the text: the stored text is kept, as TiddlyWiki's own server does, rather than
// stored as nothing, and the mark isn't stored. A text sent with the mark was typed into the empty
// editor of such a tiddler (opened offline, say, limits 5: TiddlyWiki's draft copies the mark, and
// the editor starts empty): it's what was meant, and is stored as sent; only a save without a text,
// or with an empty one, keeps the stored text. current: the stored object, read with its body.
export async function keepStoredText(save, current) {
  const { _is_skinny, ...fields } = save.fields;
  const head = encoder.encode(JSON.stringify(fields));
  const at = textKeyOffset(save.body);
  const typed = at === -1 ? null : save.body.subarray(at, save.body.length - 1);   // ',"text":"..."' as sent
  if (typed && typed.length > TEXT_KEY.length + 2) {   // more than ,"text":""
    return flatSave(fields, concatBytes([head.subarray(0, head.length - 1), typed, encoder.encode("}")]));
  }
  let text = new Uint8Array(0);   // ',"text":"..."' of the stored tiddler
  if (current) {
    const stored = new Uint8Array(await current.arrayBuffer());
    const at = textKeyOffset(stored), suffix = storedSuffix(revisionOf(current));
    const tail = stored.subarray(stored.length - suffix.length);
    if (at !== -1 && suffix.every((byte, i) => tail[i] === byte)) {
      text = stored.subarray(at, stored.length - suffix.length);   // the stored layout: copied as bytes
    } else {
      // Stored by hand: read as JSON
      let value;
      try { value = JSON.parse(decoder.decode(stored)).text; } catch (e) {}
      if (typeof value === "string") text = encoder.encode(`,"text":${JSON.stringify(value)}`);
    }
  }
  return flatSave(fields, concatBytes([head.subarray(0, head.length - 1), text, encoder.encode("}")]));
}

// Whether the stored object holds exactly what this save would store with that revision
// (current: the object as head() returned it)
export async function storesSameContent(env, current, save, revision) {
  const wouldStore = save.stored(revision);
  // Different sizes, different content: no need to read it (a real conflict, nearly always)
  if (current.size !== wouldStore.length) return false;
  const obj = await env.WIKI_BUCKET.get(current.key);
  if (!obj) return false;
  const stored = new Uint8Array(await obj.arrayBuffer());
  if (stored.length !== wouldStore.length) return false;
  for (let i = 0; i < stored.length; i++) {
    if (stored[i] !== wouldStore[i]) return false;
  }
  return true;
}

const HEAD_BYTES = 16384;

// The fields of a stored tiddler (not its text), or null: only its beginning is read, unless the
// fields are longer. item: the object as listed or looked up (key, size)
export async function storedFields(env, item) {
  if (item.customMetadata?.layout !== FLAT_LAYOUT) return null;
  const read = await readStoredFields(env, item);
  const fields = read && read.fields;
  return fields !== null && typeof fields === "object" && !Array.isArray(fields) ? fields : null;
}

// { fields (null if they can't be read), obj }, or null if it's gone
export async function readStoredFields(env, item) {
  const partial = item.size > HEAD_BYTES;
  let obj = await env.WIKI_BUCKET.get(item.key, partial ? { range: { offset: 0, length: HEAD_BYTES } } : undefined);
  if (!obj) return null;   // deleted meanwhile
  let bytes = new Uint8Array(await obj.arrayBuffer());
  let cut = textKeyOffset(bytes);
  if (partial && cut === -1) {   // fields over HEAD_BYTES, or no text: read whole
    obj = await env.WIKI_BUCKET.get(item.key);
    if (!obj) return null;
    bytes = new Uint8Array(await obj.arrayBuffer());
    cut = textKeyOffset(bytes);
  }
  let fields = null;
  try { fields = JSON.parse(cut === -1 ? decoder.decode(bytes) : decoder.decode(bytes.subarray(0, cut)) + "}"); } catch (e) {}
  if (fields && typeof fields === "object") delete fields.text;
  return { fields, obj };
}
