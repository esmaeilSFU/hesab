// Shopping lists: a small notes-like tool, kept apart from the budget's numbers.
// Saved on this device (localStorage) and, when the budget is a Google Sheet, also in its "Lists" tab so
// everyone who shares the budget sees the same lists. Each list, section and item carries `u` (last
// changed, ms) and deletions leave a tombstone in `dead`, so two phones editing at once merge cleanly.
//
//   list    = { id, title, sections: [section], updated, u }
//   section = { id, title, items: [item], u }
//   item    = { id, text, done, u }

import { icon } from './icons.js';
import { esc } from './format.js';

const KEY = 'hesab.lists';
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

let data = load();
let openId = null;

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.lists)) { d.dead = d.dead || {}; return d; }
  } catch {}
  return { lists: [], dead: {} };
}
let saveTimer = null;
function save(now = false, { local = false } = {}) {
  clearTimeout(saveTimer);
  const write = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} };
  if (now) write(); else saveTimer = setTimeout(write, 250);
  if (!local) scheduleSync();
}
/** Marks a list (and any of its sections or items passed) as just changed. */
const touch = (l, ...nodes) => { const t = Date.now(); if (l) { l.updated = t; } nodes.forEach((n) => { if (n) n.u = t; }); };
/** Remembers that these ids were deleted, so a sync doesn't bring them back. */
const bury = (...nodes) => { const t = Date.now(); for (const n of nodes) { if (!n) continue; data.dead[n.id] = t; (n.sections || []).forEach((x) => bury(x)); (n.items || []).forEach((x) => bury(x)); } };

const byId = (id) => data.lists.find((l) => l.id === id);
const findItem = (l, itemId) => {
  for (const s of l.sections) { const i = s.items.findIndex((x) => x.id === itemId); if (i >= 0) return { s, i, item: s.items[i] }; }
  return null;
};
const counts = (l) => {
  const all = l.sections.flatMap((s) => s.items).filter((i) => i.text.trim());
  return { left: all.filter((i) => !i.done).length, done: all.filter((i) => i.done).length };
};

// ───────────────────────────── views

/** The Lists tab body. `header` is the app's page header so the tab looks like the others. */
export function view(header) {
  const l = openId && byId(openId);
  return `<div class="lists">${l ? detail(l) : overview(header)}</div>`;
}

function overview(header) {
  const lists = [...data.lists].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return `${header('Lists', remote ? 'Shopping & to-do · shared' : 'Shopping & to-do · on this phone')}
    ${lists.length ? `<div class="l-cards">${lists.map((l) => {
      const c = counts(l), total = c.left + c.done;
      return `<button class="card l-card" data-l="open" data-id="${l.id}">
        <span class="l-card-ic">${icon('cart', 22)}</span>
        <span class="l-card-main"><b>${esc(l.title || 'Untitled list')}</b>
          <small>${total ? `${c.left} to get${c.done ? ` · ${c.done} done` : ''}` : 'Empty'}${l.sections.length > 1 ? ` · ${l.sections.length} sections` : ''}</small>
          ${total ? `<span class="l-prog"><i style="width:${((100 * c.done) / total).toFixed(1)}%"></i></span>` : ''}</span>
        ${icon('right', 16)}
      </button>`;
    }).join('')}</div>`
    : `<section class="card l-empty">${icon('cart', 34)}<b>No lists yet</b><p>Make a shopping list, split it into sections like Produce or Costco, and tick things off as you go.</p></section>`}
    <button class="primary l-new" data-l="new">${icon('plus', 18, 2.4)} New list</button>
    <div class="l-foot">
      ${lists.length ? `<button class="txt-btn" data-l="backup">Back up lists</button>` : ''}
      <label class="txt-btn">Restore lists<input type="file" data-l-file accept=".json,application/json" hidden></label>
    </div>
    <p class="hint center">${remote ? `Saved in your budget sheet${remote.canWrite ? '' : ' (view only)'}, so everyone who shares the budget sees the same lists.` : 'Lists are kept on this phone only. Back them up before changing phones.'}</p>`;
}

