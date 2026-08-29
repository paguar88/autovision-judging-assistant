#!/usr/bin/env node
/**
 * Apply document-derived curator metadata to the Batch 1 index.
 *
 * Every value here was read out of the PDFs by scripts/extract-title-pages.mjs and
 * then confirmed by the curator. Nothing is derived from a filename.
 *
 * Curator rule applied throughout: where a document states only a month and year,
 * publication_date stays null and only effective_year is set. A first-of-month
 * placeholder is a fabricated date and is not written.
 *
 * Usage: node scripts/apply-extracted-metadata.mjs [--check]
 *   --check  report what would change without writing
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'config/source-index-batch1.json');
const CHECK = process.argv.includes('--check');

const idx = JSON.parse(readFileSync(TARGET, 'utf8'));

// Keyed by a distinctive fragment of document_id.
const DECISIONS = {
  'documenting-your-new-er-fer': {
    display_title: 'Documenting Your New(er) Ferrari',
    author: 'David Eichenbaum',
    display_description:
      'Guidance for documenting factory configuration, options and authenticity of newer Ferraris.',
    notes: 'Authored by David Eichenbaum, IAC/PFA member. No publication date or version stated in the document.',
  },
  'preservation-class-p': {
    display_title: 'The Ferrari Preservation Class',
    author: 'Donovan Leyden',
    source_organization: 'International Advisory Council for the Preservation of the Ferrari Automobile',
    display_description:
      'Guidance on originality, preservation philosophy, maintenance and judging of Preservation-class Ferraris.',
    notes: 'Authored by Donovan Leyden, Chairman for Preservation. No publication date or version stated in the document.',
  },
  'iac-pfa-decisions-15-february-2025': {
    display_title: 'IAC/PFA Decisions',
    publication_date: '2025-02-15',
    effective_year: 2025,
    source_organization: 'IAC/PFA',
    display_description: 'Current IAC/PFA judging decisions and policy interpretations.',
  },
  'judging-newer-ferraris-eich': {
    display_title: 'Judging Newer Ferraris',
    author: 'David Eichenbaum',
    publication_date: '2018-01-25',
    effective_year: 2018,
    display_description:
      'Judge-training material focused on authenticity and configuration of newer Ferraris.',
  },
  'judging-older-ferraris-leyd': {
    display_title: 'Judging Older Ferraris',
    display_description:
      'Judge-training material addressing preparation and authenticity assessment of older Ferraris.',
    notes: 'No publication date or version established from the document extraction.',
  },
  'semiar-for-judges-2026-2': {
    display_title: 'Tenth Annual Seminar for Judges: Judging Challenges - Old and New',
    publication_date: '2026-02-13',
    effective_year: 2026,
    source_organization: 'IAC/PFA',
    display_description:
      'Judge-training seminar addressing judging challenges involving older and newer Ferraris.',
    notes: 'Filename misspells "Seminar". Judge-facing title is corrected; the file itself is not renamed.',
  },
  'as-built-checklist-for-ferrari-330-gtc-gts-version-9': {
    display_title: 'As-Built Checklist for Ferrari 330 GTC/GTS',
    document_version: '9',
    version_normalized: '9',
    effective_year: 2025,
    source_organization: 'IAC/PFA',
    display_description:
      'Checklist of important configuration items used to assess original 330 GTC/GTS build specification.',
    notes: 'Document states edition February 2025. No exact day stated, so publication_date remains null.',
  },
  '458-italia-carrozzeria-scaglietti-july-2010': {
    display_title: '458 Italia Carrozzeria Scaglietti Personalization Programme',
    document_version: 'July 2010',
    effective_year: 2010,
    source_organization: 'Ferrari S.p.A.',
    display_description:
      'Factory personalization programme documenting available 458 Italia configuration and personalization options.',
  },
  '458-italia-carrozzeria-sacglietti-jan-2011': {
    display_title: '458 Italia Carrozzeria Scaglietti Personalization Programme',
    document_version: 'January 2011',
    effective_year: 2011,
    source_organization: 'Ferrari S.p.A.',
    display_description: 'Updated factory personalization programme for the 458 Italia.',
    notes: 'Filename misspells "Scaglietti" as "Sacglietti". Judge-facing title is corrected; '
         + 'the PDF filename and source_path are deliberately left unchanged.',
  },
  'f430-sp': {
    display_title: 'Ferrari F430 Spare Parts Catalogue',
    source_organization: 'Ferrari S.p.A.',
    display_description:
      'Factory parts catalogue identifying F430 components, assemblies and part numbers.',
  },
  'owners-manual-430-scuderia-eng': {
    display_title: "Ferrari 430 Scuderia Owner's Manual",
    source_organization: 'Ferrari S.p.A.',
    display_description:
      "Factory owner's manual covering operation, safety, maintenance and vehicle systems for the 430 Scuderia.",
  },
  'f8-tributo-communication': {
    display_title: 'Ferrari F8 Tributo Personalization Programme',
    document_version: 'March 2019',
    effective_year: 2019,
    source_organization: 'Ferrari S.p.A.',
    display_description:
      'Factory personalization programme for F8 Tributo equipment, finishes and configuration options.',
    notes: 'Document states March 2019. The filename timestamp (2019_10_05) is an export artifact and was not used.',
  },
  'gtc4-lusso-t': {
    display_title: 'Ferrari GTC4Lusso T Product Information',
    document_version: 'September 2016',
    effective_year: 2016,
    source_organization: 'Ferrari S.p.A.',
    display_description: 'Factory product information for the GTC4Lusso T.',
    notes: 'Document states September 2016, resolving the ambiguous 26_09_16 filename token as DD_MM_YY.',
  },
};

// Inherited entries keep production metadata, except where the curator has
// explicitly overridden a field after reading the document.
const RETAIN_INHERITED = [
  'ferrari-330-gtc-gts-as-built-configuration-and-judging-notes-document-version-8',
  'ferrari-330-gtc-gts-concours-judging-checklist-ver-1',
  'ferrari-iac-pfa-judging-guidelines',
];

// Curator overrides applied ON TOP of inherited metadata. Production's own
// source-index.json is NOT changed by this; the override is Batch 1 only.
const INHERIT_OVERRIDES = {
  'ferrari-330-gtc-gts-as-built-configuration-and-judging-notes-document-version-8': {
    publication_date: null,
    _reason: 'The document states only "July 2023". Production records 2023-07-01; that day is '
           + 'not stated in the source, so Batch 1 carries null and retains effective_year 2023.',
  },
};

const CURATOR_FIELDS = ['display_title', 'document_version', 'publication_date',
  'effective_year', 'source_organization', 'display_description'];

const changes = [];
let applied = 0, retained = 0, overridden = 0;

for (const doc of idx.documents) {
  if (RETAIN_INHERITED.includes(doc.document_id)) {
    retained++;
    const ov = INHERIT_OVERRIDES[doc.document_id];
    if (ov) {
      const { _reason, ...fields } = ov;
      for (const [f, v] of Object.entries(fields)) doc[f] = v;
      // Provenance must stop claiming these fields were inherited, or the record
      // would assert a source it no longer reflects.
      const p = doc._field_provenance;
      p.inherited_fields = (p.inherited_fields || []).filter(f => !(f in fields));
      p.curator_overrides = Object.keys(fields);
      p.override_reason = _reason;
      doc.notes = (doc.notes ? doc.notes + ' ' : '') + _reason;
      overridden++;
    }
    // The checklist's own date is not established. The July 2023 date it references
    // belongs to the As-Built document it indexes into, not to the checklist itself.
    if (doc.document_id.includes('checklist-ver-1')) {
      doc.notes = (doc.notes ? doc.notes + ' ' : '')
        + 'Publication date and effective year are not established for the checklist itself. '
        + 'The July 2023 date it cites belongs to the referenced As-Built v8.0 document.';
    }
    continue;
  }

  const key = Object.keys(DECISIONS).find(k => doc.document_id.includes(k));
  if (!key) { changes.push(`  !! no decision matched ${doc.document_id}`); continue; }

  const dec = DECISIONS[key];
  for (const [field, value] of Object.entries(dec)) {
    if (field === 'notes') { doc.notes = doc.notes ? `${doc.notes} ${value}` : value; continue; }
    doc[field] = value;
  }
  doc._field_provenance.document_derived = Object.keys(dec).filter(f => f !== 'notes');
  applied++;
}

// Resolve bookkeeping: candidates that the curator has now settled, and todo lists.
let candidatesCleared = 0;
for (const doc of idx.documents) {
  if (doc._curator_candidates) { delete doc._curator_candidates; candidatesCleared++; }
  delete doc._derivation_refused;

  const outstanding = CURATOR_FIELDS.filter(f => doc[f] == null);
  if (outstanding.length) doc._curator_todo = outstanding;
  else delete doc._curator_todo;
}

idx._comment = [
  'CURATOR-OWNED INPUT (Addendum A.2 Tier 2, A.8).',
  'Metadata was read from the documents themselves via scripts/extract-title-pages.mjs and',
  'confirmed by the curator. No value is derived from a filename. Where a document states only',
  'a month and year, publication_date is null and only effective_year is set — a first-of-month',
  'placeholder would be a fabricated date. Remaining nulls are genuinely unstated in the sources.',
];
idx.last_updated = new Date().toISOString().slice(0, 10);

if (CHECK) {
  console.log('--check: no file written');
} else {
  writeFileSync(TARGET, JSON.stringify(idx, null, 2));
}

console.log(`applied document-derived metadata: ${applied}`);
console.log(`retained inherited metadata:       ${retained}`);
console.log(`curator overrides on inherited:    ${overridden}`);
console.log(`candidate blocks cleared:          ${candidatesCleared}`);
changes.forEach(c => console.log(c));
