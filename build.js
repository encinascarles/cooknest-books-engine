#!/usr/bin/env node
// Builds dist/ for the open engine (docs/proposals/books-engine.md):
//   dist/vivliostyle.js   Vivliostyle Core (AGPL-3.0) as window.vivliostyle, with two
//                         scheduler constants changed (below); source: node_modules/@vivliostyle/core
//   dist/book-engine.js   src/book-engine.js (CookNest, the engine itself)
// and copies them, with the viewers of ../demo (viewer.js and .css, the book
// frame; live-viewer.js and .css, the live book), into the booksDesign
// function's bundle, functions-books/modules/books/design/assets/ (committed:
// Cloud Build only runs npm ci). Run it after changing any of them:
//   cd services/backend/scripts/books-designs/engine && npm ci && node build.js
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const DIST = path.join(__dirname, "dist");
const ASSETS = path.resolve(__dirname, "../../../functions-books/modules/books/design/assets");
const VIEWERS = ["viewer.js", "viewer.css", "live-viewer.js", "live-viewer.css"];
fs.mkdirSync(DIST, { recursive: true });

// Vivliostyle yields to the browser every 25 ms and polls some states every
// 100 ms. A book block is a short document: a 250 ms slice and a 4 ms poll lay
// it out in about half the time (measured: Herència real-60, 14.5 s to 7.2 s
// for every block) without blocking the page for long.
const PATCHES = [
  { find: /slice\s*=\s*25([;,])/g, replace: "slice=250$1", expect: 1 },
  { find: /\.sleep\(\s*100\s*\)/g, replace: ".sleep(4)", expect: 5 },
];

const tuning = {
  name: "vivliostyle-tuning",
  setup(build) {
    build.onLoad({ filter: /@vivliostyle[\\/]core[\\/]lib[\\/]vivliostyle\.js$/ }, (args) => {
      let code = fs.readFileSync(args.path, "utf8");
      for (const p of PATCHES) {
        const n = (code.match(p.find) || []).length;
        if (n !== p.expect) throw new Error(`vivliostyle patch ${p.find}: ${n} matches, expected ${p.expect} (new Vivliostyle version?)`);
        code = code.replace(p.find, p.replace);
      }
      return { contents: code, loader: "js" };
    });
  },
};

esbuild
  .build({
    stdin: { contents: 'window.vivliostyle = require("@vivliostyle/core");', resolveDir: __dirname, loader: "js" },
    bundle: true,
    format: "iife",
    outfile: path.join(DIST, "vivliostyle.js"),
    plugins: [tuning],
    logLevel: "warning",
    banner: { js: "/* Vivliostyle Core 2.45.2, AGPL-3.0 (https://github.com/vivliostyle/vivliostyle.js). Changed: scheduler slice 25 to 250 ms, polls 100 to 4 ms (build.js). */" },
  })
  .then(() => {
    fs.copyFileSync(path.join(__dirname, "src/book-engine.js"), path.join(DIST, "book-engine.js"));
    for (const f of fs.readdirSync(DIST)) console.log(`dist/${f} ${fs.statSync(path.join(DIST, f)).size} B`);
    fs.mkdirSync(ASSETS, { recursive: true });
    for (const f of ["vivliostyle.js", "book-engine.js"]) fs.copyFileSync(path.join(DIST, f), path.join(ASSETS, f));
    for (const f of VIEWERS) fs.copyFileSync(path.join(__dirname, "../demo", f), path.join(ASSETS, f));
    for (const f of ["vivliostyle.js", "book-engine.js", ...VIEWERS]) console.log(`functions-books/modules/books/design/assets/${f} ${fs.statSync(path.join(ASSETS, f)).size} B`);
  });