function detail(l) {
  const c = counts(l);
  return `<div class="l-top">
      <button class="l-back" data-l="back" aria-label="All lists">${icon('left', 20, 2.4)}<span>Lists</span></button>
      <span class="muted">${c.left} to get${c.done ? ` · ${c.done} done` : ''}</span>
    </div>
    <input class="l-title" data-f="title" value="${esc(l.title)}" placeholder="List name" maxlength="60" enterkeyhint="next" aria-label="List name">
    ${l.sections.map((s) => section(l, s)).join('')}
    <button class="ghost l-addsec" data-l="addSection">${icon('plus', 18, 2.4)} Add section</button>
    <div class="l-foot">
      ${c.done ? `<button class="txt-btn" data-l="clearDone">Remove ${c.done} done</button><button class="txt-btn" data-l="uncheck">Uncheck all</button>` : ''}
      <button class="txt-btn bad" data-l="deleteList">Delete list</button>
    </div>`;
}

function section(l, s) {
  const items = [...s.items.filter((i) => !i.done), ...s.items.filter((i) => i.done)];
  const multi = l.sections.length > 1 || s.title;
  return `<section class="card l-sec" data-sec="${s.id}">
    <div class="l-sec-h">
      <input class="l-sec-t" data-f="section" data-sec="${s.id}" value="${esc(s.title)}" placeholder="${multi ? 'Section name' : 'Add a section name (optional)'}" maxlength="40" enterkeyhint="next" aria-label="Section name">
      ${l.sections.length > 1 ? `<button class="l-x" data-l="delSection" data-sec="${s.id}" aria-label="Delete section">${icon('trash', 17)}</button>` : ''}
    </div>
    <ul class="l-items">${items.map((i) => `<li class="l-item ${i.done ? 'done' : ''}" data-item="${i.id}">
      <button class="l-check" data-l="toggle" data-item="${i.id}" aria-label="${i.done ? 'Mark as not done' : 'Mark as done'}">${i.done ? icon('check', 14, 3) : ''}</button>
      <input class="l-text" data-f="item" data-item="${i.id}" value="${esc(i.text)}" maxlength="120" enterkeyhint="next" aria-label="Item">
      <button class="l-x" data-l="delItem" data-item="${i.id}" aria-label="Delete item">${icon('close', 16, 2.2)}</button>
    </li>`).join('')}
      <li class="l-item l-add">
        <span class="l-check add">${icon('plus', 14, 2.6)}</span>
        <input class="l-text" data-f="add" data-sec="${s.id}" placeholder="Add item" maxlength="120" enterkeyhint="done" aria-label="Add item">
      </li>
    </ul>
  </section>`;
}

// ───────────────────────────── behaviour

let rerender = () => {};
/** Wires up the Lists tab once. `onChange` re-renders the app's view. */
export function init(onChange) {
  rerender = onChange;
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKey);
  document.addEventListener('paste', onPaste);
  document.addEventListener('focusout', onBlur);
}
export const isOpen = () => !!(openId && byId(openId));
export function close() { openId = null; }

/** Re-render, keep the scroll position, then focus a field if asked. */
function redraw(focusSel = null, caretEnd = true) {
  const y = window.scrollY;
  rerender();
  window.scrollTo(0, y);
  if (focusSel) {
    const el = document.querySelector(`.lists ${focusSel}`);
    if (el) { el.focus({ preventScroll: true }); if (caretEnd) { const n = el.value.length; el.setSelectionRange?.(n, n); } el.scrollIntoView({ block: 'nearest' }); }
  }
}

