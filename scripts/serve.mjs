#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// Static dev server for web/.
//
// Replaces `python3 -m http.server`, which cannot set response headers — so it
// could not send the cross-origin isolation headers the roadmap's service
// worker and interactive terminal will need (SharedArrayBuffer is gated behind
// them), and it served .wasm without the application/wasm MIME type that
// WebAssembly.instantiateStreaming requires. Local and GitHub Pages should
// behave the same; this is the half we control.
//
//   node scripts/serve.mjs [--port 8001] [--root web] [--coi]
//
// COI is OFF by default, because GitHub Pages cannot send those headers either
// and local should match production. Pass --coi to preview the isolated world
// the service worker will create (roadmap Phase 6) and find out which
// cross-origin assets it breaks.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = Number(opt('port', 8001));
const ROOT = resolve(opt('root', join(import.meta.dirname, '..', 'web')));
const COI = args.includes('--coi');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.php': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  // Required for WebAssembly.compileStreaming; without it the browser falls
  // back to a slower path or refuses outright.
  '.wasm': 'application/wasm',
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  let file = join(ROOT, path);

  // Traversal guard: a normalized path must still live under ROOT.
  if (!file.startsWith(ROOT + sep) && file !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    // GitHub Pages answers an unknown path with 404.html, and a page that
    // serves itself depends on that: every deep link into the served site is a
    // path no static host has, and 404.html is the one chance to install the
    // worker that answers it. Local has to behave the same or the cold-start
    // path is only ever tested in production.
    const notFound = join(ROOT, '404.html');
    try {
      const body = await readFile(notFound);
      res.writeHead(404, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
    return;
  }

  try {
    const body = await readFile(file);
    const headers = {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    if (COI) {
      // Cross-origin isolation, needed for SharedArrayBuffer. GitHub Pages
      // cannot send these, which is why the roadmap plans to inject them from
      // the service worker instead. Opt-in locally so you can see, ahead of
      // time, which cross-origin assets stop loading under them.
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
      headers['Cross-Origin-Resource-Policy'] = 'same-origin';
    }
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(500).end('read error');
  }
}).listen(PORT, () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}`);
  console.log(COI
    ? '  cross-origin isolation: ON — matches the future service-worker world, not Pages today'
    : '  cross-origin isolation: off (matches GitHub Pages; pass --coi to preview it on)');
});
