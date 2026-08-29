/**
 * Corpus access - reads the frozen Stage 1 artifacts and the curated Tier 2 tables.
 *
 * Read-only. Nothing here derives, infers or creates configuration at runtime
 * (Addendum A.2). Loaded once per function instance and cached.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.LAMBDA_TASK_ROOT || process.cwd();
const j = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

let cache = null;

export function corpus(brand = 'ferrari') {
  if (cache && cache.brand === brand) return cache;

  const brands = j('config/brands.json');
  const cfg = brands.brands[brand];
  if (!cfg) throw new Error(`Unknown brand: ${brand}`);

  const B = `build/${brand}`;
  const manifest = j(`${B}/document-manifest.json`).documents;
  const unitIndex = j(`${B}/retrieval-units.json`);

  // Slice availability is read from the FROZEN ingestion manifest, not from the local
  // filesystem. Per netlify.toml only the `source` function bundles the page-slice
  // bytes (A.7 keeps that 34 MB out of every other bundle), so a filesystem probe
  // inside `ask` always answered false and suppressed every verified page.
  //
  // This is not a weaker check. The manifest is the frozen record of what ingestion
  // actually generated, carrying each slice's physical page number and checksum, and
  // `source` independently re-authorises the document and re-validates the page range
  // before returning any bytes.
  const sliceIndex = new Map(
    manifest.map(d => [d.document_id, new Set((d.slices || []).map(s => s.physical_page_number))]),
  );

  cache = {
    brand,
    cfg,
    manifest,
    docById: new Map(manifest.map(d => [d.document_id, d])),
    units: unitIndex.units,
    unitById: new Map(unitIndex.units.map(u => [u.unit_id, u])),
    unitByFile: new Map(unitIndex.units.map(u => [u.unit_file, u])),
    aliases: j(cfg.model_aliases),
    mappings: j(cfg.score_sheet_mappings),
    slicePath: (documentId, page) =>
      path.join(ROOT, B, 'page-slices', documentId, `p${String(page).padStart(4, '0')}.pdf`),
    sliceExists: (documentId, page) => {
      if (page == null) return false;
      const pages = sliceIndex.get(documentId);
      if (pages && pages.size) return pages.has(page);
      // Defensive fallback for a manifest predating slice records.
      return existsSync(path.join(ROOT, B, 'page-slices', documentId, `p${String(page).padStart(4, '0')}.pdf`));
    },
    vectorStoreId: () => process.env[cfg.vector_store_env_var] || null,
  };
  return cache;
}

/**
 * Judge-selectable models - derived, never authored.
 *
 * A model appears only when the curated alias table declares it active with a
 * non-blank coverage value, AND an active, approved manifest document lists that
 * exact coverage value in models_covered. Both halves must agree: an alias with no
 * corpus behind it would offer the judge a model that can only fail closed, and a
 * document with no alias has no judge vocabulary to reach it.
 *
 * Matching is exact. No family widening, no alias expansion, no related-model
 * inference - `430 Scuderia` must never be satisfied by an `F430` document, and
 * `365 GTB/4`, which carries no model_coverage, is excluded rather than guessed at.
 * Alias-table order is preserved so the curator controls what the judge sees first.
 *
 * This list is a convenience for the interface. It is NOT the security boundary:
 * ask.mjs independently resolves and fails closed on anything unsupported.
 */
export function supportedModels(brand = 'ferrari') {
  const c = corpus(brand);

  const covered = new Set();
  for (const d of c.manifest) {
    if (!d.active || d.redistribution_status !== 'approved') continue;
    for (const m of d.models_covered || []) {
      if (typeof m === 'string' && m.trim() !== '') covered.add(m);
    }
  }

  return (c.aliases.models || [])
    .filter(m =>
      m.active === true
      && typeof m.canonical_model_name === 'string' && m.canonical_model_name.trim() !== ''
      && typeof m.model_coverage === 'string' && m.model_coverage.trim() !== ''
      && covered.has(m.model_coverage))
    .map(m => m.canonical_model_name);
}

/** Judge-facing document list - curated metadata only, never AI-inferred (v1.0 §16.1). */
export function sourceDocuments(brand = 'ferrari') {
  return corpus(brand).manifest
    .filter(d => d.active && d.redistribution_status === 'approved')
    .map(d => ({
      document_id: d.document_id,
      display_title: d.display_title,
      document_version: d.document_version,
      publication_date: d.publication_date,
      source_organization: d.source_organization,
      page_count: d.page_count,
      display_description: d.display_description,
    }));
}
