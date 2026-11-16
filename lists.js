// Shopping lists: a small notes-like tool, kept apart from the budget.
// Lists live only on this device (localStorage) and never touch entries, categories or the sheet.
//
//   list    = { id, title, sections: [section], updated }
//   section = { id, title, items: [item] }
//   item    = { id, text, done }

import { icon } from './icons.js';
import { esc } from './format.js';

const KEY = 'hesab.lists';
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

let data = load();
let openId = null;

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.lists)) return d;
  } catch {}
  return { lists: [] };
}
let saveTimer = null;
function save(now = false) {
  clearTimeout(saveTimer);
  const write = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} };
  if (now) write(); else saveTimer = setTimeout(write, 250);
}
const touch = (l) => { if (l) l.updated = Date.now(); };

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
  return `${header('Lists', 'Shopping & to-do · on this phone')}
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
    <p class="hint center">Lists are kept on this phone only. Back them up before changing phones.</p>`;
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
      const nl = { id: uid(), title: '', sections: [{ id: uid(), title: '', items: [] }], updated: Date.now() };
      data.lists.push(nl); openId = nl.id; save(true); redraw('.l-title'); window.scrollTo(0, 0);
      break;
    }
    case 'toggle': {
      const f = l && findItem(l, b.dataset.item); if (!f) return;
      f.item.done = !f.item.done; touch(l); save(); redraw();
      break;
    }
    case 'delItem': {
      const f = l && findItem(l, b.dataset.item); if (!f) return;
      f.s.items.splice(f.i, 1); touch(l); save(); redraw();
      break;
    }
    case 'addSection': {
      const s = { id: uid(), title: '', items: [] };
      l.sections.push(s); touch(l); save(); redraw(`[data-f="section"][data-sec="${s.id}"]`);
      break;
    }
    case 'delSection': {
      const i = l.sections.findIndex((s) => s.id === b.dataset.sec); if (i < 0) return;
      const s = l.sections[i], n = s.items.filter((x) => x.text.trim()).length;
      if (n && !confirm(`Delete “${s.title || 'this section'}” and its ${n} item${n === 1 ? '' : 's'}?`)) return;
      l.sections.splice(i, 1); touch(l); save(); redraw();
      break;
    }
    case 'clearDone':
      l.sections.forEach((s) => { s.items = s.items.filter((i) => !i.done); }); touch(l); save(); redraw();
      break;
    case 'uncheck':
      l.sections.forEach((s) => s.items.forEach((i) => { i.done = false; })); touch(l); save(); redraw();
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
      data.lists = data.lists.filter((x) => x.id !== l.id); openId = null; save(true); redraw(); window.scrollTo(0, 0);
      break;
  }
}

// Typing saves straight away without redrawing, so the keyboard stays open.
function onInput(ev) {
  const el = ev.target.closest('.lists [data-f]');
  const l = el && openId && byId(openId);
  if (!l) return;
  const f = el.dataset.f;
  if (f === 'title') l.title = el.value;
  else if (f === 'section') { const s = l.sections.find((x) => x.id === el.dataset.sec); if (s) s.title = el.value; }
  else if (f === 'item') { const it = findItem(l, el.dataset.item); if (it) it.item.text = el.value; }
  else return;
  touch(l); save();
}

function addItems(l, secId, texts, focusAfter = true) {
  const s = l.sections.find((x) => x.id === secId); if (!s) return;
  const clean = texts.map((t) => t.replace(/^\s*[-*•·\d.)\]]*\s*(\[[ x]\]\s*)?/i, '').trim()).filter(Boolean);
  if (!clean.length) return;
  // new items go after the unticked ones, before the ticked ones
  const firstDone = s.items.findIndex((i) => i.done);
  const at = firstDone < 0 ? s.items.length : firstDone;
  s.items.splice(at, 0, ...clean.map((text) => ({ id: uid(), text, done: false })));
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
    it.s.items.splice(it.i, 1); touch(l); save();
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
    if (again && !again.item.text.trim()) { again.s.items.splice(again.i, 1); touch(l); save(); redraw(); }
  }, 0);
}

/** Lists for a backup file, and restoring them (added to the lists already here; same list = replaced). */
export const exportData = () => data.lists;
export function importData(lists) {
  if (!Array.isArray(lists)) return 0;
  const clean = lists.filter((l) => l && typeof l === 'object').map((l) => ({
    id: String(l.id || uid()), title: String(l.title || '').slice(0, 60), updated: Number(l.updated) || Date.now(),
    sections: (Array.isArray(l.sections) ? l.sections : []).map((s) => ({
      id: String(s.id || uid()), title: String(s.title || '').slice(0, 40),
      items: (Array.isArray(s.items) ? s.items : []).map((i) => ({ id: String(i.id || uid()), text: String(i.text || '').slice(0, 120), done: !!i.done })),
    })),
  })).filter((l) => l.sections.length);
  for (const l of clean) { const i = data.lists.findIndex((x) => x.id === l.id); if (i >= 0) data.lists[i] = l; else data.lists.push(l); }
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
  l.sections.forEach((s) => { s.items = s.items.filter((i) => i.text.trim()); });
  if (l.sections.length > 1) l.sections = l.sections.filter((s, i) => i === 0 || s.title.trim() || s.items.length);
  if (!l.title.trim() && !counts(l).left && !counts(l).done) data.lists = data.lists.filter((x) => x.id !== l.id);
}
