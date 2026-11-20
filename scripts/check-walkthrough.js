#!/usr/bin/env node
// Fails when WALKTHROUGH.md has drifted from the code:
//  1. every source file must be named in it,
//  2. every IPC channel in preload.js must be named in it,
//  3. every line of every ```js/css/html/json block must still exist in the source.
//     Mark illustrative blocks with an extra word, e.g. ```js example, to skip them.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'WALKTHROUGH.md'), 'utf8');
const errors = [];

const sources = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'fonts', 'svg'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|html|css)$/.test(e.name) || e.name === 'package.json') sources.push(path.relative(root, p));
  }
})(root);

// 1. files
for (const f of sources) if (!doc.includes(path.basename(f))) errors.push(`file not covered: ${f}`);

// 2. IPC channels
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
for (const [, ch] of preload.matchAll(/ipcRenderer\.\w+\('([^']+)'/g)) {
  if (!doc.includes(`'${ch}'`) && !doc.includes('`' + ch + '`')) errors.push(`IPC channel not documented: ${ch}`);
}

// 3. code excerpts
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const corpus = sources.map((f) => fs.readFileSync(path.join(root, f), 'utf8').split('\n').map(norm).join('\n')).join('\n');
const fence = /^```(\w+)([^\n]*)\n([\s\S]*?)^```/gm;
for (const m of doc.matchAll(fence)) {
  const [, lang, extra, body] = m;
  if (!['js', 'css', 'html', 'json'].includes(lang) || extra.trim()) continue;
  const lineNo = doc.slice(0, m.index).split('\n').length;
  for (const raw of body.split('\n')) {
    const line = norm(raw);
    if (!line || line.includes('…') || /^\.\.\.,?$/.test(line)) continue; // elisions
    if (!corpus.includes(line)) errors.push(`WALKTHROUGH.md:${lineNo}: excerpt line not found in source: ${line}`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} problem(s). Update WALKTHROUGH.md to match the code.`);
  process.exit(1);
}
console.log(`WALKTHROUGH.md is up to date (${sources.length} files checked).`);
