<!-- The process is in CONTRIBUTING.md; this is its checklist. Strike what doesn't apply, and say why. A typo, a broken link or a wording fix that changes no behaviour needs no plan and no test: open the pull request, say "docs only", and run `npm run test:repository` if you have a clone (it checks every link and section reference; for such a pull request CI runs that suite alone, the browser job skipped). -->

## What

<!-- What the user will experience: the README paragraph this adds or changes, in its words; or, when no README paragraph changes (most fixes), what the user saw before and sees now, with the manual's section it concerns. -->

## Checks

<!-- The tests, by name, and what each covers. Each was seen failing before the change. Then what was run on this head, with each suite's summary line, and what was looked at by hand (CONTRIBUTING, AI-assisted contributions). -->

## Before merging

- [ ] The tests were written first and seen failing for the right reason
- [ ] Every suite passes (`npm test`), and so do `npm run lint` and `npm run check:build`
- [ ] The docs are in this PR: the why in `docs/design.md` section 2, the how in the manual's page it concerns (`docs/setup.md`, `operating.md`, `troubleshooting.md`, `limits.md`), the what in `CHANGELOG.md` under Unreleased (with what the update asks of a user), `docs/roadmap.md` updated, `docs/tests.md` for a new or changed check
- [ ] The README's screenshot regenerated (`npm run screenshot`), if what it shows changed
- [ ] One more worker request, R2 call or queue operation per save or per load is justified above, not left as a detail
