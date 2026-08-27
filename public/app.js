/* Concours Judging Assistant - judge interface.
   No persistence: session context only (v1.0 §22). No conversational thread; each
   question is answered fresh within the active car context (A.12). Model text is
   inserted with textContent only - never as HTML (v1.0 §27). */

const APP_VERSION = '2.0.3';
console.info(`Concours Judging Assistant ${APP_VERSION}`);

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => { el.hidden = !on; };
const text = (el, s) => { el.textContent = s == null ? '' : String(s); };

/** Where Back goes from the source viewer. Pure and testable: a source opened from a
    citation returns to the answer; one opened from the library returns to the list. */
function nextViewOnBack(origin) { return origin === 'library' ? 'docs' : 'answer'; }

const state = {
  category: null,                                    // sticky for the session (A.9)
  car: { year: null, model: null, concours_class: null },
  lastAnswer: null,
  lastRequest: null,
  viewer: { documentId: null, page: 1, pageCount: 1, title: '', origin: 'answer' },
};

const api = async (url, options = {}) => {
  const res = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, body };
};

/* ---------------- Gate ---------------- */
async function enter() {
  const pw = $('password').value;
  show($('gateError'), false);
  $('enter').disabled = true;
  const { ok, body } = await api('/api/auth', { method: 'POST', body: JSON.stringify({ password: pw }) });
  $('enter').disabled = false;
  if (!ok) {
    text($('gateError'), body?.error || 'Could not sign in. Try again.');
    show($('gateError'), true);
    return;
  }
  $('password').value = '';
  show($('gate'), false);
  show($('app'), true);
}
$('enter').addEventListener('click', enter);
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });

/* ---------------- Category (sticky) ---------------- */
document.querySelectorAll('[data-category]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.category = btn.dataset.category;
    document.querySelectorAll('[data-category]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    text($('roleLabel'), `${state.category} judge`);
    show($('categoryPick'), false);
    show($('work'), true);
    $('carYear').focus();
  });
});

/* ---------------- Car context ---------------- */
function renderCar() {
  const { year, model, concours_class } = state.car;
  text($('carLabel'), model ? [year, 'Ferrari', model].filter(Boolean).join(' ') + (concours_class ? ` · ${concours_class}` : '') : 'No car selected');
  show($('classPick'), Boolean(model) && !concours_class);
  show($('newCar'), Boolean(model));
  show($('carEntry'), !model);
}

$('setCar').addEventListener('click', () => {
  const year = $('carYear').value.trim();
  const model = $('carModel').value.trim();
  show($('carError'), false);
  if (!model) {
    text($('carError'), 'Enter the model, for example 330 GTC.');
    show($('carError'), true);
    return;
  }
  state.car = { year: year || null, model, concours_class: null };
  renderCar();
  $('question').focus();
});

document.querySelectorAll('[data-class]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.car.concours_class = btn.dataset.class;
    renderCar();
  });
});

// New car clears car context, question and answer. Category persists (A.9).
$('newCar').addEventListener('click', () => {
  state.car = { year: null, model: null, concours_class: null };
  $('carYear').value = ''; $('carModel').value = ''; $('question').value = '';
  clearAnswer();
  show($('lastQuestion'), false);
  renderCar();
});

// New question clears the result but keeps the car.
$('newQuestion').addEventListener('click', () => {
  $('question').value = '';
  clearAnswer();
  $('question').focus();
});

function clearAnswer() {
  state.lastAnswer = null;
  show($('answerCard'), false);
  show($('nudge'), false);
}

/* ---------------- Ask ---------------- */
async function ask() {
  const question = $('question').value.trim();
  show($('nudge'), false);
  clearAnswer();

  if (!question) {
    text($('nudge'), 'Type a question first.');
    show($('nudge'), true);
    return;
  }

  const payload = {
    question,
    judging_category: state.category,
    car: state.car,
  };
  state.lastRequest = payload;

  $('ask').disabled = true;                     // prevents duplicate submits (v1.0 §26)
  show($('loading'), true);

  const { ok, body } = await api('/api/ask', { method: 'POST', body: JSON.stringify(payload) });

  show($('loading'), false);
  $('ask').disabled = false;

  if (!body) {
    renderAnswer({ status: 'ERROR', confidence_label: 'Could not complete the request', answer: 'The request could not be completed. Try again.', retry: true });
    return;
  }

  // The standalone-question guard returns an inline nudge, not an answer card (A.12).
  if (body.status === 'NEEDS_REPHRASE') {
    text($('nudge'), body.message);
    show($('nudge'), true);
    return;                                     // input stays populated for editing
  }

  if (body.status === 'MODEL_NOT_COVERED') {
    renderAnswer({ status: 'MODEL_NOT_COVERED', confidence_label: 'Model not covered', answer: body.message, sources: [] });
    return;
  }

  if (!ok && body.error) {
    renderAnswer({ status: 'ERROR', confidence_label: 'Could not complete the request', answer: body.error, retry: true });
    return;
  }

  text($('lastQuestion'), `Last question: ${question}`);
  show($('lastQuestion'), true);                // orientation only; never AI context
  renderAnswer(body);
}
$('ask').addEventListener('click', ask);
$('retry').addEventListener('click', ask);

