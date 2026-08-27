#!/usr/bin/env node
/**
 * Interface visibility regression - Stage 2 live issue #1.
 *
 * The HTML `hidden` attribute is applied by the user-agent stylesheet, which always
 * loses to author CSS regardless of specificity. So any author rule setting `display`
 * on an element the interface toggles with `hidden` keeps that element visible
 * forever - and every `show(el, false)` call against it silently does nothing.
 *
 * This test models that cascade over the real files. No browser, no dependencies.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const html = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const appjs = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
};

/* ---- parse the markup: which elements start hidden, and what classes do they carry ---- */
const elements = [];
for (const m of html.matchAll(/<(section|div|main|p|button|a)\b([^>]*)>/g)) {
  const attrs = m[2];
  const id = (attrs.match(/id="([^"]+)"/) || [])[1] || null;
  if (!id) continue;
  const classes = ((attrs.match(/class="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
  elements.push({ id, classes, hiddenAtLoad: /\shidden(\s|=|>|$)/.test(attrs) });
};
const byId = Object.fromEntries(elements.map(e => [e.id, e]));

/* ---- parse the stylesheet: which selectors set `display`, and is it !important ---- */
const displayRules = [];
for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const body = m[2];
  const decl = body.match(/(^|[;\s])display\s*:\s*([^;]+)/);
  if (!decl) continue;
  displayRules.push({ selector, value: decl[2].trim(), important: /!important/.test(decl[2]) });
}

const hiddenRule = displayRules.find(r => r.selector.includes('[hidden]'));

console.log('\n=== INTERFACE VISIBILITY ===\n');

check('a global [hidden] display rule exists', Boolean(hiddenRule), true);
check('it sets display:none', hiddenRule?.value.startsWith('none'), true);
// Without !important it would depend on source order, which is a trap for future edits.
check('it is !important, so source order cannot defeat it', hiddenRule?.important, true);

/* ---- the elements the interface actually toggles ---- */
const toggled = [...appjs.matchAll(/show\(\$\('([A-Za-z]+)'\)/g)].map(m => m[1]);
const toggledUnique = [...new Set(toggled)];
check('the toggled element set was found in app.js', toggledUnique.length > 0, true);

// Any toggled element whose classes carry a non-important display rule would be stuck
// visible if the global [hidden] rule were absent or non-important.
const atRisk = toggledUnique.filter(id => {
  const el = byId[id];
  if (!el) return false;
  return displayRules.some(r => !r.important &&
    (el.classes.some(c => new RegExp(`(^|[\\s,])\\.${c}(\\s|,|$)`).test(r.selector)) ||
     new RegExp(`(^|[\\s,])#${id}(\\s|,|$)`).test(r.selector)));
});
console.log(`      elements toggled by hidden: ${toggledUnique.length}; carrying a display rule: ${atRisk.length}`);
check('every toggled element with a display rule is neutralised by [hidden]',
  atRisk.length === 0 || (hiddenRule?.important === true && hiddenRule?.value.startsWith('none')), true);

// The specific elements behind the live fault.
for (const id of ['docs', 'viewer', 'loading', 'contextBar']) {
  const el = byId[id];
  check(`#${id} starts hidden in the markup`, el?.hiddenAtLoad, true);
}
check('#docs and #viewer share the .viewer class that caused the overlay',
  [byId.docs?.classes.includes('viewer'), byId.viewer?.classes.includes('viewer')], [true, true]);

/* ---- the intended first screen ---- */
check('#gate is NOT hidden at load, so an unauthenticated visit starts at the password screen',
  byId.gate?.hiddenAtLoad, false);
check('#app is hidden at load', byId.app?.hiddenAtLoad, true);

// .gate sets display:grid; hiding it after login must actually work.
check('the gate is hidden after a successful sign-in', /show\(\$\('gate'\),\s*false\)/.test(appjs), true);

/* ---- Source Documents remains reachable and dismissable ---- */
check('Source Documents opens from the main screen control', /openSources'\)\.addEventListener\('click'/.test(appjs), true);
check('its Back control hides the panel', /docsBack'\)\.addEventListener\('click',\s*\(\)\s*=>\s*show\(\$\('docs'\),\s*false\)\)/.test(appjs), true);
check('the source viewer Back control hides the viewer', /viewerBack'\)\.addEventListener/.test(appjs), true);

/* ---- version stamp ---- */
check('app version is stamped in the markup', /name="app-version" content="2\.0\.10"/.test(html), true);
check('app version is stamped in app.js', /APP_VERSION = '2\.0\.10'/.test(appjs), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
