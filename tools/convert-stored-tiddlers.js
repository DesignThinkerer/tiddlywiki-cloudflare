// One-time conversion, for a bucket filled by a worker older than the one that stores every
// tiddler flat (README 4.2 and 6). The current worker reads only that form, so run this ONCE,
// BEFORE deploying it, while the older worker is still in place (it must be one that already
// stores plugins as files: the script checks, and stops if it isn't):
//
//   1. Close any other admin tab, open the admin wiki, and wait until it has finished loading.
//      Don't edit anything until step 4.
//   2. Open the browser's console (F12), paste this whole file, press Enter.
//   3. Wait for the table: each stored tiddler is listed with what happened to it.
//   4. Deploy the new worker.js right away, then reload the admin wiki.
//
// It re-saves every tiddler in the tiddler list, through the worker, one at a time, exactly as it
// is stored (no field or value changes), in the flat layout. Each gets a new revision, and one
// commit in the GitHub backup. A tiddler changed meanwhile is refused, not overwritten: run it
// again. Running it twice does no harm. Delete this file once your bucket is converted.
(async () => {
  const host = $tw.syncer.syncadaptor.host;
  const list = await (await fetch(host + "recipes/default/tiddlers.json", { cache: "no-store" })).json();
  const results = [];
  for (const { title } of list) {
    const url = host + "recipes/default/tiddlers/" + encodeURIComponent(title);
    try {
      const stored = await fetch(url, { cache: "no-store" });
      if (!stored.ok) {
        results.push({ title, result: `not read (${stored.status})` });
        continue;
      }
      if (!/X-Tiddler-Layout/i.test(stored.headers.get("Access-Control-Allow-Headers") || "")) {
        console.error("This worker can't store the flat layout: deploy the version that stores plugins as files first, then run this.");
        return results;
      }
      // TiddlyWeb's layout keeps custom fields under "fields": moved to the top level, "text" last,
      // without the worker's revision, bag and recipe (it adds its own). A field called "fields"
      // stays nested, as {fields: value}: that's how the worker stores it too.
      let { fields: custom = {}, text, revision, bag, recipe, ...body } = await stored.json();
      if (custom === null) custom = {};
      else if (typeof custom !== "object" || Array.isArray(custom)) custom = { fields: custom };
      for (const [name, value] of Object.entries(custom)) {
        if (!Object.hasOwn(body, name) && !["text", "revision", "bag", "recipe"].includes(name)) body[name] = value;
      }
      if (Object.hasOwn(body, "fields")) body.fields = { fields: body.fields };
      const isText = value => value === null || typeof value !== "object" || (Array.isArray(value) && value.every(item => item === null || typeof item !== "object"));
      const notText = Object.keys(body).find(name => !(name === "fields" ? isText(body.fields.fields) && !Array.isArray(body.fields.fields) : isText(body[name])));
      if (notText !== undefined) {
        results.push({ title, result: `skipped: its field "${notText}" isn't text, which the new worker can't store` });
        continue;
      }
      if (text !== undefined) body.text = text;
      const saved = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Tiddler-Layout": "flat", "If-Match": stored.headers.get("ETag") },
        body: JSON.stringify(body)
      });
      results.push({ title, result: saved.ok ? "converted" : `not converted (${saved.status}: ${await saved.text()})` });
    } catch (e) {
      results.push({ title, result: `error: ${e.message}` });
    }
  }
  console.table(results);
  const left = results.filter(r => r.result !== "converted").length;
  console.log(left ? `${left} tiddler(s) not converted: see the table above.` : "Every tiddler is converted. Deploy the new worker now.");
  return results;
})();
