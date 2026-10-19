// Where the manual lives, for the worker's own messages (design 2.28): a refusal, an error page or a
// setup check line names the section that fixes what it found, as the docs cite it ("setup 2.6"),
// with its link. The headings here are the pages' own, and the link's anchor is made from them the
// way GitHub makes it; the repository suite checks each against its page, so a heading can't be
// renamed or moved without this map following.
export const DOCS_URL = "https://github.com/DesignThinkerer/tiddlywiki-cloudflare/blob/main/docs";
const GUIDE = {
  setup: { page: "setup.md", headings: { "2.1": "Before you start", "2.2": "The bucket and the public site", "2.3": "The backup queue", "2.4": "The backup repository (optional)", "2.5": "The worker", "2.6": "Cloudflare Access", "2.7": "The zone's rules (public site only)", "2.8": "The first visit" } },
  operating: { page: "operating.md", headings: { "3.3": "Updating the wiki engine" } },
};
const slug = text => text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

// A section's link: { section: "2.6", text: "setup 2.6", url }
export function guide(chapter, section) {
  const { page, headings } = GUIDE[chapter];
  if (!headings[section]) throw new Error(`No guide section ${chapter} ${section}`);
  return { section, text: `${chapter} ${section}`, url: `${DOCS_URL}/${page}#${slug(`${section} ${headings[section]}`)}` };
}

// For a plain-text message: "setup 2.6: https://…"
export function guideText(chapter, section) {
  const g = guide(chapter, section);
  return `${g.text}: ${g.url}`;
}
