/**
 * Protected source delivery - Addendum A.7.
 *
 * Session-authenticated, function-proxied. The client never supplies a filesystem
 * path; it supplies a document_id that must resolve through the approved manifest.
 * The page parameter controls navigation only and cannot change what is authorized.
 *
 * Viewing a source is NOT an AI operation: no OpenAI call, no file_search, no
 * regeneration of the answer.
 *
 * ROUTING: this function owns its own routes. A rewrite in netlify.toml cannot be
 * relied on to inject `document_id` into the query string the handler sees, because
 * `request.url` reflects the URL the browser asked for, not the rewrite target. The
 * identifiers are therefore read from the PATH first, then from framework-supplied
 * params, then from the query string - so the handler is correct under any of them.
 */
import { readFileSync } from 'node:fs';
import { requireSession } from '../../src/services/session.mjs';
import { corpus } from '../../src/services/corpus.mjs';

export const config = {
  path: ['/source/:documentId', '/source/:documentId/meta', '/source/:documentId/page/:page'],
};

const err = (msg, status, extra = {}) =>
  new Response(JSON.stringify({ error: msg, ...extra }), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Resolve the request target from the path, framework params, or query - in that
 * order of trust. Path segments are what the browser actually sent.
 */
export function resolveTarget(requestUrl, params = {}) {
  const url = new URL(requestUrl);
  const segments = url.pathname.split('/').filter(Boolean);

  let documentId = null, page = null, meta = false;

  // /source/:documentId[/meta | /page/:page]
  const i = segments.indexOf('source');
  if (i !== -1 && segments[i - 1] !== 'functions' && segments[i + 1]) {
    documentId = decodeURIComponent(segments[i + 1]);
    if (segments[i + 2] === 'meta') meta = true;
    else if (segments[i + 2] === 'page' && segments[i + 3] != null) page = segments[i + 3];
  }

  if (!documentId && params?.documentId) documentId = params.documentId;
  if (page == null && params?.page != null) page = params.page;

  // Query string last: only used when the path carried nothing (the
  // /.netlify/functions/source?document_id=... form).
  if (!documentId) documentId = url.searchParams.get('document_id');
  if (page == null) page = url.searchParams.get('page');
  if (!meta) meta = url.searchParams.get('meta') === '1';

  return { documentId, page, meta };
}

export default async (request, context) => {
  if (!requireSession(request)) return err('Not authenticated', 401);

  const { documentId, page: pageParam, meta } = resolveTarget(request.url, context?.params);

  if (!documentId) {
    // Never fail silently on a routing problem: report what arrived, without
    // exposing anything sensitive, so a misroute is diagnosable from the response.
    return err('No source document was identified in the request.', 400, {
      seen_path: new URL(request.url).pathname,
    });
  }

  const c = corpus('ferrari');
  const doc = c.docById.get(documentId);
  if (!doc || !doc.active || doc.redistribution_status !== 'approved') {
    return err('Unknown or inactive source document.', 404);
  }

  const page = pageParam != null && String(pageParam).trim() !== '' ? parseInt(pageParam, 10) : 1;
  if (!Number.isInteger(page) || page < 1 || page > doc.page_count) {
    return err(`Page out of range. This document has ${doc.page_count} page(s).`, 404);
  }

  if (meta) {
    return new Response(JSON.stringify({
      document_id: doc.document_id, display_title: doc.display_title,
      document_version: doc.document_version, page_count: doc.page_count, page,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const bytes = readFileSync(c.slicePath(doc.document_id, page));
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${doc.document_id}-p${page}.pdf"`,
        'Cache-Control': 'private, max-age=600',
        'X-Source-Page': String(page),
        'X-Source-Page-Count': String(doc.page_count),
      },
    });
  } catch {
    return err('The source document page could not be opened.', 500);
  }
};