/* ---------------- Answer rendering ---------------- */
function renderAnswer(a) {
  state.lastAnswer = a;

  text($('statusLabel'), a.confidence_label || a.status);
  text($('answerText'), a.answer || '');

  show($('specBlock'), Boolean(a.correct_specification));
  if (a.correct_specification) text($('specText'), a.correct_specification);

  show($('conflictBlock'), Boolean(a.conflict_note));
  if (a.conflict_note) text($('conflictText'), a.conflict_note);

  show($('reasonText'), Boolean(a.reason));
  if (a.reason) text($('reasonText'), a.reason);

  show($('judgeNote'), Boolean(a.judge_note));
  if (a.judge_note) text($('judgeNote'), a.judge_note);

  renderSources(a.sources || []);

  const warn = $('answerWarnings');
  warn.replaceChildren();
  (a.warnings || []).forEach(w => {
    const p = document.createElement('p');
    p.textContent = w;
    warn.appendChild(p);
  });
  show(warn, (a.warnings || []).length > 0);

  show($('retry'), Boolean(a.retry));
  show($('answerCard'), true);
  $('answerCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderSources(sources) {
  const wrap = $('sources');
  wrap.replaceChildren();

  sources.forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'stamp' + (s.page_verified ? '' : ' stamp--unverified');

    const badge = document.createElement('span');
    badge.className = 'stamp__page';
    // Status is carried in words, never colour alone (v1.0 §24).
    badge.textContent = s.page_verified ? `Verified · page ${s.page_number}` : 'Page not verified';
    btn.appendChild(badge);

    const title = document.createElement('span');
    title.className = 'stamp__title';
    title.textContent = s.display_title;
    btn.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'stamp__meta';
    meta.textContent = [
      s.document_version ? `Version ${s.document_version}` : null,
      s.section_title,
      s.also_contains_page ? `also contains page ${s.also_contains_page}` : null,
    ].filter(Boolean).join(' · ');
    btn.appendChild(meta);

    const go = document.createElement('span');
    go.className = 'stamp__go';
    go.textContent = s.page_verified ? 'View exact source' : 'Open document';
    btn.appendChild(go);

    btn.addEventListener('click', () => openSource(s.document_id, s.page_number || 1, s.display_title, 'answer'));
    wrap.appendChild(btn);
  });
}

/* ---------------- Source viewer ---------------- */
async function openSource(documentId, page, title, origin = 'answer') {
  const errEl = origin === 'library' ? $('docsError') : $('sourceError');
  show(errEl, false);

  // Metadata comes from a path-based route so no query parameter has to survive a
  // rewrite. A 200 carrying PDF bytes instead of JSON previously left body null and
  // threw here, which is why the viewer never appeared.
  const { ok, body } = await api(`/source/${encodeURIComponent(documentId)}/meta`);
  if (!ok || !body || typeof body.page_count !== 'number') {
    text(errEl, 'That source document could not be opened. Try again.');
    show(errEl, true);
    return false;
  }

  const pageCount = body.page_count;
  const target = Math.min(Math.max(parseInt(page, 10) || 1, 1), pageCount);
  state.viewer = { documentId, page: target, pageCount, title: title || body.display_title, origin };
  text($('viewerTitle'), state.viewer.title);
  paintViewer();
  show($('viewer'), true);
  return true;
}

function paintViewer() {
  const { documentId, page, pageCount } = state.viewer;
  const url = `/source/${encodeURIComponent(documentId)}/page/${page}`;
  $('viewerFrame').src = url;
  $('viewerOpen').href = url;
  text($('pageLabel'), `Page ${page} of ${pageCount}`);
  $('prevPage').disabled = page <= 1;
  $('nextPage').disabled = page >= pageCount;
}

$('prevPage').addEventListener('click', () => { if (state.viewer.page > 1) { state.viewer.page--; paintViewer(); } });
$('nextPage').addEventListener('click', () => { if (state.viewer.page < state.viewer.pageCount) { state.viewer.page++; paintViewer(); } });
// Back returns to the answer, which is untouched underneath (v1.0 §25).
$('viewerBack').addEventListener('click', () => {
  const back = nextViewOnBack(state.viewer.origin);
  show($('viewer'), false);
  $('viewerFrame').src = 'about:blank';
  // The answer card is untouched underneath; the library needs re-showing.
  if (back === 'docs') show($('docs'), true);
});

/* ---------------- Source documents ---------------- */
$('openSources').addEventListener('click', async () => {
  const { ok, body } = await api('/api/sources');
  if (!ok) return;
  const list = $('docsList');
  list.replaceChildren();
  (body.documents || []).forEach(d => {
    const card = document.createElement('div');
    card.className = 'doc';

    const h = document.createElement('p');
    h.className = 'doc__title';
    h.textContent = d.display_title;
    card.appendChild(h);

    const m = document.createElement('p');
    m.className = 'doc__meta';
    m.textContent = [d.source_organization, d.document_version ? `Version ${d.document_version}` : null, `${d.page_count} pages`].filter(Boolean).join(' · ');
    card.appendChild(m);

    if (d.display_description) {
      const p = document.createElement('p');
      p.className = 'doc__desc';
      p.textContent = d.display_description;
      card.appendChild(p);
    }

    const open = document.createElement('button');
    open.className = 'chip';
    open.textContent = 'Open document';
    open.addEventListener('click', async () => {
      // Hide the list only on success, so a failure can never dump the judge back
      // onto the main screen with no explanation.
      if (await openSource(d.document_id, 1, d.display_title, 'library')) show($('docs'), false);
    });
    card.appendChild(open);

    list.appendChild(card);
  });
  show($('docs'), true);
});
$('docsBack').addEventListener('click', () => show($('docs'), false));

/* ---------------- Boot ---------------- */
(async () => {
  const { body } = await api('/api/auth');
  if (body?.authenticated) { show($('gate'), false); show($('app'), true); }
  renderCar();
})();