function onClick(ev) {
  const b = ev.target.closest('.lists [data-l]');
  if (!b) return;
  const l = openId && byId(openId);
  switch (b.dataset.l) {
    case 'open': openId = b.dataset.id; redraw(); window.scrollTo(0, 0); break;
    case 'back': cleanup(l); openId = null; save(true); redraw(); window.scrollTo(0, 0); break;
    case 'new': {
      const t = Date.now();
      const nl = { id: uid(), title: '', sections: [{ id: uid(), title: '', items: [], u: t }], updated: t, u: t };
      data.lists.push(nl); openId = nl.id; save(true); redraw('.l-title'); window.scrollTo(0, 0);
      break;
    }
    case 'toggle': {
      const f = l && findItem(l, b.dataset.item); if (!f) return;
      f.item.done = !f.item.done; touch(l, f.item); save(); redraw();
      break;
    }
    case 'delItem': {
      const f = l && findItem(l, b.dataset.item); if (!f) return;
      bury(f.item); f.s.items.splice(f.i, 1); touch(l); save(); redraw();
      break;
    }
    case 'addSection': {
      const s = { id: uid(), title: '', items: [], u: Date.now() };
      l.sections.push(s); touch(l); save(); redraw(`[data-f="section"][data-sec="${s.id}"]`);
      break;
    }
    case 'delSection': {
      const i = l.sections.findIndex((s) => s.id === b.dataset.sec); if (i < 0) return;
      const s = l.sections[i], n = s.items.filter((x) => x.text.trim()).length;
      if (n && !confirm(`Delete “${s.title || 'this section'}” and its ${n} item${n === 1 ? '' : 's'}?`)) return;
      bury(s); l.sections.splice(i, 1); touch(l); save(); redraw();
      break;
    }
    case 'clearDone':
      l.sections.forEach((s) => { s.items.filter((i) => i.done).forEach((i) => bury(i)); s.items = s.items.filter((i) => !i.done); }); touch(l); save(); redraw();
      break;
    case 'uncheck':
      l.sections.forEach((s) => s.items.forEach((i) => { if (i.done) { i.done = false; touch(null, i); } })); touch(l); save(); redraw();
      break;
    case 'backup': {
      const text = JSON.stringify({ app: 'hesab-lists', version: 1, exportedAt: new Date().toISOString(), lists: data.lists }, null, 1);
      const name = `hesab-lists-${new Date().toISOString().slice(0, 10)}.json`;
      const file = new File([text], name, { type: 'application/json' });
      if (/iPhone|iPad|iPod|Android/.test(navigator.userAgent) && navigator.canShare?.({ files: [file] })) navigator.share({ files: [file], title: name }).catch(() => {});
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
      break;
    }
    case 'deleteList':
      if (!confirm(`Delete “${l.title || 'this list'}”? This can't be undone.`)) return;
      bury(l); data.lists = data.lists.filter((x) => x.id !== l.id); openId = null; save(true); redraw(); window.scrollTo(0, 0);
      break;
  }
}

// Typing saves straight away without redrawing, so the keyboard stays open.
function onInput(ev) {
  const el = ev.target.closest('.lists [data-f]');
  const l = el && openId && byId(openId);
  if (!l) return;
  const f = el.dataset.f;
  if (f === 'title') { l.title = el.value; touch(l, l); }
  else if (f === 'section') { const s = l.sections.find((x) => x.id === el.dataset.sec); if (s) { s.title = el.value; touch(l, s); } }
  else if (f === 'item') { const it = findItem(l, el.dataset.item); if (it) { it.item.text = el.value; touch(l, it.item); } }
  else return;
  save();
}

function addItems(l, secId, texts, focusAfter = true) {
  const s = l.sections.find((x) => x.id === secId); if (!s) return;
  const clean = texts.map((t) => t.replace(/^\s*[-*•·\d.)\]]*\s*(\[[ x]\]\s*)?/i, '').trim()).filter(Boolean);
  if (!clean.length) return;
  // new items go after the unticked ones, before the ticked ones
  let at = 0;
  s.items.forEach((i, k) => { if (!i.done) at = k + 1; });
  const t = Date.now();
  s.items.splice(at, 0, ...clean.map((text) => ({ id: uid(), text, done: false, u: t })));
  touch(l); save();
  redraw(focusAfter ? `[data-f="add"][data-sec="${secId}"]` : null);
}

function onKey(ev) {
  const el = ev.target.closest('.lists [data-f]');
  const l = el && openId && byId(openId);
  if (!l) return;
  const f = el.dataset.f;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    if (f === 'add') { if (el.value.trim()) addItems(l, el.dataset.sec, [el.value]); else el.blur(); return; }
    if (f === 'title') { document.querySelector('.lists [data-f="section"], .lists [data-f="add"]')?.focus(); return; }
    if (f === 'section') { document.querySelector(`.lists [data-f="add"][data-sec="${el.dataset.sec}"]`)?.focus(); return; }
    if (f === 'item') { const it = findItem(l, el.dataset.item); if (it) document.querySelector(`.lists [data-f="add"][data-sec="${it.s.id}"]`)?.focus(); }
    return;
  }
  // Backspace in an empty item deletes it and moves to the one above, like the Notes app.
  if (ev.key === 'Backspace' && f === 'item' && el.value === '') {
    ev.preventDefault();
    const it = findItem(l, el.dataset.item); if (!it) return;
    const prev = it.s.items[it.i - 1];
    bury(it.item); it.s.items.splice(it.i, 1); touch(l); save();
    redraw(prev ? `[data-f="item"][data-item="${prev.id}"]` : `[data-f="add"][data-sec="${it.s.id}"]`);
  }
}

