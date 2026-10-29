# CookNest Books layout engine

The page layout engine used by [CookNest Books](https://cooknest.app/books) to lay out printed cookbooks in the browser and on the server (headless Chromium). It is published here under the GNU Affero General Public License v3.0 because it is built on [Vivliostyle Core](https://github.com/vivliostyle/vivliostyle.js) (AGPL-3.0).

## Contents

- `src/book-engine.js`: the CookNest engine. It paginates each block of a book with Vivliostyle, caches the result and assembles the book. AGPL-3.0.
- `dist/vivliostyle.js`: Vivliostyle Core **2.45.2**, bundled as `window.vivliostyle`, with two scheduler constants changed for speed (see below). AGPL-3.0. Original source: https://github.com/vivliostyle/vivliostyle.js/tree/v2.45.2 (npm `@vivliostyle/core@2.45.2`).
- `build.js`: the build script that produces `dist/` from `@vivliostyle/core` and `src/`, including the exact modification.
- `package.json`: build dependencies.

## Modification to Vivliostyle Core

Applied at build time by `build.js` (`PATCHES`) to `@vivliostyle/core/lib/vivliostyle.js`:

1. Scheduler time slice `slice = 25` changed to `slice = 250`.
2. Scheduler yields `.sleep(100)` changed to `.sleep(4)` (5 occurrences).

No features were added or removed. The change makes long books lay out in about half the time.

Vivliostyle Core is implemented based on Peter Sorotokin's EPUB Adaptive Layout implementation, which is licensed under Apache License, Version 2.0.

## Build

```sh
npm ci
node build.js
```

## License

GNU Affero General Public License v3.0, see `LICENSE`. Books produced with this engine are not covered by this license.
