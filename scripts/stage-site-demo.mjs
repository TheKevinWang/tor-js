// Copy the built site-adapter files next to the demo site so it can be served
// by any static file server:
//
//   npm run build && node scripts/stage-site-demo.mjs
//   python -m http.server 5175 --directory website/public/site-demo
//
// The copies are gitignored (website/public/site-demo/.gitignore). Also run by
// the website build in CI before `vite build`.

import { copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demo = resolve(root, 'website/public/site-demo');

const files = [
  ['dist/site/tor-site-sw.js', 'tor-site-sw.js', true],
  ['dist/site/tor-site.js', 'tor-site.js', true],
  ['dist/tor_js_bg.wasm', 'tor_js_bg.wasm', true],
  // A directory snapshot makes the first visit faster; the demo works without it.
  ['website/public/bootstrap.zip.zst', 'bootstrap.zip.zst', false],
];

for (const [from, to, required] of files) {
  const src = resolve(root, from);
  if (!existsSync(src)) {
    if (required) throw new Error(`missing ${from}; run "npm run build" first`);
    console.log(`skipped ${to} (no ${from})`);
    continue;
  }
  copyFileSync(src, resolve(demo, to));
  console.log(`staged ${to}`);
}