// Pasting several lines into "Add item" adds one item per line.
function onPaste(ev) {
  const el = ev.target.closest('.lists [data-f="add"]');
  const l = el && openId && byId(openId);
  if (!l) return;
  const text = ev.clipboardData?.getData('text') || '';
  if (!/\n/.test(text.trim())) return;
  ev.preventDefault();
  addItems(l, el.dataset.sec, [el.value, ...text.split(/\r?\n/)]);
}

// An item whose text was erased is removed when you leave it.
function onBlur(ev) {
  const el = ev.target.closest?.('.lists [data-f="item"]');
  const l = el && openId && byId(openId);
  if (!l || el.value.trim()) return;
  const it = findItem(l, el.dataset.item); if (!it) return;
  setTimeout(() => {
    if (document.activeElement?.closest?.(`[data-item="${it.item.id}"]`)) return;
    const again = findItem(l, it.item.id);
    if (again && !again.item.text.trim()) { bury(again.item); again.s.items.splice(again.i, 1); touch(l); save(); redraw(); }
  }, 0);
}

/** Lists for a backup file, and restoring them (added to the lists already here; same list = replaced). */
export const exportData = () => data.lists;
export function importData(lists) {
  if (!Array.isArray(lists)) return 0;
  const clean = lists.filter((l) => l && typeof l === 'object').map((l) => ({
    id: String(l.id || uid()), title: String(l.title || '').slice(0, 60), updated: Number(l.updated) || Date.now(), u: Date.now(),
    sections: (Array.isArray(l.sections) ? l.sections : []).map((s) => ({
      id: String(s.id || uid()), title: String(s.title || '').slice(0, 40), u: Date.now(),
      items: (Array.isArray(s.items) ? s.items : []).map((i) => ({ id: String(i.id || uid()), text: String(i.text || '').slice(0, 120), done: !!i.done, u: Date.now() })),
    })),
  })).filter((l) => l.sections.length);
  for (const l of clean) {
    const i = data.lists.findIndex((x) => x.id === l.id);
    [l, ...l.sections, ...l.sections.flatMap((s) => s.items)].forEach((n) => delete data.dead[n.id]);
    if (i >= 0) data.lists[i] = l; else data.lists.push(l);
  }
  save(true);
  return clean.length;
}

document.addEventListener('change', async (ev) => {
  const input = ev.target.closest?.('[data-l-file]');
  if (!input) return;
  const file = input.files?.[0]; if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    const n = importData(j?.lists || j?.data?.lists);
    alert(n ? `Restored ${n} list${n === 1 ? '' : 's'}.` : 'No lists found in this file.');
    rerender();
  } catch { alert('This is not a Hesab lists backup.'); }
});

/** Leaving a list drops empty items and empty unnamed extra sections. */
function cleanup(l) {
  if (!l) return;
  l.sections.forEach((s) => { s.items.filter((i) => !i.text.trim()).forEach((i) => bury(i)); s.items = s.items.filter((i) => i.text.trim()); });
  if (l.sections.length > 1) {
    l.sections.filter((s, i) => !(i === 0 || s.title.trim() || s.items.length)).forEach((s) => bury(s));
    l.sections = l.sections.filter((s, i) => i === 0 || s.title.trim() || s.items.length);
  }
  if (!l.title.trim() && !counts(l).left && !counts(l).done) { bury(l); data.lists = data.lists.filter((x) => x.id !== l.id); }
}


// ───────────────────────────── sync with the budget sheet's "Lists" tab

let remote = null;              // { pull(): rows, push(rows), canWrite }
let syncing = false, again = false, syncTimer = null, redrawLater = false;

