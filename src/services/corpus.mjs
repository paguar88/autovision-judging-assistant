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
