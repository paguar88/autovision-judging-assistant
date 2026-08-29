#!/usr/bin/env node
/**
 * Title-page text extractor — METADATA ONLY.
 *
 * Reads the first N pages of every document declared in a source index and prints
 * their text. Nothing else. It does not write the source index, does not decide
 * any field, does not contact OpenAI, and does not touch build/.
 *
 * It exists because display_title, document_version, publication_date and
 * source_organization are curator decisions that must come from the documents
 * themselves (Addendum A.5). A filename is not a document: "Semiar-for-Judges"
 * misspells its own subject, and "2019_10_05-21_09_21-UTC" is an export timestamp
 * rather than a publication date. Reading page 1 replaces guesswork with evidence.
 *
 * Usage:
 *   node scripts/extract-title-pages.mjs --brand ferrari-test --corpus-dir "<path>"
 *   node scripts/extract-title-pages.mjs --brand ferrari-test --corpus-dir "<path>" --pages 2
 *   node scripts/extract-title-pages.mjs --brand ferrari-test --corpus-dir "<path>" --only 458
 *   ... --out title-pages.txt
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const BRAND = argVal('--brand') || 'ferrari-test';
const PAGES = Math.max(1, parseInt(argVal('--pages') || '1', 10));
const ONLY = argVal('--only');
const OUT = argVal('--out');

const brandsCfg = JSON.parse(readFileSync(path.join(ROOT, 'config/brands.json'), 'utf8'));
const brandCfg = brandsCfg.brands[BRAND];
if (!brandCfg) { console.error(`Unknown brand: ${BRAND}`); process.exit(2); }

const CORPUS_REL = argVal('--corpus-dir') || brandCfg.corpus_dir || 'approved-source-docs';
const CORPUS_DIR = path.isAbsolute(CORPUS_REL) ? CORPUS_REL : path.join(ROOT, CORPUS_REL);
if (!existsSync(CORPUS_DIR)) { console.error(`Corpus directory not found: ${CORPUS_DIR}`); process.exit(2); }

const index = JSON.parse(readFileSync(path.join(ROOT, brandCfg.source_index), 'utf8'));

/**
 * Reassemble positioned text runs into lines.
 *
 * pdfjs returns runs, not lines. Joining them naively collapses a title page into
 * one run-on string and destroys exactly the visual structure — title, subtitle,
 * version line, date line — that makes a title page readable. Group by baseline,
 * then order left to right.
 */
function itemsToLines(items) {
  const rows = new Map();
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const y = Math.round(it.transform[5] * 2) / 2;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x: it.transform[4], str: it.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, runs]) => runs.sort((a, b) => a.x - b.x).map(r => r.str).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

const docs = index.documents.filter(d => !ONLY || d.document_id.includes(ONLY) || (d.source_path || '').includes(ONLY));

say(`Corpus:    ${CORPUS_DIR}`);
say(`Index:     ${brandCfg.source_index}`);
say(`Documents: ${docs.length}${ONLY ? ` (filtered by "${ONLY}")` : ''}   first ${PAGES} page(s) each`);
say();

let ok = 0, failed = 0;

for (const doc of docs) {
  const rel = doc.source_path || doc.filename;
  const abs = path.join(CORPUS_DIR, rel);

  say('='.repeat(78));
  say(doc.document_id);
  say(`file: ${rel}`);
  const needs = doc._curator_todo;
  if (needs?.length) say(`needs: ${needs.join(', ')}`);
  else say('needs: (complete)');
  if (doc._curator_candidates) {
    say(`candidate (UNACCEPTED): ${JSON.stringify(doc._curator_candidates.proposed)}`);
  }
  say('-'.repeat(78));

  if (!existsSync(abs)) { say('  !! FILE NOT FOUND'); failed++; say(); continue; }

  try {
    const pdf = await getDocument({
      data: new Uint8Array(readFileSync(abs)),
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise;

    const limit = Math.min(PAGES, pdf.numPages);
    say(`  (${pdf.numPages} pages total; declared ${doc.declared_page_count ?? '?'})`);
    if (doc.declared_page_count != null && doc.declared_page_count !== pdf.numPages) {
      say(`  !! PAGE COUNT MISMATCH: index declares ${doc.declared_page_count}, PDF has ${pdf.numPages}`);
    }
    say();

    for (let p = 1; p <= limit; p++) {
      const page = await pdf.getPage(p);
      const lines = itemsToLines((await page.getTextContent()).items);
      say(`  --- page ${p} ---`);
      if (!lines.length) say('  (no extractable text — likely an image-only page)');
      for (const l of lines.slice(0, 40)) say(`  ${l}`);
      if (lines.length > 40) say(`  ... ${lines.length - 40} more line(s)`);
      say();
    }
    await pdf.destroy();
    ok++;
  } catch (e) {
    say(`  !! EXTRACTION FAILED: ${e.message}`);
    failed++;
    say();
  }
}

say('='.repeat(78));
say(`extracted: ${ok}   failed: ${failed}`);
say();
say('Read-only. No file in the source index was modified and nothing was uploaded.');

if (OUT) {
  writeFileSync(path.join(ROOT, OUT), out.join('\n'));
  console.log(`\nWritten to ${OUT}`);
}
