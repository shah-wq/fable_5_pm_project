// Builds the PDFs in this folder:
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node docs/project-documentation/build.mjs
//   DOC=blueprint PLAYWRIGHT_CORE=… node docs/project-documentation/build.mjs
//
// DOC=main (the default) builds SolarFlow-PM-Project-Documentation.pdf from ./src;
// DOC=blueprint builds SolarFlow-AI-Automation-Blueprint.pdf from ./blueprint,
// with the same stylesheet and fonts.
//
// Needs Chromium (the one Playwright uses) and Python 3 with pypdf. Two passes:
// the first renders the body and finds the page each chapter and module landed
// on; the second writes those numbers into the table of contents. The cover is
// rendered on its own, without a footer, and put in front.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const DOCS = {
  main: {
    dir: 'src', css: 'style.css', out: 'SolarFlow-PM-Project-Documentation.pdf',
    title: 'SolarFlow PM — Complete Project Documentation', footer: 'SolarFlow PM · Complete project documentation',
    subject: 'Modules, automations, AI integration, status, roadmap and best practices',
  },
  blueprint: {
    dir: 'blueprint', css: '../src/style.css', out: 'SolarFlow-AI-Automation-Blueprint.pdf',
    title: 'SolarFlow PM — E-signature, Ask SolarFlow & the AI and Automation Blueprint',
    footer: 'SolarFlow PM · New features &amp; AI and automation blueprint',
    subject: 'PandaDoc e-signature, change orders, stage attachments, the AI assistant, and recommendations to reduce manual work',
  },
};
const doc = DOCS[process.env.DOC || 'main'];
if (!doc) throw new Error(`unknown DOC: ${process.env.DOC} (main or blueprint)`);
const src = path.join(here, doc.dir);
const out = path.join(here, doc.out);
const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_CORE || require.resolve('playwright-core');
const { chromium } = require(pwPath);
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------ appendices
function migrationsTable() {
  const dir = path.join(root, 'db/migrations');
  const rows = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f, i) => {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').slice(0, 6);
    const head = lines.find((l, n) => n > 0 && /^--\s+\S/.test(l) && !/^--\s*=+\s*$/.test(l)) ?? '';
    const what = head.replace(/^--\s*/, '').replace(/^\d{6}\s*[—-]\s*/, '').replace(/^Modules 16–19 · /, '');
    const [stamp, ...rest] = f.replace(/\.sql$/, '').split('_');
    return `<tr><td>${i + 1}</td><td class="mono">${stamp.slice(8)}</td><td class="mono">${esc(rest.join('_'))}</td><td>${esc(what)}</td></tr>`;
  });
  return `<table class="t-compact"><thead><tr><th style="width:6%">#</th><th style="width:10%">No.</th><th class="w30">File</th><th>What it does</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function walk(dir, name) {
  const found = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...walk(p, name));
    else if (e.name === name) found.push(p);
  }
  return found;
}

function routeOf(file, base) {
  const rel = path.relative(base, path.dirname(file)).split(path.sep).filter((s) => !/^\(.*\)$/.test(s));
  return '/' + rel.join('/');
}

function groupedTable(files, base, prefix, label) {
  const groups = new Map();
  for (const f of files) {
    const r = routeOf(f, base);
    const route = prefix + (r === '/' ? '' : r);
    const key = route.split('/').filter(Boolean)[prefix ? 1 : 0] ?? '(home)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(route || '/');
  }
  const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
    ([k, list]) => `<tr><td class="k">${esc(k)}</td><td class="mono">${list.sort().map(esc).join(' · ')}</td></tr>`
  );
  return `<table class="t-compact"><thead><tr><th class="w18">${label}</th><th>Routes</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// ------------------------------------------------------------ assembly
const fragments = fs.readdirSync(src).filter((f) => /^\d\d-.*\.html$/.test(f)).sort()
  .map((f) => fs.readFileSync(path.join(src, f), 'utf8')).join('\n');

// A marker in front of every module strip, so the contents can list modules.
let body = fragments.replace(
  /<div class="module"><span class="num">(M\d\d)<\/span><span class="name">([^<]+)<\/span>/g,
  (m, num) => `<span class="mk">@@${num}@@</span>${m}`
);
body = body
  .replace('<!--APPX_MIGRATIONS-->', migrationsTable())
  .replace('<!--APPX_SCREENS-->', groupedTable(walk(path.join(root, 'src/app'), 'page.tsx'), path.join(root, 'src/app'), '', 'Area'))
  .replace('<!--APPX_API-->', groupedTable(walk(path.join(root, 'src/app/api'), 'route.ts'), path.join(root, 'src/app/api'), '/api', 'Group'));

