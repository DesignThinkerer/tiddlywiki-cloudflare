<!-- The process is in CONTRIBUTING.md; this is its checklist. Strike what doesn't apply, and say why. -->

## What

<!-- What the user will experience: the README paragraph this adds or changes, in its words. -->

## Checks

<!-- The tests, by name, and what each covers. Each was seen failing before the change. -->

## Before merging

- [ ] The tests were written first and seen failing for the right reason
- [ ] Every suite passes (`npm test`), and so do `npm run lint` and `npm run check:build`
- [ ] The docs are in this PR: the why in `docs/design.md` section 2, the how in the manual's page it concerns (`docs/setup.md`, `operating.md`, `troubleshooting.md`, `limits.md`), the what in `CHANGELOG.md` under Unreleased (with what the update asks of a user), `docs/roadmap.md` updated, `docs/tests.md` for a new or changed check
- [ ] The README's screenshot regenerated (`npm run screenshot`), if what it shows changed
- [ ] One more worker request, R2 call or queue operation per save or per load is justified above, not left as a detail
