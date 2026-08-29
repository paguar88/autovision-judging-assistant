/**
 * Production isolation regression suite.
 *
 * The live 330 GTC beta serves from the production vector store. Every guarantee
 * that Batch 1 test work cannot reach it is asserted here, so that a future edit
 * which quietly removes one fails a test instead of failing a demonstration.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const PROD_STORE = 'vs_6a8f919ffd2c81919bebd21f9734fa4e';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('\nProduction isolation\n');

// ---- 1. The guard exists and names the production store ---------------------
test('upload script declares the production store as protected', () => {
  const s = read('scripts/upload-vector-store.mjs');
  assert.ok(s.includes('PROTECTED_STORE_IDS'), 'PROTECTED_STORE_IDS missing');
  assert.ok(s.includes(PROD_STORE), 'production store id not listed');
});

test('guard fires on the resolved store id, not merely on the brand name', () => {
  const s = read('scripts/upload-vector-store.mjs');
  assert.ok(/PROTECTED_STORE_IDS\.includes\(STORE\)/.test(s),
    'guard must test the resolved STORE value; a brand-name check would not catch a mis-set env var');
});

test('guard is evaluated before any network call', () => {
  const s = read('scripts/upload-vector-store.mjs');
  assert.ok(s.indexOf('PROTECTED_STORE_IDS') < s.indexOf('listStoreFiles'),
    'guard must precede the first API call');
});

// ---- 2. The guard actually blocks, executed for real ------------------------
test('running upload as ferrari-test against the production store exits 2', () => {
  let code = 0, out = '';
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/upload-vector-store.mjs'), '--brand', 'ferrari-test', '--dry-run'], {
      env: { ...process.env, OPENAI_API_KEY: 'sk-test-not-real', OPENAI_VECTOR_STORE_ID_FERRARI_TEST: PROD_STORE },
      encoding: 'utf8', stdio: 'pipe',
    });
  } catch (e) { code = e.status; out = `${e.stdout || ''}${e.stderr || ''}`; }
  assert.equal(code, 2, `expected exit 2, got ${code}`);
  assert.ok(/PROTECTED/i.test(out), `expected a protected-store message, got: ${out.slice(0, 200)}`);
});

test('production brand may still address its own store', () => {
  // The guard must not break the production path it exists to protect.
  let out = '';
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/upload-vector-store.mjs'), '--brand', 'ferrari', '--dry-run'], {
      env: { ...process.env, OPENAI_API_KEY: 'sk-test-not-real', OPENAI_VECTOR_STORE_ID_FERRARI: PROD_STORE },
      encoding: 'utf8', stdio: 'pipe',
    });
  } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  assert.ok(!/PROTECTED/i.test(out), 'production brand must not be blocked by its own guard');
});

// ---- 3. Brand separation ----------------------------------------------------
test('ferrari and ferrari-test use different vector store variables', () => {
  const b = json('config/brands.json').brands;
  assert.ok(b['ferrari-test'], 'ferrari-test brand missing');
  assert.notEqual(b.ferrari.vector_store_env_var, b['ferrari-test'].vector_store_env_var);
});

test('ferrari brand config is unchanged in every field that affects production', () => {
  const f = json('config/brands.json').brands.ferrari;
  assert.equal(f.vector_store_env_var, 'OPENAI_VECTOR_STORE_ID_FERRARI');
  assert.equal(f.source_index, 'config/source-index.json');
  assert.equal(f.model_aliases, 'config/model-aliases.json');
  assert.equal(f.score_sheet_mappings, 'config/score-sheet-mappings.json');
  assert.equal(f.corpus_dir, undefined, 'ferrari must declare no corpus_dir so it defaults to approved-source-docs');
  assert.equal(json('config/brands.json').default_brand, 'ferrari');
});

test('the two brands read different source indexes', () => {
  const b = json('config/brands.json').brands;
  assert.notEqual(b.ferrari.source_index, b['ferrari-test'].source_index);
});

// ---- 4. Runtime cannot reach the test brand ---------------------------------
test('every Netlify function pins the brand to ferrari', () => {
  for (const f of ['ask', 'source', 'sources']) {
    const s = read(`netlify/functions/${f}.mjs`);
    assert.ok(/corpus\('ferrari'\)|sourceDocuments\('ferrari'\)/.test(s), `${f}.mjs does not pin the brand`);
    assert.ok(!s.includes('ferrari-test'), `${f}.mjs references the test brand`);
  }
});

test('no code iterates over the brand map', () => {
  // A keyed lookup cannot pick up a new brand by accident; iteration could.
  for (const rel of ['src/services/corpus.mjs', 'scripts/ingest.mjs', 'scripts/upload-vector-store.mjs']) {
    const s = read(rel);
    assert.ok(!/Object\.(keys|values|entries)\s*\(\s*[\w.]*brands\s*\)/.test(s), `${rel} iterates brands`);
  }
});

test('netlify.toml bundles only production artifacts', () => {
  const s = read('netlify.toml');
  assert.ok(s.includes('build/ferrari/*.json'));
  assert.ok(!s.includes('build/ferrari-test'), 'test artifacts must never be bundled');
  assert.ok(/command\s*=\s*"npm run ingest"/.test(s), 'build command should remain the production ingest');
});

test('the production build command resolves to the ferrari brand', () => {
  assert.equal(json('package.json').scripts.ingest, 'node scripts/ingest.mjs --brand ferrari');
});

// ---- 5. Corpus directory default is unchanged -------------------------------
test('corpus directory defaults to approved-source-docs', () => {
  const s = read('scripts/ingest.mjs');
  assert.ok(s.includes("'approved-source-docs'"), 'historical default missing');
  assert.ok(/CORPUS_DIR_FLAG\s*\|\|\s*brandCfg\.corpus_dir\s*\|\|\s*'approved-source-docs'/.test(s),
    'resolution order must fall back to the historical default');
});

test('source_path falls back to filename for flat corpora', () => {
  const s = read('scripts/ingest.mjs');
  assert.ok(/doc\.source_path\s*\|\|\s*doc\.filename/.test(s),
    'production entries declare no source_path and must still resolve');
});

test('the three legacy production files stay flat, taking the filename branch', () => {
  const legacy = ['iacpfa-judging-guidelines', 'ferrari-330-gtc-gts-checklist', 'ferrari-330-gtc-gts-as-built'];
  for (const d of json('config/source-index.json').documents.filter(x => legacy.includes(x.document_id))) {
    assert.equal(d.source_path, undefined, `${d.document_id} unexpectedly declares source_path`);
    assert.ok(d.filename, `${d.document_id} lost its filename`);
  }
});

test('every declared source_path is relative and stays under approved-source-docs', () => {
  // A path that escapes the corpus directory would let the index address arbitrary
  // files on the host, so this is a containment check, not a tidiness one.
  for (const d of json('config/source-index.json').documents) {
    const rel = d.source_path;
    if (rel === undefined) continue;
    assert.ok(typeof rel === 'string' && rel.length > 0, `${d.document_id}: empty source_path`);
    assert.ok(!path.isAbsolute(rel) && !/^[A-Za-z]:/.test(rel), `${d.document_id}: absolute path`);
    assert.ok(!rel.includes('\\'), `${d.document_id}: backslash separator`);
    assert.ok(!rel.split('/').includes('..'), `${d.document_id}: path escapes the corpus`);
    const resolved = path.resolve(ROOT, 'approved-source-docs', rel);
    assert.ok(resolved.startsWith(path.resolve(ROOT, 'approved-source-docs') + path.sep),
      `${d.document_id}: resolves outside approved-source-docs`);
  }
});

// ---- 6. Production candidate integrity --------------------------------------
const STABLE_IDS = ['iacpfa-judging-guidelines', 'ferrari-330-gtc-gts-checklist', 'ferrari-330-gtc-gts-as-built'];
// The Batch 1 index carried its own longer ids for the same three documents.
// Promoting those would break every citation route already issued against the
// live beta, so the candidate must keep the stable ids and drop these.
const REPLACED_IDS = [
  'ferrari-iac-pfa-judging-guidelines',
  'ferrari-330-gtc-gts-as-built-configuration-and-judging-notes-document-version-8',
  'ferrari-330-gtc-gts-concours-judging-checklist-ver-1',
];

test('the production candidate holds exactly 16 active, approved documents', () => {
  const d = json('config/source-index.json');
  assert.equal(d.documents.length, 16);
  for (const doc of d.documents) {
    assert.equal(doc.redistribution_status, 'approved', `${doc.document_id} not approved`);
    assert.equal(doc.active, true, `${doc.document_id} not active`);
  }
});

test('the three stable production ids survive promotion', () => {
  const ids = json('config/source-index.json').documents.map(d => d.document_id);
  for (const id of STABLE_IDS) assert.ok(ids.includes(id), `lost stable id: ${id}`);
});

test('their longer Batch 1 replacements are absent', () => {
  // Scanning the SERIALIZED index, not just the document ids: a discarded id can
  // also survive in _flags, related_documents, declared_cross_references or any
  // other audit field, and a stale reference there points at a document that no
  // longer exists in the corpus.
  const raw = read('config/source-index.json');
  for (const id of REPLACED_IDS) {
    assert.ok(!raw.includes(id), `discarded replacement id still present somewhere in the index: ${id}`);
  }
});

test('the other 13 Batch 1 documents are present', () => {
  const ids = new Set(json('config/source-index.json').documents.map(d => d.document_id));
  const expected = json('config/source-index-batch1.json').documents
    .map(d => d.document_id).filter(id => !REPLACED_IDS.includes(id));
  assert.equal(expected.length, 13);
  for (const id of expected) assert.ok(ids.has(id), `missing promoted document: ${id}`);
});

test('candidate document ids are unique and well formed', () => {
  const ids = json('config/source-index.json').documents.map(d => d.document_id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate document_id');
  for (const id of ids) assert.ok(/^[a-z0-9-]+$/.test(id) && !id.endsWith('-'), `malformed id: ${id}`);
});

test('the duplicate guidelines and the 599 GTB scan stay excluded', () => {
  const d = json('config/source-index.json');
  const paths = d.documents.map(x => x.source_path).filter(Boolean);
  assert.ok(!paths.includes('330 GTC/iac_pfa_judging_guidelines__.pdf'), 'duplicate guidelines was promoted');
  assert.ok(!paths.some(x => x.startsWith('599 GTB/')), 'the image-only 599 GTB scan was promoted');
  assert.equal(d._excluded.length, 2);
});

test('430 Scuderia is variant-scoped and never a plain F430 source', () => {
  const d = json('config/source-index-batch1.json').documents
    .find(x => x.document_id.includes('430-scuderia'));
  assert.deepEqual(d.models_covered, ['430 Scuderia']);
  assert.equal(d.model_family, 'F430');
  assert.ok(!d.models_covered.includes('F430'));
});

test('As-Built v8.0 and Checklist v9 are both active and neither is superseded', () => {
  const docs = json('config/source-index-batch1.json').documents;
  const a = docs.find(x => x.document_id.includes('as-built-configuration'));
  const b = docs.find(x => x.document_id.includes('as-built-checklist'));
  for (const d of [a, b]) {
    assert.equal(d.active, true);
    assert.equal(d.supersedes, null);
    assert.equal(d.superseded_by, null);
  }
  assert.ok(a.related_documents.includes(b.document_id), 'version relationship not linked');
  assert.ok(json('config/source-index-batch1.json')._flags
    .some(f => f.code === 'VERSION_RELATIONSHIP_UNRESOLVED'), 'relationship not flagged');
});

test('inherited metadata carries a checksum to verify against', () => {
  for (const d of json('config/source-index-batch1.json').documents) {
    if (d._field_provenance?.inherited_from) {
      assert.ok(/^[0-9a-f]{64}$/.test(d.expected_source_checksum || ''),
        `${d.document_id} inherits metadata without a verifiable checksum`);
    }
  }
});

test('ingestion warns when an inherited checksum does not match', () => {
  assert.ok(read('scripts/ingest.mjs').includes('INHERITED_CHECKSUM_MISMATCH'));
});

test('unaccepted candidates are parked, never written into real fields', () => {
  for (const d of json('config/source-index-batch1.json').documents) {
    if (!d._curator_candidates) continue;
    assert.equal(d._curator_candidates.status, 'UNACCEPTED');
    for (const k of Object.keys(d._curator_candidates.proposed)) {
      assert.equal(d[k], null, `${d.document_id}: candidate ${k} leaked into the real field`);
    }
  }
});

// ---- 7. Extraction helper is read-only --------------------------------------
test('extract-title-pages writes nothing and calls no API', () => {
  const s = read('scripts/extract-title-pages.mjs');
  assert.ok(!s.includes('api.openai.com') && !s.includes('OPENAI_API_KEY'), 'must not contact OpenAI');
  assert.ok(!/writeFileSync\((?!path\.join\(ROOT, OUT\))/.test(s.replace(/\/\*[\s\S]*?\*\//g, '')),
    'must write only the optional --out transcript');
});

// ---- 8. Repo hygiene --------------------------------------------------------
test('gitignore keeps build output, dependencies and the test corpus out of git', () => {
  assert.ok(existsSync(path.join(ROOT, '.gitignore')), '.gitignore missing');
  const g = read('.gitignore');
  for (const p of ['node_modules/', 'build/', 'Ferrari Judging Documents/', '.env']) {
    assert.ok(g.includes(p), `.gitignore missing ${p}`);
  }
});

test('no vector store id literal outside the guard and this suite', () => {
  for (const rel of ['config/brands.json', 'config/source-index-batch1.json', 'netlify.toml']) {
    assert.ok(!read(rel).includes(PROD_STORE), `${rel} contains the production store id`);
  }
});

// ---- 9. Windows path safety -------------------------------------------------
// new URL(import.meta.url).pathname returns "/C:/..." on Windows and leaves spaces
// percent-encoded, so any repository path containing a space resolves to a
// directory that does not exist. fileURLToPath is the platform-correct conversion.
test('no script derives a filesystem path from URL.pathname', () => {
  const dirs = ['scripts', 'tests'];
  const offenders = [];
  for (const dir of dirs) {
    for (const f of readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.mjs')) continue;
      // This suite names the pattern in a string literal in order to assert against it.
      if (f === 'protected-store-guard.test.mjs') continue;
      if (read(`${dir}/${f}`).includes('new URL(import.meta.url).pathname')) offenders.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(offenders, [], `URL.pathname is not Windows-safe: ${offenders.join(', ')}`);
});

test('every module deriving a root imports fileURLToPath', () => {
  for (const dir of ['scripts', 'tests']) {
    for (const f of readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.mjs')) continue;
      const s = read(`${dir}/${f}`);
      if (!s.includes('fileURLToPath(')) continue;
      assert.ok(/import\s*\{[^}]*\bfileURLToPath\b[^}]*\}\s*from\s*'node:url';/.test(s),
        `${dir}/${f} uses fileURLToPath without importing it`);
    }
  }
});

test('fileURLToPath decodes spaces and strips the drive-letter slash', () => {
  // The user's real repository path contains three spaces.
  const winUrl = 'file:///C:/Users/CTLAP/OneDrive%20-%20Paguar%20Informatics/'
               + 'Autovision%20Studios/Judging%20Assistant/repo/scripts/ingest.mjs';
  assert.ok(new URL(winUrl).pathname.includes('%20'), 'precondition: URL.pathname leaves %20 encoded');
  const decoded = fileURLToPath(winUrl);
  assert.ok(!decoded.includes('%20'), 'fileURLToPath must decode percent-encoding');
  assert.ok(decoded.includes('OneDrive - Paguar Informatics'), 'spaces must be restored');
});

// ---- 10. Retrieval unit headers never contain the literal "null" ------------
test('ingest guards nullable header fields', () => {
  const s = read('scripts/ingest.mjs');
  for (const f of ['document_version', 'source_organization']) {
    assert.ok(new RegExp(`doc\\.${f}\\s*\\?\\s*\`[A-Za-z ]+: \\$\\{doc\\.${f}\\}\`\\s*:\\s*null`).test(s),
      `${f} must be omitted when null, not interpolated as the string "null"`);
  }
});

test('generated production retrieval units contain no literal null header', () => {
  const dir = path.join(ROOT, 'build/ferrari/retrieval-units');
  if (!existsSync(dir)) return;  // build/ is generated; skip on a clean checkout
  const offenders = readdirSync(dir).filter(f =>
    /^(Document version|Source organization): null$/m.test(readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(offenders, [], `units carry a literal "null" header: ${offenders.slice(0, 3).join(', ')}`);
});

// ---- 11. Alias coverage accepts curated models_covered ---------------------
// A text-only check misreports a correctly scoped document whose title page is
// graphical — the 430 Scuderia owner's manual exposes no extractable model name.
test('alias coverage treats curated models_covered as sufficient', () => {
  const s = read('scripts/ingest.mjs');
  assert.ok(s.includes('normalizedModelsInCorpus'), 'curated model set not built for alias matching');
  assert.ok(/const curatedMatch = names\.some\(n => normalizedModelsInCorpus\.has\(n\)\)/.test(s),
    'curated models_covered must be matched against the alias table');
  assert.ok(/if \(!curatedMatch && !textMatch\)/.test(s),
    'an alias may only be reported uncovered when BOTH signals fail');
});

test('the text scan survives as a secondary signal', () => {
  const s = read('scripts/ingest.mjs');
  assert.ok(/const textMatch = names\.some\(n => corpusText\.includes\(n\)\)/.test(s),
    'text matching should be retained for diagnostics');
  assert.ok(s.includes('aliases_covered_by_curation_only'),
    'curation-only coverage should be recorded so the distinction stays visible');
});

test('a genuinely uncovered alias is still reported', () => {
  // Production seeds 365 GTB/4 with no document covering it. The relaxed check
  // must not turn a real configuration gap into silence.
  const p = path.join(ROOT, 'build/ferrari/ingestion-report.json');
  if (!existsSync(p)) return;  // build/ is generated; skip on a clean checkout
  const v = JSON.parse(readFileSync(p, 'utf8')).corpus_config_validation;
  assert.ok(v.aliases_without_document.some(a => a.model_id === 'ferrari-365-gtb4'),
    '365 GTB/4 has no covering document and must still be flagged');
});

// ---- 12. Vector-store upload attributes ------------------------------------
const { buildAttributes, MAX_ATTRIBUTES } = await import('../scripts/upload-vector-store.mjs');

const unit = (over = {}) => ({
  unit_id: 'u1', document_id: 'd1', document_title: 'T', document_version: '8.0',
  page_number: 3, brand: 'ferrari', source_type: 'manual', superseded_status: 'current', ...over,
});

test('a null document version is omitted, never the string "null"', () => {
  for (const v of [null, undefined, '', '   ']) {
    const { attributes } = buildAttributes(unit({ document_version: v }), null);
    assert.ok(!('document_version' in attributes),
      `document_version should be absent for ${JSON.stringify(v)}`);
    assert.ok(!Object.values(attributes).includes('null'), 'no attribute may hold the text "null"');
  }
});

test('a real document version is still carried', () => {
  const { attributes } = buildAttributes(unit({ document_version: 'VER 1' }), null);
  assert.equal(attributes.document_version, 'VER 1');
});

test('430 Scuderia and standard F430 receive distinct model_coverage', () => {
  const scud = buildAttributes(unit({ document_id: 'scuderia' }),
    { scope: 'model_specific', model_family: 'F430', models_covered: ['430 Scuderia'] }).attributes;
  const f430 = buildAttributes(unit({ document_id: 'f430' }),
    { scope: 'model_specific', model_family: 'F430', models_covered: ['F430'] }).attributes;

  assert.equal(scud.model_coverage, '430 Scuderia');
  assert.equal(f430.model_coverage, 'F430');
  assert.notEqual(scud.model_coverage, f430.model_coverage,
    'the variant manual must be filterable apart from standard F430 documentation');
  assert.equal(scud.model_family, f430.model_family, 'both remain in the F430 family');
});

test('brand-wide documents carry scope but no model coverage', () => {
  const { attributes } = buildAttributes(unit(),
    { scope: 'brand_wide', models_covered: [] });
  assert.equal(attributes.scope, 'brand_wide');
  assert.ok(!('model_coverage' in attributes), 'brand-wide documents must not be model-filtered');
});

test('multiple coverage values are surfaced, never flattened into one filter value', () => {
  const { attributes, notes } = buildAttributes(unit(),
    { scope: 'model_specific', models_covered: ['330 GTC', '330 GTS'] });
  assert.ok(!('model_coverage' in attributes), 'must not join multiple models into one value');
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].models_covered, ['330 GTC', '330 GTS']);
});

test('page identity attributes are unchanged', () => {
  const { attributes } = buildAttributes(unit(), { scope: 'model_specific', models_covered: ['F430'] });
  for (const [k, v] of Object.entries({
    unit_id: 'u1', document_id: 'd1', document_title: 'T',
    page_number: 3, brand: 'ferrari', source_type: 'manual', superseded_status: 'current',
  })) assert.equal(attributes[k], v, `page identity attribute ${k} changed`);
});

test('attributes stay within the limit and use only supported types', () => {
  const { attributes } = buildAttributes(
    unit({ section_heading: 'S', effective_year: 2023 }),
    { scope: 'model_specific', model_family: 'F430', models_covered: ['430 Scuderia'] });
  assert.ok(Object.keys(attributes).length <= MAX_ATTRIBUTES,
    `${Object.keys(attributes).length} exceeds ${MAX_ATTRIBUTES}`);
  for (const v of Object.values(attributes)) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof v), `unsupported type ${typeof v}`);
  }
});

test('the uploader reads scope and coverage from the curated index, never derives them', () => {
  const s = read('scripts/upload-vector-store.mjs');
  assert.ok(s.includes('brandCfg.source_index'), 'curated source index must be the source of scope');
  assert.ok(!/scope\s*=\s*['"]model_specific['"]/.test(s), 'scope must not be hard-coded');
});

// ---- 13. retrieval-test brand selection ------------------------------------
const runRetrieval = (argv, env = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [path.join(ROOT, 'scripts/retrieval-test.mjs'), ...argv],
      { env: { ...process.env, OPENAI_API_KEY: '', OPENAI_VECTOR_STORE_ID_FERRARI: '',
               OPENAI_VECTOR_STORE_ID_FERRARI_TEST: '', ...env },
        encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout };
  } catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};

test('retrieval-test defaults to the ferrari brand', () => {
  const { out } = runRetrieval(['a question']);
  assert.match(out, /OPENAI_VECTOR_STORE_ID_FERRARI must be set/,
    'default must remain ferrari and name its own variable');
  assert.ok(!out.includes('FERRARI_TEST'), 'default must not resolve to the test brand');
});

test('retrieval-test --brand ferrari-test names the test variable', () => {
  const { out } = runRetrieval(['a question', '--brand', 'ferrari-test']);
  assert.match(out, /OPENAI_VECTOR_STORE_ID_FERRARI_TEST must be set/);
});

test('retrieval-test refuses to query the production store as ferrari-test', () => {
  const { code, out } = runRetrieval(['--brand', 'ferrari-test'],
    { OPENAI_API_KEY: 'sk-not-real', OPENAI_VECTOR_STORE_ID_FERRARI_TEST: PROD_STORE });
  assert.equal(code, 2);
  assert.match(out, /PROTECTED/);
});

test('retrieval-test does not block the production brand on its own store', () => {
  const { out } = runRetrieval([], { OPENAI_API_KEY: 'sk-not-real', OPENAI_VECTOR_STORE_ID_FERRARI: PROD_STORE });
  assert.ok(!/PROTECTED/.test(out), 'production must not be blocked by its own guard');
});

test('retrieval-test rejects an unknown brand before any API call', () => {
  const { code, out } = runRetrieval(['--brand', 'not-a-brand']);
  assert.equal(code, 2);
  assert.match(out, /unknown brand/);
});

test('the --brand value is not mistaken for the question', () => {
  // "ferrari-test" does not start with "--", so a naive scan would treat it as
  // the question and silently test the wrong text.
  const s = read('scripts/retrieval-test.mjs');
  assert.ok(/brandFlagIdx \+ 1/.test(s) && /flagValueIdx/.test(s),
    'question parsing must exclude the value that follows --brand');
});

test('retrieval and citation logic are unchanged', () => {
  const s = read('scripts/retrieval-test.mjs');
  assert.ok(s.includes('max_num_results: 8'), 'result count changed');
  assert.ok(s.includes("include: ['file_search_call.results']"), 'citation resolution path changed');
  assert.ok(s.includes('store: false'), 'request storage behaviour changed');
  assert.ok(s.includes('Answer only from the approved source documents'), 'prompt changed');
  assert.ok(s.includes("process.env.OPENAI_MODEL || 'gpt-4.1'"), 'model selection changed');
});

// ---- 14. Model-coverage retrieval filter -----------------------------------
const { buildFileSearchTool } = await import('../scripts/retrieval-test.mjs');

test('without --coverage the file_search block is unchanged', () => {
  for (const c of [undefined, null, '', '   ']) {
    const tool = buildFileSearchTool('vs_x', c);
    assert.deepEqual(tool, { type: 'file_search', vector_store_ids: ['vs_x'], max_num_results: 8 },
      `unfiltered path must be untouched for ${JSON.stringify(c)}`);
    assert.ok(!('filters' in tool), 'no filter key may be emitted on the default path');
  }
});

test('--coverage produces an OR of brand_wide and exact model_coverage', () => {
  const { filters, max_num_results, vector_store_ids } = buildFileSearchTool('vs_x', '430 Scuderia');
  assert.equal(max_num_results, 8, 'result count must not change');
  assert.deepEqual(vector_store_ids, ['vs_x']);
  assert.deepEqual(filters, {
    type: 'or',
    filters: [
      { type: 'eq', key: 'scope', value: 'brand_wide' },
      { type: 'eq', key: 'model_coverage', value: '430 Scuderia' },
    ],
  });
});

test('the filter admits brand-wide and the exact model, and nothing else', () => {
  const { filters } = buildFileSearchTool('vs_x', '430 Scuderia');
  const admits = (attrs) => filters.filters.some(c => attrs[c.key] === c.value);

  assert.ok(admits({ scope: 'brand_wide' }), 'shared IAC/PFA material must be admitted');
  assert.ok(admits({ scope: 'model_specific', model_coverage: '430 Scuderia' }),
    'the requested model must be admitted');

  for (const other of ['F430', 'GTC4Lusso T', '458 Italia', '330 GTC/GTS', 'F8 Tributo']) {
    assert.ok(!admits({ scope: 'model_specific', model_family: 'F430', model_coverage: other }),
      `${other} must be excluded`);
  }
});

test('coverage matches exactly, never by family', () => {
  // The 430 Scuderia manual and the F430 parts catalogue share model_family F430.
  // Family matching would let the variant answer as standard F430 documentation.
  const { filters } = buildFileSearchTool('vs_x', '430 Scuderia');
  assert.ok(!filters.filters.some(c => c.key === 'model_family'),
    'model_family must not be a filter key');
  assert.ok(filters.filters.every(c => c.type === 'eq'),
    'only equality comparisons; no prefix or contains matching');
});

test('coverage is used verbatim, with no alias or model-name inference', () => {
  assert.equal(buildFileSearchTool('vs_x', 'Anything At All').filters.filters[1].value, 'Anything At All');
  const s = read('scripts/retrieval-test.mjs');
  assert.ok(!/alias/i.test(s.split('buildFileSearchTool')[1] || ''), 'no alias resolution in the builder');
});

test('the --coverage value is not mistaken for the question', () => {
  const s = read('scripts/retrieval-test.mjs');
  assert.ok(/flagValueIdx/.test(s), 'flag values must be excluded from question parsing');
  assert.ok(/coverageFlagIdx \+ 1/.test(s), '--coverage value must be excluded');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