/** Turns sync on for a Google Sheet budget (or off with null). */
export function setRemote(r) { remote = r; if (r) scheduleSync(0); }
export function syncNow() { if (remote) scheduleSync(0); }
function scheduleSync(ms = 1200) { if (!remote) return; clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }

const DAY = 86400000;
function flatten(d) {
  const rows = [];
  d.lists.forEach((l, i) => {
    rows.push(['L', l.id, '', l.title, '', i, l.u || 0, '']);
    l.sections.forEach((s, j) => {
      rows.push(['S', s.id, l.id, s.title, '', j, s.u || 0, '']);
      s.items.forEach((it, k) => rows.push(['I', it.id, s.id, it.text, it.done ? 1 : 0, k, it.u || 0, '']));
    });
  });
  const old = Date.now() - 60 * DAY;
  for (const [id, t] of Object.entries(d.dead)) if (t > old) rows.push(['X', id, '', '', '', 0, t, 1]);
  return rows;
}
function unflatten(rows) {
  const nodes = new Map(), dead = {};
  for (const r of rows || []) {
    const [kind, id, parent, text, done, order, u] = r.map((x) => (x == null ? '' : x));
    if (!id) continue;
    if (kind === 'X') { dead[id] = Math.max(dead[id] || 0, Number(u) || 0); continue; }
    if (!'LSI'.includes(kind)) continue;
    nodes.set(String(id), { kind, id: String(id), parent: String(parent), text: String(text), done: done === 1 || done === '1' || done === true || done === 'TRUE', order: Number(order) || 0, u: Number(u) || 0 });
  }
  return { nodes, dead };
}
function merge(a, b) {
  const dead = { ...a.dead };
  for (const [id, t] of Object.entries(b.dead)) dead[id] = Math.max(dead[id] || 0, t);
  const nodes = new Map(a.nodes);
  for (const [id, n] of b.nodes) { const m = nodes.get(id); if (!m || n.u > m.u) nodes.set(id, n); }
  for (const [id, n] of nodes) if (dead[id] != null && dead[id] >= n.u) nodes.delete(id);
  return { nodes, dead };
}
function build({ nodes, dead }) {
  const all = [...nodes.values()];
  const sort = (x, y) => x.order - y.order || x.u - y.u;
  const kids = (kind, parent) => all.filter((n) => n.kind === kind && n.parent === parent).sort(sort);
  const old = Date.now() - 60 * DAY;
  return {
    dead: Object.fromEntries(Object.entries(dead).filter(([, t]) => t > old)),
    lists: all.filter((n) => n.kind === 'L').sort(sort).map((l) => {
      const prev = data.lists.find((x) => x.id === l.id);
      return {
        id: l.id, title: l.text, u: l.u, updated: Math.max(prev?.updated || 0, l.u),
        sections: kids('S', l.id).map((s) => ({ id: s.id, title: s.text, u: s.u, items: kids('I', s.id).map((i) => ({ id: i.id, text: i.text, done: i.done, u: i.u })) })),
      };
    }).filter((l) => l.sections.length),
  };
}
const sig = (rows) => JSON.stringify((rows || []).map((r) => Array.from({ length: 8 }, (_, i) => String(r[i] ?? ''))).sort());

async function sync() {
  if (!remote) return;
  if (syncing) { again = true; return; }
  syncing = true;
  try {
    const rows = await remote.pull();
    const before = flatten(data);
    const merged = build(merge(unflatten(before), unflatten(rows)));
    // Lists only this phone had (before sync was on) keep their place; nothing is lost.
    data = merged;
    save(true, { local: true });
    const after = flatten(data);
    if (remote.canWrite && sig(after) !== sig(rows)) await remote.push(after);
    if (sig(after) !== sig(before)) {
      if (document.activeElement?.closest?.('.lists')) redrawLater = true;
      else if (document.querySelector('.lists')) rerender();
    }
  } catch { /* offline or no access: try again on the next change or refresh */ }
  finally {
    syncing = false;
    if (again) { again = false; scheduleSync(300); }
  }
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (redrawLater && !document.activeElement?.closest?.('.lists')) { redrawLater = false; if (document.querySelector('.lists')) redraw(); }
}, 50));
