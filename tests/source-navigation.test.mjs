#!/usr/bin/env node
/**
 * Source navigation - Stage 2 live issue #3.
 *
 * Covers the gap that let both defects ship: every previous test called the source
 * function directly, so nobody exercised the URLs the BROWSER builds or the rewrite
 * rules those URLs must survive.
 *
 * This test parses the real [[redirects]] out of netlify.toml, implements Netlify's
 * matching, and routes the URLs app.js actually constructs through them into the real
 * source function. A URL that no rule matches, or that arrives without the parameters
 * the handler needs, fails here.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
process.env.BETA_PASSWORD = 'test-password';

const appjs = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const toml = readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
};

/* ---------- parse [[redirects]] and reimplement Netlify path matching ---------- */
const rules = [];
for (const block of toml.split('[[redirects]]').slice(1)) {
  const from = (block.match(/from\s*=\s*"([^"]+)"/) || [])[1];
  const to = (block.match(/to\s*=\s*"([^"]+)"/) || [])[1];
  if (from && to) rules.push({ from, to });
}

function route(url) {
  const [pathname, query] = url.split('?');
  for (const r of rules) {
    const fromParts = r.from.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);
    if (fromParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < fromParts.length; i++) {
      if (fromParts[i].startsWith(':')) params[fromParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      else if (fromParts[i] !== pathParts[i]) { matched = false; break; }
    }
    if (!matched) continue;
    let target = r.to;
    for (const [k, v] of Object.entries(params)) target = target.replaceAll(`:${k}`, encodeURIComponent(v));
    // Deliberately does NOT merge the caller's own query string: a target that already
    // carries one cannot be relied on to receive it. That assumption caused the bug.
    return { target, dropped: query || null };
  }
  return null;
}

const { issueSession } = await import(`${ROOT}/src/services/session.mjs`);
const { default: source } = await import(`${ROOT}/netlify/functions/source.mjs`);
const cookie = issueSession().split(';')[0];

/** Navigate as the browser would: build URL -> rewrite -> invoke the function. */
async function navigate(url, { authenticated = true } = {}) {
  const routed = route(url);
  if (!routed) return { routed: false };
  const res = await source({
    method: 'GET',
    url: `https://x${routed.target}`,
    headers: { get: (k) => (k === 'cookie' && authenticated ? cookie : null) },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return {
    routed: true, status: res.status,
    contentType: res.headers.get('content-type'),
    page: res.headers.get('x-source-page'),
    isPdf: buf.subarray(0, 4).toString() === '%PDF',
    isHtml: buf.subarray(0, 15).toString().toLowerCase().includes('<!doctype html'),
    bytes: buf.length, json,
  };
}

const DOC = 'ferrari-330-gtc-gts-checklist';
console.log(`\n=== SOURCE NAVIGATION (${rules.length} rewrite rules parsed) ===\n`);

/* ---- 1. Verified citation, page 3 ---- */
const cite = await navigate(`/source/${DOC}/page/3`);
check('citation route matches a rewrite rule', cite.routed, true);
check('verified citation page 3 opens', [cite.status, cite.contentType, cite.page], [200, 'application/pdf', '3']);

/* ---- 2. The response is a source page, not the app shell ---- */
check('response is a real PDF', cite.isPdf, true);
check('response is not the main app HTML', cite.isHtml, false);
check('response has real content', cite.bytes > 10000, true);

/* ---- 3. Source Documents -> Open document ---- */
const meta = await navigate(`/source/${DOC}/meta`);
check('metadata route matches a rewrite rule', meta.routed, true);
check('metadata returns JSON with a page count', [meta.contentType, typeof meta.json?.page_count], ['application/json', 'number']);
check('metadata survives without any caller query string', meta.json?.page_count, 4);
const opened = await navigate(`/source/${DOC}/page/1`);
check('library opens the document at page 1', [opened.status, opened.page, opened.isPdf], [200, '1', true]);

for (const d of ['iacpfa-judging-guidelines', 'ferrari-330-gtc-gts-checklist', 'ferrari-330-gtc-gts-as-built']) {
  const r = await navigate(`/source/${d}/meta`);
  check(`library entry ${d} is openable`, [r.status, typeof r.json?.page_count], [200, 'number']);
}

/* ---- the regression itself: the old URL shape ---- */
const oldShape = route(`/source/${DOC}?meta=1&page=3`);
check('old query-based metadata URL loses its parameters at the rewrite',
  [oldShape.target.includes('meta'), oldShape.dropped], [false, 'meta=1&page=3']);
check('app.js no longer builds that URL', /\?meta=1/.test(appjs), false);
check('app.js uses the path-based metadata route', /\/meta`\)/.test(appjs), true);

/* ---- 4 & 5. Back destinations - executing the shipped function ---- */
const src = appjs.match(/function nextViewOnBack\([\s\S]*?\n}/)[0];
const nextViewOnBack = new Function(`${src}; return nextViewOnBack;`)();
check('Back from a citation-opened source returns to the answer', nextViewOnBack('answer'), 'answer');
check('Back from a library-opened source returns to Source Documents', nextViewOnBack('library'), 'docs');
check('viewer records the origin it was opened from', /origin = 'answer'\)/.test(appjs), true);
check('citation stamps open with answer origin', /openSource\(s\.document_id[^)]*'answer'\)/.test(appjs), true);
check('library entries open with library origin', /openSource\(d\.document_id[^)]*'library'\)/.test(appjs), true);
check('Back re-shows the library when that is where it came from', /back === 'docs'\) show\(\$\('docs'\), true\)/.test(appjs), true);
check('the library is hidden only after the document opens',
  /if \(await openSource\(d\.document_id[^)]*\)\) show\(\$\('docs'\), false\)/.test(appjs), true);
check('a failed open reports rather than returning silently', /could not be opened/.test(appjs), true);

/* ---- 6. Authentication ---- */
const anon = await navigate(`/source/${DOC}/page/3`, { authenticated: false });
check('unauthenticated source access is rejected', [anon.status, anon.isPdf], [401, false]);
const anonMeta = await navigate(`/source/${DOC}/meta`, { authenticated: false });
check('unauthenticated metadata access is rejected', anonMeta.status, 401);

/* ---- 7. Invalid identifiers and pages ---- */
check('unknown document id is rejected', (await navigate('/source/made-up-doc/page/1')).status, 404);
check('path traversal in the document id is rejected', (await navigate('/source/..%2F..%2Fetc%2Fpasswd/page/1')).status, 404);
check('page beyond the document is rejected', (await navigate(`/source/${DOC}/page/999`)).status, 404);
check('page zero is rejected', (await navigate(`/source/${DOC}/page/0`)).status, 404);
check('non-numeric page is rejected', (await navigate(`/source/${DOC}/page/abc`)).status, 404);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