// Chapters and modules, in document order, for the contents.
const entries = [];
const re = /<section class="chapter" data-no="([^"]+)" data-title="([^"]+)">|<span class="num">(M\d\d)<\/span><span class="name">([^<]+)<\/span>/g;
for (let m; (m = re.exec(body)); ) {
  if (m[1]) entries.push({ key: `C${m[1]}`, no: /^\d+$/.test(m[1]) ? m[1] : m[1], title: m[2], sub: false });
  else entries.push({ key: m[3], no: m[3], title: m[4], sub: true });
}

const page = (inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${doc.title}</title>
<link rel="stylesheet" href="${doc.css}"><style>.mk{position:absolute;font-size:1px;line-height:1px;color:#fff}</style></head><body>${inner}</body></html>`;

function tocHtml(pages) {
  return entries.map((e) => `<div class="e${e.sub ? ' sub' : ''}"><span class="no">${e.sub ? e.no : esc(e.no)}</span><span class="ti">${e.title}</span><span class="pg">${pages[e.key] ?? ''}</span></div>`).join('');
}

const footer = `<div style="width:100%;padding:0 16mm;font-family:Inter,'Liberation Sans',sans-serif;font-size:7.5px;color:#8a93a3;display:flex;justify-content:space-between">
<span>${doc.footer}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;

const browser = await chromium.launch({ executablePath: CHROME });
const tab = await browser.newPage();

async function render(html, file, opts) {
  const tmp = path.join(src, `_${path.basename(file, '.pdf')}.html`);
  fs.writeFileSync(tmp, html);
  await tab.goto('file://' + tmp, { waitUntil: 'networkidle' });
  await tab.evaluate(() => document.fonts.ready);
  await tab.pdf({ path: file, format: 'A4', printBackground: true, ...opts });
  fs.unlinkSync(tmp);
}

function markerPages(file) {
  const py = `import sys, re, json
from pypdf import PdfReader
found = {}
for i, p in enumerate(PdfReader(sys.argv[1]).pages):
    for k in re.findall(r'@@([A-Z0-9]+)@@', p.extract_text() or ''):
        found.setdefault(k, i + 1)
print(json.dumps(found))`;
  return JSON.parse(execFileSync('python3', ['-c', py, file]).toString());
}

const bodyPdf = path.join(here, '_body.pdf');
const bodyOpts = {
  displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: footer,
  margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' },
};
let pages = {};
for (let pass = 1; pass <= 3; pass++) {
  await render(page(body.replace('<!--TOC-->', tocHtml(pages))), bodyPdf, bodyOpts);
  const found = markerPages(bodyPdf);
  const stable = entries.every((e) => found[e.key] === pages[e.key]);
  pages = found;
  console.log(`pass ${pass}: ${Object.keys(found).length} anchors located${stable ? ' — stable' : ''}`);
  if (stable) break;
}
const missing = entries.filter((e) => !pages[e.key]).map((e) => e.key);
if (missing.length) throw new Error(`no page found for: ${missing.join(', ')}`);

const coverPdf = path.join(here, '_cover.pdf');
await render(fs.readFileSync(path.join(src, 'cover.html'), 'utf8'), coverPdf, { margin: { top: 0, bottom: 0, left: 0, right: 0 } });
await browser.close();

execFileSync('python3', ['-c', `import sys
from pypdf import PdfReader, PdfWriter
w = PdfWriter()
for f in sys.argv[1:3]:
    for p in PdfReader(f).pages: w.add_page(p)
w.add_metadata({'/Title': sys.argv[4], '/Author': 'SolarFlow PM', '/Subject': sys.argv[5]})
with open(sys.argv[3], 'wb') as fh: w.write(fh)
print(len(w.pages), 'pages')`, coverPdf, bodyPdf, out, doc.title, doc.subject], { stdio: 'inherit' });
fs.unlinkSync(coverPdf);
fs.unlinkSync(bodyPdf);
console.log('wrote', path.relative(root, out));
