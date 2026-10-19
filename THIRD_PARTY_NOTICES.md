# Third-party notices

The code in this repository is under the MIT licence (`LICENSE`). The worker it builds ships one third-party component, and every wiki it runs serves that component's files to browsers.

## TiddlyWiki

- Licence: BSD 3-Clause
- Copyright (c) 2004-2007 Jeremy Ruston; copyright (c) 2007-2025 UnaMesa Association
- Project: https://tiddlywiki.com, https://github.com/TiddlyWiki/TiddlyWiki5
- Use: the empty wiki a new bucket starts from (`seed/empty.html`, built from the `tiddlywiki` npm package by `npm run build` and uploaded with the worker as a module); the engine every wiki runs (`index.html` in the bucket); the core file and the TiddlyWeb plugin the page loads. Nothing of it is modified. The licence text travels inside every TiddlyWiki file, as the tiddler `$:/core/copyright.txt`, so every wiki and every page the worker serves carries it.

The development tooling (Miniflare, Wrangler, Playwright, ESLint) is used to build and test the worker and is not shipped.
