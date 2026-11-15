import { Engine, WEEKS, todayISO, kindOf, isIncome, isVariable, isFixed } from './engine.js';
import { Api } from './api.js';
import { demoSnapshot } from './demo.js';
import { starterSnapshot, loadLocal, saveLocal, clearLocal, newId, toCSV, importCSV, toBackup, fromBackup, saveFile } from './data.js';
import { money, compact, shortDate, dayTitle, weekRange, esc, catStyle } from './format.js';
import { icon } from './icons.js';
import * as chart from './charts.js';
import * as install from './install.js';
import * as g from './google.js';
import * as track from './track.js';

// ───────────────────────────────────────────── state
//
// Where the data can live:
//   local  — on this device (default, free, no account)
//   google — a Google Sheet in the user's Drive, signed in with Google
//   sheet  — a Google Sheet through the user's own Apps Script link (advanced)
//   demo   — sample data, never saved

const LS = { mode: 'hesab.mode', url: 'hesab.url', token: 'hesab.token', cache: 'hesab.snapshot', synced: 'hesab.synced', queue: 'hesab.queue' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const state = {
  snapshot: null,
  engine: null,
  tab: 'week',
  week: 1,
  block: 1,
  month: 0,
  insights: 'week',
  filter: 'all',
  search: '',
  syncing: false,
  synced: store.get(LS.synced),
};

const mode = () => store.get(LS.mode);
const isDemo = () => mode() === 'demo';
const isLocal = () => mode() === 'local';
const isGoogle = () => mode() === 'google';
const isRemote = () => mode() === 'sheet' || isGoogle();
const canEditCategories = () => isLocal() || isDemo() || (isGoogle() && !!state.snapshot?.sheet?.template);
/** Monthly plans live in Budget column C; the legacy Apps Script backend can't write them. */
const canEditPlans = () => mode() !== 'sheet';
const MAX_SPENDING_CATS = 30; // the sheet's report tabs hold up to 30 spending categories

let sheetsClient = null;
const api = () => {
  if (isGoogle()) {
    const sh = g.chosenSheet();
    if (!sh) return null;
    if (!sheetsClient || sheetsClient.id !== sh.id) sheetsClient = new g.SheetsClient(sh);
    return sheetsClient;
  }
  if (mode() !== 'sheet') return null;
  const url = store.get(LS.url), token = store.get(LS.token);
  return url && token ? new Api(url, token) : null;
};

function setSnapshot(snap, { keepWeek = false } = {}) {
  const wasCurrent = state.engine && state.week === state.engine.currentWeek;
  state.snapshot = snap;
  state.engine = new Engine(snap);
  if (!keepWeek || wasCurrent || !state.week) state.week = state.engine.currentWeek;
  state.block = state.engine.blockOf(state.week);
  if (!keepWeek || !state.month) state.month = state.engine.currentMonth;
  if (isRemote()) store.set(LS.cache, JSON.stringify(snap));
  if (isLocal() && !saveLocal(snap)) toast('Storage is full. Export a backup in Settings.', 'bad');
}

const categories = () => [...(state.snapshot?.categories || [])].sort((a, b) => a.order - b.order);
const catByName = (n) => categories().find((c) => c.name === n);

function useMode(m, snap) {
  const prev = mode();
  store.set(LS.mode, m);
  if (m !== 'sheet') [LS.url, LS.token].forEach((k) => store.set(k, null));
  if (m !== 'google' && prev === 'google') { g.signOut(); sheetsClient = null; }
  if (!isRemote()) { [LS.cache, LS.synced, LS.queue].forEach((k) => store.set(k, null)); state.synced = null; }
  setSnapshot(snap);
  render();
  if (prev !== m) track.event('mode-' + m, m);
}

// ───────────────────────────────────────────── offline queue (Google mode)
//
// Changes made while signed out or offline are kept on the phone and sent later.

const queue = {
  all() { try { return JSON.parse(store.get(LS.queue)) || []; } catch { return []; } },
  save(q) { store.set(LS.queue, q.length ? JSON.stringify(q) : null); },
  push(op) {
    let q = this.all();
    // An edit or delete of an entry that was never sent just changes the queued add.
    const pendingAdd = op.tx && q.find((o) => o.kind === 'add' && o.tempId === op.tx.id);
    if (pendingAdd && op.kind === 'update') pendingAdd.entry = op.entry;
    else if (pendingAdd && op.kind === 'delete') q = q.filter((o) => o !== pendingAdd);
    else q.push(op);
    this.save(q);
  },
};
const pendingCount = () => queue.all().length;

/** Runs one change against the server and returns a function that applies the server's answer locally. */
async function runOp(client, op) {
  switch (op.kind) {
    case 'add': { const saved = await client.add(op.entry); return (s) => { const i = s.transactions.findIndex((t) => t.id === op.tempId); if (i >= 0) s.transactions[i] = saved; }; }
    case 'update': { const saved = await client.update(op.tx, op.entry); return (s) => { const i = s.transactions.findIndex((t) => t.id === op.tx.id); if (i >= 0) s.transactions[i] = saved; }; }
    case 'delete': await client.remove(op.tx); return (s) => s.transactions.forEach((t) => { if (t.row > op.tx.row) t.row -= 1; });
    case 'budget': await client.setBudget(op.category, op.value); return null;
    case 'plan': await client.setPlan(op.category, op.value); return null;
    case 'categories': await client.saveCategories(state.snapshot, op.renames || {}); return null;
    default: return null;
  }
}

async function flushQueue() {
  const client = api();
  if (!client || !isGoogle() || !g.hasToken()) return false;
  let q = queue.all();
  while (q.length) {
    try {
      const apply = await runOp(client, q[0]);
      if (apply) apply(state.snapshot);
      q = q.slice(1); queue.save(q);
    } catch (e) {
      if (e.code === 'auth' || e.code === 'network') return false;
      toast(`Couldn't sync a change: ${e.message}`, 'bad');
      q = q.slice(1); queue.save(q);
    }
  }
  return true;
}

// ───────────────────────────────────────────── sync

async function refresh({ quiet = false } = {}) {
  if (!mode()) return;
  if (isLocal()) { const s = loadLocal(); if (s) setSnapshot(s, { keepWeek: true }); render(); return; }
  if (isDemo()) { if (!state.snapshot) setSnapshot(demoSnapshot()); render(); return; }
  const client = api();
  if (!client || state.syncing) return;
  if (isGoogle() && !g.hasToken()) { render(); return; }
  state.syncing = true; renderChrome();
  try {
    if (isGoogle()) await flushQueue();
    const snap = await client.bootstrap();
    setSnapshot(snap, { keepWeek: true });
    state.synced = new Date().toISOString();
    store.set(LS.synced, state.synced);
  } catch (e) {
    if (!quiet || !state.snapshot) toast(e.message, 'bad');
  } finally {
    state.syncing = false;
    render();
  }
}

async function mutate(optimistic, op, successMsg) {
  const before = structuredClone(state.snapshot);
  optimistic(state.snapshot);
  setSnapshot(state.snapshot, { keepWeek: true });
  render();
  const client = api();
  if (!client) { if (successMsg) toast(successMsg); return true; }
  if (isGoogle() && (!g.hasToken() || pendingCount())) {
    queue.push(op); render();
    toast(g.hasToken() ? 'Saved · syncing…' : 'Saved on this phone · sign in to sync');
    if (g.hasToken()) refresh({ quiet: true });
    return true;
  }
  try {
    const apply = await runOp(client, op);
    if (apply) { apply(state.snapshot); setSnapshot(state.snapshot, { keepWeek: true }); render(); }
    if (successMsg) toast(successMsg);
    return true;
  } catch (e) {
    if (isGoogle() && (e.code === 'auth' || e.code === 'network')) {
      queue.push(op); render();
      toast(e.code === 'auth' ? 'Saved on this phone · sign in to sync' : 'Saved on this phone · will sync when online');
      return true;
    }
    setSnapshot(before, { keepWeek: true });
    render();
    toast(e.message, 'bad');
    return false;
  }
}

function addEntry(entry) {
  const meta = catByName(entry.category) || {};
  const remote = !!api();
  const tempId = remote ? 'pending-' + Date.now() : newId();
  const temp = { row: remote ? -1 : 0, id: tempId, timestamp: new Date().toISOString(), date: entry.date, amount: entry.amount,
    type: meta.type || 'Expense', expenseType: meta.expenseType || '', category: entry.category, note: entry.note };
  return mutate((s) => s.transactions.push(temp), { kind: 'add', entry, tempId }, `Saved · ${entry.category} ${money(entry.amount)}`);
}

function updateEntry(tx, entry) {
  const meta = catByName(entry.category) || {};
  return mutate(
    (s) => { const t = s.transactions.find((x) => x.id === tx.id); Object.assign(t, entry, { type: meta.type || t.type, expenseType: meta.expenseType || t.expenseType }); },
    { kind: 'update', tx: structuredClone(tx), entry }, 'Updated',
  );
}

/** An entry that is being written to the sheet right now can't be changed until it lands. */
function stillSending(tx) {
  if (!tx || tx.row >= 0 || !String(tx.id).startsWith('pending-')) return false;
  if (queue.all().some((o) => o.kind === 'add' && o.tempId === tx.id)) return false;
  toast('Still saving this entry. Try again in a moment.', 'bad');
  return true;
}

function deleteEntry(tx) {
  return mutate((s) => { s.transactions = s.transactions.filter((t) => t.id !== tx.id); }, { kind: 'delete', tx: structuredClone(tx) }, 'Deleted');
}

function setTarget(category, value) {
  return mutate(
    (s) => { const b = s.budget.find((x) => x.category === category); if (b) b.weeklyTarget = value; else s.budget.push({ category, weeklyTarget: value, monthlyPlan: 0 }); },
    { kind: 'budget', category, value }, null,
  );
}

function setPlan(category, value) {
  return mutate(
    (s) => { const b = s.budget.find((x) => x.category === category); if (b) b.monthlyPlan = value; else s.budget.push({ category, weeklyTarget: 0, monthlyPlan: value }); },
    { kind: 'plan', category, value }, null,
  );
}

/** Category edits: on this device, or in a sheet that Hesab created (its Categories tab is rewritten). */
function syncCategories(renames = {}) {
  if (!isGoogle()) return;
  mutate(() => {}, { kind: 'categories', renames }, null);
}

function saveCategory(oldName, { name, kind, target, plan }) {
  const s = state.snapshot;
  name = name.trim();
  if (!name) return 'Give the category a name.';
  if (name !== oldName && s.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) return 'A category with that name already exists.';
  const spendingAfter = s.categories.filter((c) => c.name !== oldName && isVariable(c)).length + (kind === 'variable' ? 1 : 0);
  if (isGoogle() && spendingAfter > MAX_SPENDING_CATS) return `Your sheet's reports hold up to ${MAX_SPENDING_CATS} spending categories.`;
  const type = kind === 'income' ? 'Income' : 'Expense';
  const expenseType = kind === 'income' ? '' : kind === 'fixed' ? 'Fixed' : 'Variable';
  let cat = s.categories.find((c) => c.name === oldName);
  if (!cat) { cat = { order: Math.max(0, ...s.categories.map((c) => c.order)) + 1 }; s.categories.push(cat); }
  Object.assign(cat, { name, type, expenseType });
  for (const t of s.transactions) if (oldName && t.category === oldName) Object.assign(t, { category: name, type, expenseType });
  s.budget = s.budget.filter((b) => b.category !== oldName && b.category !== name);
  const weeklyTarget = kind === 'variable' ? Math.max(0, Number(target) || 0) : 0;
  const monthlyPlan = kind !== 'variable' ? Math.max(0, Number(plan) || 0) : 0;
  if (weeklyTarget || monthlyPlan || kind === 'variable') s.budget.push({ category: name, weeklyTarget, monthlyPlan });
  setSnapshot(s, { keepWeek: true });
  render();
  syncCategories(oldName && oldName !== name ? { [oldName]: name } : {});
  return null;
}

function deleteCategory(name, moveTo = null) {
  const s = state.snapshot;
  const target = moveTo && s.categories.find((c) => c.name === moveTo);
  if (target) {
    for (const t of s.transactions) if (t.category === name) Object.assign(t, { category: target.name, type: target.type, expenseType: target.expenseType });
  }
  s.categories = s.categories.filter((c) => c.name !== name);
  s.budget = s.budget.filter((b) => b.category !== name);
  setSnapshot(s, { keepWeek: true });
  render();
  syncCategories(target ? { [name]: target.name } : {});
}

// ───────────────────────────────────────────── Google: connect flows

/** Called after the user is signed in: pick an existing sheet, or create a new one. */
async function googleConnect(how) {
  if (!g.hasToken()) { g.signIn({ after: how }); return; }
  if (how === 'pick') { existingSheetChooser(); return; }
  try {
    const local = isLocal() && state.snapshot?.transactions.length ? state.snapshot : null;
    const starter = local ? structuredClone(local) : starterSnapshot();
    toast('Creating your Hesab sheet…');
    const sheet = await g.createSheet(starter);
    if (local && confirm(`Copy the ${local.transactions.length} entries on this phone into your new Google Sheet?`)) {
      const client = new g.SheetsClient(sheet);
      g.setChosenSheet(sheet);
      for (const t of [...local.transactions].sort((a, b) => (a.date < b.date ? -1 : 1))) {
        await client.add({ amount: t.amount, category: t.category, date: t.date, note: t.note });
      }
    }
    await connectTo(sheet);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

/** Opens a sheet Hesab has access to and switches the app to it. */
async function connectTo(sheet, { fromLink = false } = {}) {
  try {
    toast('Opening your sheet…');
    const snap = await new g.SheetsClient(sheet).bootstrap();
    g.setChosenSheet(sheet);
    sheetsClient = null;
    queue.save([]);
    useMode('google', snap);
    state.synced = new Date().toISOString(); store.set(LS.synced, state.synced);
    closeSheet(); render();
    toast(`Connected to “${snap.sheet.title}” · ${snap.transactions.length} entries`);
    return true;
  } catch (e) {
    if (e.code === 'access' && fromLink) {
      toast(g.pickerWorks()
        ? 'Hesab doesn\'t have access to that sheet yet. Use “Browse Google Drive” to choose it once.'
        : 'Hesab doesn\'t have access to that sheet yet. Choose it once on a computer (see below), then it shows up here.', 'bad');
    } else toast(e.message, 'bad');
    if (e.code === 'format') googleSheetChooser();
    return false;
  }
}

/** Existing sheet: sheets Hesab can already open, a pasted link, or Google's Drive picker where it works. */
function existingSheetChooser() {
  const canBrowse = g.pickerWorks();
  openSheet(`
    <div class="sheet-h"><button class="txt-btn" id="gBack">Back</button><b>Your sheet</b><button class="txt-btn" data-close>Cancel</button></div>
    <div class="sheet-scroll">
      <h3 class="grp">Sheets Hesab can open</h3>
      <div class="card src-list" id="gList"><p class="empty">Looking in your Drive…</p></div>
      <h3 class="grp">Paste a sheet link</h3>
      <div class="share-row"><input class="share-url" id="gLink" type="url" inputmode="url" placeholder="https://docs.google.com/spreadsheets/d/…" aria-label="Google Sheet link"><button class="ghost" id="gOpen">Open</button></div>
      ${canBrowse
        ? '<button class="ghost" id="gBrowse">Browse Google Drive</button>'
        : `<p class="hint">Don’t see your sheet? On a computer, open <b>${esc(location.host + location.pathname)}</b>, sign in with the same Google account and choose it under <b>Use a sheet I already have → Browse Google Drive</b>. It will then appear in this list on your phone. (iPhone Safari blocks Google’s file browser.)</p>`}
    </div>`, {
    cls: 'tall',
    async onMount(wrap) {
      $('#gBack', wrap).addEventListener('click', () => googleSheetChooser());
      $('#gOpen', wrap).addEventListener('click', () => {
        const id = g.sheetIdFromLink($('#gLink', wrap).value);
        if (!id) { toast('That doesn’t look like a Google Sheets link.', 'bad'); return; }
        connectTo({ id, name: 'Google Sheet' }, { fromLink: true });
      });
      $('#gBrowse', wrap)?.addEventListener('click', async () => {
        try { const sheet = await g.pickSheet(); if (sheet) connectTo(sheet); } catch (e) { toast(e.message, 'bad'); }
      });
      const list = $('#gList', wrap);
      try {
        const files = await g.listAppSheets();
        list.innerHTML = files.length
          ? files.map((f) => `<button class="src" data-id="${esc(f.id)}" data-name="${esc(f.name)}"><span class="src-ic">${icon('list', 20)}</span><span class="src-t"><b>${esc(f.name)}</b><small>Edited ${esc(shortDate(f.modified.slice(0, 10)))}</small></span>${icon('right', 16)}</button>`).join('')
          : '<p class="empty">No sheets yet. Create one, paste a link, or choose one in Google Drive.</p>';
        list.querySelectorAll('.src').forEach((b) => b.addEventListener('click', () => connectTo({ id: b.dataset.id, name: b.dataset.name })));
      } catch (e) {
        list.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
      }
    },
  });
}

function googleSheetChooser() {
  openSheet(`
    <div class="sheet-h"><span style="width:56px"></span><b>Google Sheet</b><button class="txt-btn" data-close>Cancel</button></div>
    <div class="install-hero"><span class="g-badge">${icon('sync', 30)}</span>
      <p>Your budget lives in a Google Sheet in <b>your</b> Drive and syncs across your devices. Hesab can only open the sheet you choose.</p></div>
    <button class="primary" id="gCreate">Create a new Hesab sheet</button>
    <button class="ghost" id="gPick">Use a sheet I already have</button>
    <p class="hint center">An existing sheet needs Ledger, Categories and Budget tabs.</p>`, {
    onMount(wrap) {
      $('#gCreate', wrap).addEventListener('click', () => googleConnect('create'));
      $('#gPick', wrap).addEventListener('click', () => googleConnect('pick'));
    },
  });
}

// ───────────────────────────────────────────── chrome

const $ = (s, el = document) => el.querySelector(s);
const view = () => $('#view');

function renderChrome() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  const s = $('#syncBtn');
  if (s) s.classList.toggle('spin', state.syncing);
}

function render() {
  document.body.classList.toggle('onboarding', !mode());
  if (!mode()) { view().innerHTML = welcomeView(); view().dataset.tab = 'welcome'; return; }
  if (!state.engine) return;
  renderChrome();
  const html = state.tab === 'week' ? weekView() : state.tab === 'activity' ? activityView() : insightsView();
  view().innerHTML = html;
  view().dataset.tab = state.tab;
  renderInstallBanner();
}

function renderInstallBanner() {
  $('.install-banner')?.remove();
  if (!mode() || isDemo()) return;
  const html = install.installBannerHTML();
  if (html) document.body.insertAdjacentHTML('beforeend', html);
}
install.onInstallChange(() => renderInstallBanner());

function installSheet() {
  openSheet(`
    <div class="sheet-h"><span style="width:56px"></span><b>Add to Home Screen</b><button class="txt-btn" data-close>Done</button></div>
    <div class="install-hero"><img src="icon.svg" alt="" width="72" height="72"><p>Hesab works like a regular app: full-screen, offline, and one tap away.</p></div>
    ${install.installGuideHTML()}`);
}

function header(title, subtitle, { nav = false } = {}) {
  const synced = isDemo() ? 'Sample data' : isLocal() ? 'On this device' : state.synced ? `Synced ${timeAgo(state.synced)}` : 'Not synced yet';
  const pend = isGoogle() ? pendingCount() : 0;
  const needSignIn = isGoogle() && !g.hasToken();
  const pill = needSignIn
    ? `<button class="sync-pill warn" data-act="gsignin">${icon('sync', 14, 2.4)}${pend ? `${pend} not synced · ` : ''}Sign in</button>`
    : pend ? `<span class="sync-pill">${pend} waiting to sync</span>` : '';
  return `<header class="hdr">
    <div class="hdr-row">
      <span class="brand"><img src="hesab-icon.svg" alt="Hesab" width="28" height="28"><span class="eyebrow">${pill || esc(synced)}</span></span>
      <div class="hdr-actions">
        ${!api() ? '' : `<button class="icon-btn" id="syncBtn" data-act="sync" aria-label="Refresh">${icon('sync', 19)}</button>`}
        <button class="icon-btn" data-act="settings" aria-label="Settings">${icon('gear', 20)}</button>
      </div>
    </div>
    <div class="hdr-title">
      ${nav ? `<button class="chev" data-act="prevWeek" aria-label="Previous week" ${state.week <= 1 ? 'disabled' : ''}>${icon('left', 20, 2.4)}</button>` : ''}
      <div class="titles" ${nav ? 'data-act="thisWeek"' : ''}>
        <h1>${esc(title)}</h1>
        ${subtitle ? `<p>${subtitle}</p>` : ''}
      </div>
      ${nav ? `<button class="chev" data-act="nextWeek" aria-label="Next week" ${state.week >= WEEKS ? 'disabled' : ''}>${icon('right', 20, 2.4)}</button>` : ''}
    </div>
  </header>`;
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return shortDate(iso.slice(0, 10));
}

const catIcon = (name, size = 38) => {
  const st = catStyle(name);
  return `<span class="cat-ic" style="--c:${st.color};width:${size}px;height:${size}px">${icon(st.icon, Math.round(size * 0.5))}</span>`;
};

function txRow(t, { date = false } = {}) {
  const sub = date ? `${esc(t.category)} · ${shortDate(t.date)}` : esc(t.category);
  return `<button class="tx" data-act="edit" data-id="${esc(t.id)}">
    ${catIcon(t.category)}
    <span class="tx-main"><span class="tx-t">${esc(t.note || t.category)}</span><span class="tx-s">${sub}${t.row < 0 ? ' · saving…' : ''}</span></span>
    <span class="tx-a ${isIncome(t) ? 'inc' : ''}">${isIncome(t) ? money(t.amount, { sign: true }) : money(t.amount)}</span>
  </button>`;
}

const newestFirst = () => [...state.snapshot.transactions].sort((a, b) =>
  a.date !== b.date ? (a.date < b.date ? 1 : -1) : String(b.timestamp || '').localeCompare(String(a.timestamp || '')));

// ───────────────────────────────────────────── Week

function weekView() {
  const e = state.engine, w = state.week;
  const lines = e.lines(w), sum = e.summary(w), days = e.daysOf(w);
  const isCurrent = w === e.currentWeek;
  // Overspending carried in from last week shrinks this week's room, so the ring uses it too.
  const available = sum.available;
  const progress = available > 0 ? sum.spent / available : 2;
  const daysLeft = isCurrent ? days.filter((d) => d >= todayISO()).length : 0;
  const perDay = daysLeft ? Math.max(0, sum.remaining) / daysLeft : 0;
  const carried = lines.reduce((s, l) => s + l.carried, 0);
  const recent = newestFirst().filter((t) => days.includes(t.date)).slice(0, 5);

  const tone = sum.remaining < 0 ? 'bad' : progress > 0.85 ? 'warn' : 'good';
  const statusText = sum.remaining < 0 ? 'Over budget' : progress > 0.85 ? 'Almost there' : 'On track';

  return `
  ${header(isCurrent ? 'This Week' : `Week ${w}`, `${isCurrent ? `Week ${w} · ` : ''}${weekRange(days)}`, { nav: true })}
  ${isDemo() ? demoBanner() : ''}

  <section class="card hero">
    <div class="hero-ring">${chart.ring(progress)}
      <div class="ring-c">${available > 0 ? `<b>${Math.round(Math.min(progress, 9.99) * 100)}%</b><span>used</span>` : `<b>—</b><span>no room</span>`}</div>
    </div>
    <div class="hero-txt">
      <span class="pill ${tone}">${icon(tone === 'good' ? 'check' : 'alert', 12, 2.6)}${statusText}</span>
      <span class="lbl">${sum.remaining < 0 ? 'Over by' : 'Left to spend'}</span>
      <span class="big">${money(Math.abs(sum.remaining), { cents: false })}</span>
      <span class="sub">${money(sum.spent, { cents: false })} spent of ${money(Math.max(0, available), { cents: false })}</span>
      ${perDay > 0 ? `<span class="sub em">≈ ${money(perDay, { cents: false })} a day · ${daysLeft} day${daysLeft > 1 ? 's' : ''} left</span>` : ''}
      ${carried < -0.5 ? `<span class="sub warnTxt">${money(carried, { cents: false })} carried from last week</span>` : ''}
    </div>
  </section>

  ${guideCard(weekGuide(w))}

  <section class="card">
    <div class="card-h"><h2>Pace</h2><span class="legend"><i class="lg-line"></i>Spent <i class="lg-dash"></i>Even pace</span></div>
    ${chart.paceChart(e.pace(w))}
  </section>

  <section class="card list">
    <div class="card-h"><h2>Categories</h2><span class="muted">${lines.filter((l) => l.remaining < 0).length ? `${lines.filter((l) => l.remaining < 0).length} over` : 'All good'}</span></div>
    ${lines.map((l) => catLine(l, [days[0], days[6]])).join('')}
  </section>

  <section class="card list">
    <div class="card-h"><h2>${isCurrent ? 'Latest' : 'This week'}</h2>${recent.length ? `<button class="link" data-act="tab" data-tab="activity">See all</button>` : ''}</div>
    ${recent.length ? recent.map((t) => txRow(t, { date: true })).join('') : `<p class="empty">${state.snapshot.transactions.length ? 'Nothing spent this week yet.' : 'Tap + to add your first expense.'}</p>`}
  </section>`;
}

function catLine(l, range = null) {
  const avail = l.available;
  const ratio = avail > 0 ? Math.min(1, l.spent / avail) : l.spent > 0 ? 1 : 0;
  const tone = l.remaining < 0 ? 'var(--bad)' : avail > 0 && l.remaining / avail < 0.2 ? 'var(--warn)' : catStyle(l.category.name).color;
  const tag = range ? 'button' : 'div';
  const attrs = range ? ` data-act="catTx" data-cat="${esc(l.category.name)}" data-from="${range[0]}" data-to="${range[1]}" aria-label="See ${esc(l.category.name)} entries"` : '';
  return `<${tag} class="cl${range ? ' tap' : ''}"${attrs}>
    ${catIcon(l.category.name, 36)}
    <div class="cl-main">
      <div class="cl-top"><span class="cl-n">${esc(l.category.name)}</span>
        <span class="cl-r ${l.remaining < 0 ? 'neg' : ''}">${l.remaining < 0 ? money(-l.remaining, { cents: false }) + ' over' : money(l.remaining, { cents: false }) + ' left'}</span></div>
      <div class="bar"><i style="width:${(ratio * 100).toFixed(1)}%;background:${tone}"></i></div>
      <div class="cl-sub">${money(l.spent, { cents: false })} of ${money(l.target, { cents: false })}${l.carried < -0.5 ? ` <em>· ${money(l.carried, { cents: false })} carried</em>` : ''}</div>
    </div>
  </${tag}>`;
}

const demoBanner = () => `<button class="card demo" data-act="welcome">
  <span class="demo-ic">${icon('sparkle', 20)}</span>
  <span><b>You're looking at sample data</b><small>Tap to start your own budget</small></span>
  ${icon('right', 16)}
</button>`;

// ───────────────────────────────────────────── Activity

function activityData() {
  const q = state.search.trim().toLowerCase();
  const items = newestFirst().filter((t) => {
    if (state.filter !== 'all' && kindOf(t) !== state.filter) return false;
    if (!q) return true;
    return t.category.toLowerCase().includes(q) || (t.note || '').toLowerCase().includes(q) || String(t.amount).includes(q);
  });
  const groups = [];
  for (const t of items.slice(0, 400)) {
    const g = groups[groups.length - 1];
    if (g && g.date === t.date) g.items.push(t); else groups.push({ date: t.date, items: [t] });
  }
  return { items, groups };
}

const countLabel = (n) => `${n} transaction${n === 1 ? '' : 's'}`;

function activityView() {
  const { items, groups } = activityData();
  const chips = [['all', 'All'], ['variable', 'Spending'], ['fixed', 'Bills'], ['income', 'Income']];
  return `
  ${header('Activity', `<span id="actCount">${countLabel(items.length)}</span>`)}
  <div class="search">${icon('search', 18)}<input id="search" type="search" placeholder="Search notes, categories, amounts" value="${esc(state.search)}" autocomplete="off"></div>
  <div class="chips">${chips.map(([k, l]) => `<button class="chip ${state.filter === k ? 'on' : ''}" data-act="filter" data-f="${k}">${l}</button>`).join('')}</div>
  <div id="groups">${groupsHTML(groups)}</div>`;
}

function groupsHTML(groups) {
  if (!groups.length) return `<p class="empty big-empty">No transactions match.</p>`;
  return groups.map((g) => {
    const spent = g.items.filter((t) => !isIncome(t)).reduce((s, t) => s + t.amount, 0);
    return `<section class="group">
      <div class="group-h"><span>${dayTitle(g.date)}</span><span>${spent ? money(spent) : ''}</span></div>
      <div class="card list tight">${g.items.map((t) => txRow(t)).join('')}</div>
    </section>`;
  }).join('');
}

// ───────────────────────────────────────────── Insights

function insightsView() {
  const seg = [['week', 'Week'], ['block', '4 Weeks'], ['month', 'Month'], ['year', 'Year']];
  const views = { week: insightsWeek, block: insightsBlock, month: insightsMonth, year: insightsYear };
  const body = (views[state.insights] || insightsWeek)();
  return `
  ${header('Insights', `${state.engine.year}`)}
  <div class="seg">${seg.map(([k, l]) => `<button class="${state.insights === k ? 'on' : ''}" data-act="insights" data-m="${k}">${l}</button>`).join('')}</div>
  ${body}`;
}

function insightsWeek() {
  const e = state.engine;
  const cur = e.currentWeek;
  const bars = e.weekBars(cur, 16);
  const done = bars.filter((b) => b.week < cur && b.active);
  const avg = done.length ? done.reduce((s, b) => s + b.spent, 0) / done.length : 0;
  const under = done.filter((b) => b.spent <= b.target).length;
  const sel = bars.find((b) => b.week === state.week) || bars[bars.length - 1];
  const savings = e.savings(state.week).filter((s) => s.amount > 0).sort((a, b) => b.amount - a.amount);
  const totalSavings = savings.reduce((s, x) => s + x.amount, 0);
  const tracked = e.trackedWeeks(state.week);
  return `
  <section class="card">
    <div class="card-h"><h2>Weekly spending</h2><span class="muted">Week ${sel.week} · ${money(sel.spent, { cents: false })}</span></div>
    <div id="weekBars">${chart.weekBars(bars, sel.week)}</div>
    <div class="tiles">
      <div class="tile"><span>Average week</span><b>${money(avg, { cents: false })}</b></div>
      <div class="tile"><span>Weekly budget</span><b>${money(e.weeklyTargetTotal, { cents: false })}</b></div>
      <div class="tile"><span>Under budget</span><b>${under}/${done.length} wks</b></div>
    </div>
  </section>

  <section class="card">
    <div class="card-h"><h2>Daily rhythm</h2><span class="muted" id="hmInfo">Tap a day</span></div>
    <div class="hm-wrap">${chart.heatmap(e.dailyVariable())}</div>
    <div class="hm-legend"><span>Less</span>${[0, 1, 2, 3, 4, 5].map((l) => `<i class="hm l${l}"></i>`).join('')}<span>More</span></div>
  </section>

  <section class="card">
    <div class="card-h"><h2>Saved so far</h2><span class="muted">${tracked} tracked week${tracked === 1 ? '' : 's'}</span></div>
    <p class="kpi good">${money(totalSavings, { cents: false })}</p>
    <p class="hint">Money left unspent in each category, counted only for weeks where you logged something. Overspending carries into the next week instead.</p>
    ${savings.length ? chart.hbars(savings.map((s) => ({ category: s.category.name, amount: s.amount }))) : ''}
  </section>`;
}

function insightsBlock() {
  const e = state.engine;
  const b = e.block(state.block);
  const [w1, w2] = b.weeks;
  const items = b.lines.map((l) => ({ category: l.category.name, amount: l.spent })).filter((i) => i.amount > 0).sort((a, c) => c.amount - a.amount);
  return `
  <div class="stepper">
    <button class="chev" data-act="prevBlock" ${state.block <= 1 ? 'disabled' : ''} aria-label="Previous block">${icon('left', 20, 2.4)}</button>
    <div><b>Block ${b.block}</b><span>Weeks ${w1}–${w2} · ${shortDate(e.firstDay(w1))} – ${shortDate(e.daysOf(w2)[6])}</span></div>
    <button class="chev" data-act="nextBlock" ${state.block >= e.blockCount ? 'disabled' : ''} aria-label="Next block">${icon('right', 20, 2.4)}</button>
  </div>
  <div class="tiles four">
    <div class="tile"><span>Income</span><b class="inc">${compact(b.income)}</b></div>
    <div class="tile"><span>Spending</span><b>${compact(b.variableSpent)}</b></div>
    <div class="tile"><span>Bills</span><b>${compact(b.fixed)}</b></div>
    <div class="tile"><span>Net</span><b class="${b.net < 0 ? 'neg' : 'pos'}">${compact(b.net)}</b></div>
  </div>
  ${guideCard(blockGuide(b))}
  ${planCard(e.daysOf(w2)[6] < todayISO() ? e.daysOf(w2)[6].slice(0, 7) : todayISO().slice(0, 7))}
  <section class="card">
    <div class="card-h"><h2>Where it went</h2><span class="muted">${money(b.variableSpent, { cents: false })} of ${money(b.variableTarget, { cents: false })}</span></div>
    <div class="donut-row">
      ${chart.donut(items)}
      <ul class="legend-list">${items.slice(0, 6).map((i) => `<li><i style="background:${catStyle(i.category).color}"></i><span>${esc(i.category)}</span><b>${Math.round((100 * i.amount) / (b.variableSpent || 1))}%</b></li>`).join('')}</ul>
    </div>
  </section>
  <section class="card list">
    <div class="card-h"><h2>Budget vs actual</h2></div>
    ${b.lines.map((l) => catLine({ category: l.category, spent: l.spent, target: l.target, carried: 0, available: l.target, remaining: l.target - l.spent }, [e.firstDay(w1), e.daysOf(w2)[6]])).join('')}
  </section>`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m) => MONTHS[m - 1];
const usd = (v) => money(v, { cents: false });

function insightsMonth() {
  const e = state.engine;
  const m = state.month || e.currentMonth;
  const mo = e.month(m);
  const items = mo.lines.map((l) => ({ category: l.category.name, amount: l.spent })).filter((i) => i.amount > 0).sort((a, c) => c.amount - a.amount);
  const today = todayISO();
  const elapsed = today < mo.first ? 0 : today > mo.last ? mo.days : Number(today.slice(8, 10));
  return `
  <div class="stepper">
    <button class="chev" data-act="prevMonth" ${m <= 1 ? 'disabled' : ''} aria-label="Previous month">${icon('left', 20, 2.4)}</button>
    <div><b>${monthName(m)} ${e.year}</b><span>${shortDate(mo.first)} – ${shortDate(mo.last)} · ${mo.days} days</span></div>
    <button class="chev" data-act="nextMonth" ${m >= 12 ? 'disabled' : ''} aria-label="Next month">${icon('right', 20, 2.4)}</button>
  </div>
  <div class="tiles four">
    <div class="tile"><span>Income</span><b class="inc">${compact(mo.income)}</b></div>
    <div class="tile"><span>Spending</span><b>${compact(mo.variableSpent)}</b></div>
    <div class="tile"><span>Bills</span><b>${compact(mo.fixed)}</b></div>
    <div class="tile"><span>Net</span><b class="${mo.net < 0 ? 'neg' : 'pos'}">${compact(mo.net)}</b></div>
  </div>
  ${guideCard(monthGuide(m), elapsed && elapsed < mo.days ? `Day ${elapsed} of ${mo.days}` : '')}
  <section class="card">
    <div class="card-h"><h2>Day by day</h2><span class="legend"><i style="background:var(--spend)"></i>Spending <i class="lg-dash"></i>Daily budget</span></div>
    ${chart.dayBars(mo.daily, e.weeklyTargetTotal / 7, mo.first)}
  </section>
  ${planCard(mo.ym)}
  <section class="card">
    <div class="card-h"><h2>Where it went</h2><span class="muted">${usd(mo.variableSpent)} of ${usd(mo.variableTarget)}</span></div>
    ${items.length ? `<div class="donut-row">
      ${chart.donut(items)}
      <ul class="legend-list">${items.slice(0, 6).map((i) => `<li><i style="background:${catStyle(i.category).color}"></i><span>${esc(i.category)}</span><b>${Math.round((100 * i.amount) / (mo.variableSpent || 1))}%</b></li>`).join('')}</ul>
    </div>` : '<p class="empty">No spending logged this month.</p>'}
  </section>
  <section class="card list">
    <div class="card-h"><h2>Budget vs actual</h2><span class="muted">Weekly targets × ${mo.days} days</span></div>
    ${mo.lines.map((l) => catLine({ category: l.category, spent: l.spent, target: l.target, carried: 0, available: l.target, remaining: l.target - l.spent }, [mo.first, mo.last])).join('')}
  </section>`;
}

// ───────────────────────────────────────────── guidance: plain next steps from the numbers

/** A short list of "what to do next" lines. Each tip: { tone: 'bad'|'warn'|'good'|'info', text }. */
function guideCard(tips, note = '') {
  if (!tips.length) return '';
  const ic = { bad: 'alert', warn: 'alert', good: 'check', info: 'sparkle' };
  return `<section class="card guide">
    <div class="card-h"><h2>What to do next</h2>${note ? `<span class="muted">${esc(note)}</span>` : ''}</div>
    <ul>${tips.slice(0, 4).map((t) => `<li class="${t.tone}"><span class="g-ic">${icon(ic[t.tone] || 'sparkle', 15, 2.4)}</span><span>${t.text}</span></li>`).join('')}</ul>
  </section>`;
}
const hl = (s) => `<b>${esc(s)}</b>`;

function weekGuide(w) {
  const e = state.engine, lines = e.lines(w), sum = e.summary(w), days = e.daysOf(w), today = todayISO();
  const isCurrent = w === e.currentWeek && days[0] <= today && today <= days[6];
  if (days[0] > today) return [];
  const tips = [];
  const over = lines.filter((l) => l.remaining < -0.5).sort((a, c) => a.remaining - c.remaining);
  const logged = state.snapshot.transactions.some((t) => days.includes(t.date));
  if (!logged) {
    return [{ tone: 'info', text: isCurrent ? 'Nothing logged this week yet. Tap <b>+</b> each time you spend so these numbers stay accurate.' : 'Nothing was logged this week, so it is left out of your savings and averages.' }];
  }
  if (isCurrent) {
    const daysLeft = days.filter((d) => d >= today).length;
    if (sum.remaining < -0.5) tips.push({ tone: 'bad', text: `You're ${hl(usd(-sum.remaining))} over for the week. Anything over comes off next week's budget, so a no-spend day or two now helps most.` });
    for (const l of over.slice(0, 2)) tips.push({ tone: 'bad', text: `${hl(l.category.name)} is ${usd(-l.remaining)} over. Stop spending on it until Monday, or next week's ${esc(l.category.name)} budget starts at ${usd(Math.max(0, l.target + l.remaining))} instead of ${usd(l.target)}.` });
    if (sum.remaining > 0.5 && daysLeft) {
      const elapsedShare = (7 - daysLeft + 1) / 7;
      const usedShare = sum.available > 0 ? sum.spent / sum.available : 1;
      if (usedShare > elapsedShare + 0.15) tips.push({ tone: 'warn', text: `${Math.round(usedShare * 100)}% of this week's budget is gone with ${daysLeft} day${daysLeft > 1 ? 's' : ''} left. Keep to about ${hl(usd(sum.remaining / daysLeft))} a day to finish on budget.` });
      else tips.push({ tone: 'good', text: `On track. Up to ${hl(usd(sum.remaining / daysLeft))} a day for the next ${daysLeft} day${daysLeft > 1 ? 's' : ''} keeps the week under budget.` });
    }
    const tight = lines.filter((l) => l.remaining >= 0 && l.available > 0 && l.remaining / l.available < 0.2 && l.spent > 0);
    for (const l of tight.slice(0, 1)) tips.push({ tone: 'warn', text: l.remaining >= 1 ? `Only ${hl(usd(l.remaining))} left for ${esc(l.category.name)} this week.` : `${hl(l.category.name)} is used up for this week. Anything more goes over budget.` });
  } else {
    for (const l of over.slice(0, 2)) tips.push({ tone: 'bad', text: `${hl(l.category.name)} went ${usd(-l.remaining)} over, so week ${w + 1} started with that much less for it.` });
    if (sum.remaining >= 0) tips.push({ tone: 'good', text: `Finished ${hl(usd(sum.remaining))} under budget. That money is counted in Saved so far.` });
  }
  const carried = lines.reduce((s, l) => s + l.carried, 0);
  if (carried < -0.5) tips.push({ tone: 'info', text: `${usd(-carried)} of overspending was carried in from last week, which is why some categories have less room.` });
  return tips;
}

function monthGuide(m) {
  const e = state.engine, mo = e.month(m), today = todayISO();
  if (mo.first > today) return [{ tone: 'info', text: `${monthName(m)} hasn't started yet. Set monthly amounts for bills and income in Settings so this report can track them.` }];
  if (!mo.count) return [{ tone: 'info', text: `Nothing was logged in ${monthName(m)}.` }];
  const tips = [];
  const isCurrent = today <= mo.last;
  const elapsed = isCurrent ? Number(today.slice(8, 10)) : mo.days;
  const left = mo.days - elapsed;
  if (isCurrent && mo.variableTarget > 0) {
    const projected = (mo.variableSpent / Math.max(1, elapsed)) * mo.days;
    const room = mo.variableTarget - mo.variableSpent;
    if (room < 0) tips.push({ tone: 'bad', text: `This month's spending budget of ${usd(mo.variableTarget)} is used up, ${hl(usd(-room))} over. Every extra dollar now adds to that.` });
    else if (projected > mo.variableTarget * 1.05) tips.push({ tone: 'warn', text: `At this pace spending reaches about ${hl(usd(projected))} by ${shortDate(mo.last)}, ${usd(projected - mo.variableTarget)} over budget. Keep to ${hl(usd(left ? room / left : room))} a day for the rest of the month to stay on budget.` });
    else tips.push({ tone: 'good', text: `On pace to finish around ${hl(usd(projected))}, ${usd(mo.variableTarget - projected)} under the ${usd(mo.variableTarget)} budget.` });
  }
  // the category furthest past its share of the month so far
  const share = elapsed / mo.days;
  const gaps = mo.lines.map((l) => ({ l, gap: l.spent - l.target * share })).filter((x) => x.l.target > 0 && x.gap > Math.max(10, x.l.target * share * 0.15)).sort((a, c) => c.gap - a.gap);
  if (gaps[0]) {
    const { l, gap } = gaps[0];
    tips.push(isCurrent
      ? { tone: 'warn', text: `${hl(l.category.name)} is the biggest gap: ${usd(l.spent)} so far, ${usd(gap)} more than its budget for ${elapsed} days.` }
      : { tone: 'warn', text: `${hl(l.category.name)} went ${usd(gap)} over its monthly budget. If that's normal now, raise its weekly target in Settings; if not, trim it next month.` });
  }
  const plan = e.monthVsPlan(mo.ym);
  const due = plan.rows.filter((r) => r.kind === 'fixed' && r.plan > 0 && r.actual === 0);
  if (isCurrent && due.length) {
    const total = due.reduce((s, r) => s + r.plan, 0);
    tips.push({ tone: 'info', text: `Still to pay this month: ${due.slice(0, 3).map((r) => `${esc(r.category.name)} ${usd(r.plan)}`).join(', ')}${due.length > 3 ? ` and ${due.length - 3} more` : ''} (${hl(usd(total))}). Keep that much aside.` });
  } else if (!isCurrent && due.length) {
    tips.push({ tone: 'warn', text: `No payment logged for ${due.map((r) => esc(r.category.name)).join(', ')}. Add it if it was paid, so the month is complete.` });
  }
  const coming = plan.rows.filter((r) => r.kind === 'income' && r.plan > r.actual);
  if (isCurrent && coming.length) {
    const total = coming.reduce((s, r) => s + r.plan - r.actual, 0);
    tips.push({ tone: 'info', text: `${hl(usd(total))} of income is still expected (${coming.slice(0, 3).map((r) => esc(r.category.name)).join(', ')}), so the net figure will rise when it arrives.` });
  }
  if (!isCurrent && mo.variableTarget > 0 && mo.variableSpent <= mo.variableTarget) {
    tips.push({ tone: 'good', text: `Everyday spending finished ${hl(usd(mo.variableTarget - mo.variableSpent))} under the ${usd(mo.variableTarget)} budget.` });
  }
  if (!isCurrent) {
    if (mo.income > 0) {
      const rate = mo.net / mo.income;
      tips.push(mo.net < 0
        ? { tone: 'bad', text: `You spent ${hl(usd(-mo.net))} more than came in this month.` }
        : { tone: 'good', text: `You kept ${hl(usd(mo.net))}, ${Math.round(rate * 100)}% of what came in.` });
    }
  }
  if (m > 1) {
    const prev = e.month(m - 1);
    if (prev.variableSpent > 0 && mo.variableSpent > 0 && !isCurrent) {
      const ch = (mo.variableSpent - prev.variableSpent) / prev.variableSpent;
      if (Math.abs(ch) >= 0.1) tips.push({ tone: ch < 0 ? 'good' : 'info', text: `Spending was ${Math.round(Math.abs(ch) * 100)}% ${ch < 0 ? 'lower' : 'higher'} than ${monthName(m - 1)}.` });
    }
  }
  return tips;
}

function blockGuide(bl) {
  const over = bl.lines.filter((l) => l.target > 0 && l.spent > l.target).sort((a, c) => (c.spent - c.target) - (a.spent - a.target));
  const tips = [];
  if (over[0]) tips.push({ tone: 'warn', text: `${hl(over[0].category.name)} is ${usd(over[0].spent - over[0].target)} over for these 4 weeks${over.length > 1 ? `, the most of ${over.length} categories over budget` : ''}.` });
  if (bl.variableTarget > 0 && bl.variableSpent <= bl.variableTarget && bl.variableSpent > 0) tips.push({ tone: 'good', text: `Spending is ${usd(bl.variableTarget - bl.variableSpent)} under budget for these 4 weeks.` });
  if (bl.income > 0 && bl.net < 0) tips.push({ tone: 'bad', text: `Spending and bills were ${hl(usd(-bl.net))} more than came in.` });
  return tips;
}

function yearGuide(months, top) {
  const e = state.engine, tips = [];
  const logged = months.filter((m) => m.income || m.variable || m.fixed);
  if (!logged.length) return tips;
  const inc = months.reduce((s, m) => s + m.income, 0), out = months.reduce((s, m) => s + m.variable + m.fixed, 0);
  if (inc > 0) tips.push(inc - out < 0
    ? { tone: 'bad', text: `So far this year you've spent ${hl(usd(out - inc))} more than came in. Start with the biggest category below.` }
    : { tone: 'good', text: `You've kept ${hl(usd(inc - out))} this year, ${Math.round(((inc - out) / inc) * 100)}% of income. Saving 20% or more is a common goal.` });
  const variable = months.reduce((s, m) => s + m.variable, 0);
  if (top[0] && variable > 0 && !isIncome(top[0])) {
    const c = catByName(top[0].category);
    if (c && isVariable(c)) tips.push({ tone: 'info', text: `${hl(top[0].category)} is ${Math.round((100 * top[0].amount) / variable)}% of your everyday spending. Cutting it by 10% saves about ${usd(top[0].amount * 0.1)} a year.` });
  }
  const full = logged.filter((m) => m.variable > 0);
  if (full.length >= 2) {
    const hi = full.reduce((a, c) => (c.variable > a.variable ? c : a));
    tips.push({ tone: 'info', text: `${monthName(hi.month)} had the most everyday spending (${usd(hi.variable)}). Open it in the Month tab to see what drove it.` });
  }
  return tips;
}

// ───────────────────────────────────────────── entry lists (tap a category or a day)

function entriesSheet(title, sub, items) {
  const total = items.reduce((s, t) => s + (isIncome(t) ? t.amount : -t.amount), 0);
  openSheet(`
    <div class="sheet-h"><span style="width:56px"></span><b>${esc(title)}</b><button class="txt-btn" data-close>Done</button></div>
    <div class="sheet-scroll">
      <p class="hint center">${esc(sub)} · ${items.length} entr${items.length === 1 ? 'y' : 'ies'}${items.length ? ` · ${money(Math.abs(total))}` : ''}</p>
      ${items.length ? `<div class="card list tight">${items.map((t) => txRow(t, { date: true })).join('')}</div><p class="hint center">Tap an entry to edit or delete it.</p>` : '<p class="empty">No entries.</p>'}
    </div>`, { cls: 'tall' });
}

function categoryEntries(cat, from, to) {
  const items = newestFirst().filter((t) => t.category === cat && t.date >= from && t.date <= to);
  entriesSheet(cat, `${shortDate(from)} – ${shortDate(to)}`, items);
}

function dayEntries(day) {
  const items = newestFirst().filter((t) => t.date === day);
  if (items.length) entriesSheet(dayTitle(day), shortDate(day), items);
}

/** Bills and income for one month against the monthly plan set in Settings. */
function planCard(ym) {
  const e = state.engine;
  const m = e.monthVsPlan(ym);
  const label = new Date(ym + '-15T12:00:00').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  const hasPlan = m.rows.some((r) => r.plan > 0);
  if (!m.rows.length || !hasPlan) {
    return `<section class="card"><div class="card-h"><h2>Bills & income</h2><span class="muted">${esc(label)}</span></div>
      <p class="hint">Set a monthly amount for each bill and income in Settings to see what's paid, what's still due and what came in.</p>
      <button class="ghost" data-act="settings">${icon('gear', 18)} Set monthly amounts</button></section>`;
  }
  const status = (r) => {
    if (!r.plan) return { t: 'No plan', c: 'muted', ic: '' };
    if (r.kind === 'income') {
      if (r.actual >= r.plan) return { t: 'Received', c: 'pos', ic: 'check' };
      return r.actual > 0 ? { t: `${money(r.plan - r.actual, { cents: false })} to come`, c: 'muted', ic: '' } : { t: 'Expected', c: 'muted', ic: '' };
    }
    if (r.actual === 0) return { t: 'Due', c: 'muted', ic: '' };
    if (r.actual > r.plan * 1.02) return { t: `${money(r.actual - r.plan, { cents: false })} over`, c: 'neg', ic: 'alert' };
    return { t: 'Paid', c: 'pos', ic: 'check' };
  };
  const row = (r) => {
    const st = status(r);
    const pct = r.plan ? Math.min(100, (100 * r.actual) / r.plan) : 0;
    const col = r.kind === 'income' ? 'var(--income)' : r.actual > r.plan * 1.02 && r.plan ? 'var(--bad)' : 'var(--spend)';
    const [y, mo] = ym.split('-').map(Number);
    const range = [`${ym}-01`, `${ym}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`];
    return `<button class="cl tap" data-act="catTx" data-cat="${esc(r.category.name)}" data-from="${range[0]}" data-to="${range[1]}">${catIcon(r.category.name, 36)}<div class="cl-main">
      <div class="cl-top"><span class="cl-n">${esc(r.category.name)}</span><span class="cl-r ${st.c}">${st.ic ? icon(st.ic, 13, 2.6) + ' ' : ''}${esc(st.t)}</span></div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%;background:${col}"></i></div>
      <div class="cl-sub">${money(r.actual, { cents: false })} of ${money(r.plan, { cents: false })}</div></div></button>`;
  };
  const inc = m.rows.filter((r) => r.kind === 'income'), bills = m.rows.filter((r) => r.kind === 'fixed');
  return `<section class="card list">
    <div class="card-h"><h2>Bills & income</h2><span class="muted">${esc(label)}</span></div>
    <div class="tiles plan-tiles">
      <div class="tile"><span>Income</span><b class="inc">${compact(m.income.actual)}</b><small>of ${compact(m.income.plan)} planned</small></div>
      <div class="tile"><span>Bills paid</span><b>${compact(m.fixed.actual)}</b><small>of ${compact(m.fixed.plan)} planned</small></div>
    </div>
    ${inc.length ? `<h3 class="sub-h">Income</h3>${inc.map(row).join('')}` : ''}
    ${bills.length ? `<h3 class="sub-h">Bills</h3>${bills.map(row).join('')}` : ''}
  </section>`;
}

function insightsYear() {
  const e = state.engine;
  const months = e.monthly();
  const inc = months.reduce((s, m) => s + m.income, 0);
  const out = months.reduce((s, m) => s + m.variable + m.fixed, 0);
  const rate = inc > 0 ? (inc - out) / inc : 0;
  const top = e.totalsBy((t) => !isIncome(t) && Number(t.date.slice(0, 4)) === e.year).slice(0, 6);
  const topMax = top[0]?.amount || 1;
  return `
  <div class="tiles">
    <div class="tile"><span>Income</span><b class="inc">${compact(inc)}</b></div>
    <div class="tile"><span>Spent</span><b>${compact(out)}</b></div>
    <div class="tile"><span>Saved</span><b class="${rate < 0 ? 'neg' : 'pos'}">${Math.round(rate * 100)}%</b></div>
  </div>
  ${guideCard(yearGuide(months, top))}
  <section class="card">
    <div class="card-h"><h2>Cash flow</h2><span class="legend"><i style="background:var(--income)"></i>In <i style="background:var(--spend)"></i>Spending <i style="background:var(--fixed)"></i>Bills</span></div>
    ${chart.monthBars(months)}
  </section>
  <section class="card list">
    <div class="card-h"><h2>Biggest categories</h2><span class="muted">${e.year}</span></div>
    ${top.map((t) => `<div class="cl">${catIcon(t.category, 36)}<div class="cl-main">
      <div class="cl-top"><span class="cl-n">${esc(t.category)}</span><span class="cl-r">${money(t.amount, { cents: false })}</span></div>
      <div class="bar"><i style="width:${((100 * t.amount) / topMax).toFixed(1)}%;background:${catStyle(t.category).color}"></i></div></div></div>`).join('')}
  </section>`;
}

// ───────────────────────────────────────────── bottom sheets

function openSheet(html, { onMount, cls = '' } = {}) {
  closeSheet(true);
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="backdrop" data-close></div><div class="sheet ${cls}" role="dialog" aria-modal="true"><div class="grab" data-grab></div>${html}</div>`;
  document.body.appendChild(wrap);
  document.body.classList.add('locked');
  requestAnimationFrame(() => wrap.classList.add('open'));
  wrap.addEventListener('click', (ev) => { if (ev.target.closest('[data-close]')) closeSheet(); });
  enableDragToClose(wrap);
  onMount?.(wrap);
  return wrap;
}

function closeSheet(immediate = false) {
  const wrap = $('.sheet-wrap');
  if (!wrap) return;
  document.body.classList.remove('locked');
  if (immediate) { wrap.remove(); return; }
  wrap.classList.remove('open');
  setTimeout(() => wrap.remove(), 320);
}

function enableDragToClose(wrap) {
  const sheet = $('.sheet', wrap), grab = $('[data-grab]', wrap);
  let y0 = null, dy = 0;
  grab.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; sheet.style.transition = 'none'; }, { passive: true });
  grab.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sheet.style.transform = `translateY(${dy}px)`; }, { passive: true });
  grab.addEventListener('touchend', () => {
    sheet.style.transition = ''; sheet.style.transform = '';
    if (dy > 110) closeSheet();
    y0 = null; dy = 0;
  });
}

// ---- add / edit entry ----

function entrySheet(tx = null) {
  const cats = categories();
  const draft = {
    amount: tx ? String(tx.amount) : '',
    category: tx?.category || '',
    date: tx?.date || todayISO(),
    note: tx?.note || '',
    kind: tx ? kindOf(tx) : 'variable',
  };
  const kinds = [['variable', 'Spending'], ['fixed', 'Bills'], ['income', 'Income']];

  const html = `
    <div class="sheet-h">
      <button class="txt-btn" data-close>Cancel</button>
      <b>${tx ? 'Edit' : 'New entry'}</b>
      ${tx ? `<button class="txt-btn bad" data-act="delete">Delete</button>` : '<span style="width:56px"></span>'}
    </div>
    <div class="amount" id="amt"><span class="cur">$</span><span id="amtV"></span><span class="caret"></span></div>
    <div class="seg small" id="kinds">${kinds.map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('')}</div>
    <div class="cats" id="cats"></div>
    <div class="meta-row">
      <label class="meta">${icon('calendar', 17)}<span id="dateLbl"></span><input type="date" id="date" value="${draft.date}"></label>
      <label class="meta grow">${icon('note', 17)}<input id="note" placeholder="Add a note" value="${esc(draft.note)}" maxlength="120" enterkeyhint="done"></label>
    </div>
    <div class="keypad" id="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'].map((k) =>
      `<button data-key="${k}" aria-label="${k === 'del' ? 'Delete digit' : k}">${k === 'del' ? icon('del', 24) : k}</button>`).join('')}</div>
    <button class="primary" id="save" disabled>${tx ? 'Save changes' : 'Add'}</button>`;

  openSheet(html, {
    cls: 'entry',
    onMount(wrap) {
      const amtV = $('#amtV', wrap), save = $('#save', wrap), catsEl = $('#cats', wrap);

      const paint = () => {
        const n = draft.amount;
        amtV.textContent = n === '' ? '0' : Number(n.split('.')[0]).toLocaleString('en-CA') + (n.includes('.') ? '.' + n.split('.')[1] : '');
        $('#amt', wrap).classList.toggle('zero', n === '' || Number(n) === 0);
        wrap.querySelectorAll('#kinds button').forEach((b) => b.classList.toggle('on', b.dataset.k === draft.kind));
        const list = cats.filter((c) => kindOf(c) === draft.kind);
        catsEl.innerHTML = list.map((c) => `<button class="cat ${draft.category === c.name ? 'on' : ''}" data-cat="${esc(c.name)}" style="--c:${catStyle(c.name).color}">
          ${catIcon(c.name, 40)}<span>${esc(c.name)}</span></button>`).join('');
        $('#dateLbl', wrap).textContent = draft.date === todayISO() ? 'Today' : shortDate(draft.date);
        save.disabled = !(Number(draft.amount) > 0 && draft.category);
      };

      $('#keypad', wrap).addEventListener('click', (e) => {
        const b = e.target.closest('[data-key]'); if (!b) return;
        const k = b.dataset.key; let n = draft.amount;
        if (k === 'del') n = n.slice(0, -1);
        else if (k === '.') { if (!n.includes('.')) n = (n || '0') + '.'; }
        else {
          const [, dec] = n.split('.');
          if (dec != null && dec.length >= 2) return;
          if (n.replace('.', '').length >= 8) return;
          n = n === '0' ? k : n + k;
        }
        draft.amount = n; paint();
      });
      $('#kinds', wrap).addEventListener('click', (e) => {
        const b = e.target.closest('[data-k]'); if (!b) return;
        draft.kind = b.dataset.k;
        if (!cats.some((c) => c.name === draft.category && kindOf(c) === draft.kind)) draft.category = '';
        paint();
      });
      catsEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-cat]'); if (!b) return;
        draft.category = b.dataset.cat; paint();
      });
      $('#date', wrap).addEventListener('change', (e) => { if (e.target.value) draft.date = e.target.value; paint(); });
      $('#note', wrap).addEventListener('input', (e) => { draft.note = e.target.value; });
      $('#note', wrap).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

      save.addEventListener('click', async () => {
        if (tx && stillSending(tx)) return;
        const entry = { amount: Math.round(Number(draft.amount) * 100) / 100, category: draft.category, date: draft.date, note: draft.note.trim() };
        closeSheet();
        if (tx) await updateEntry(tx, entry); else await addEntry(entry);
      });
      wrap.querySelector('[data-act="delete"]')?.addEventListener('click', () => {
        if (stillSending(tx)) return;
        if (confirm(`Delete this ${tx.category} entry of ${money(tx.amount)}? It will be removed from your sheet.`)) {
          closeSheet(); deleteEntry(tx);
        }
      });
      paint();
    },
  });
}

function reorderCategories(names) {
  const s = state.snapshot;
  names.forEach((n, i) => { const c = s.categories.find((x) => x.name === n); if (c) c.order = i + 1; });
  setSnapshot(s, { keepWeek: true });
  render();
  syncCategories();
}

/** Drag rows by their grip to reorder (touch and mouse). Calls onDone with the new order. */
function enableReorder(list, onDone) {
  let row = null, startY = 0, moved = false;
  const rows = () => [...list.querySelectorAll('.row[data-name]')];
  list.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]'); if (!grip) return;
    row = grip.closest('.row'); startY = e.clientY; moved = false;
    row.classList.add('dragging'); grip.setPointerCapture(e.pointerId); e.preventDefault();
  });
  list.addEventListener('pointermove', (e) => {
    if (!row) return;
    const dy = e.clientY - startY;
    row.style.transform = `translateY(${dy}px)`;
    const all = rows(), i = all.indexOf(row);
    const prev = all[i - 1], next = all[i + 1];
    if (next && e.clientY > next.getBoundingClientRect().top + next.offsetHeight / 2) {
      next.after(row); startY += next.offsetHeight; row.style.transform = `translateY(${e.clientY - startY}px)`; moved = true;
    } else if (prev && e.clientY < prev.getBoundingClientRect().top + prev.offsetHeight / 2) {
      prev.before(row); startY -= prev.offsetHeight; row.style.transform = `translateY(${e.clientY - startY}px)`; moved = true;
    }
  });
  const end = () => {
    if (!row) return;
    row.classList.remove('dragging'); row.style.transform = '';
    row = null;
    if (moved) onDone(rows().map((r) => r.dataset.name));
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
}

// ---- settings ----

const KIND_LABEL = { variable: 'Spending', fixed: 'Bill', income: 'Income' };
const KIND_GROUP = { variable: 'Weekly spending', fixed: 'Monthly bill', income: 'Income' };

function settingsSheet({ showConnect = false } = {}) {
  const e = state.engine, m = mode();
  const editable = canEditCategories(), local = isLocal();
  const cats = categories();
  const gSheet = g.chosenSheet();
  const sourceRow = (key, title, sub, ic) => `<button class="src ${m === key ? 'on' : ''}" data-src="${key}">
      <span class="src-ic">${icon(ic, 20)}</span><span class="src-t"><b>${title}</b><small>${sub}</small></span>
      ${m === key ? `<span class="src-ck">${icon('check', 18, 2.6)}</span>` : ''}</button>`;

  const catRow = (c) => {
    const k = kindOf(c);
    const cell = k === 'variable'
      ? `<span class="plan-in"><span class="money-in">$<input type="number" inputmode="decimal" min="0" step="1" data-target="${esc(c.name)}" value="${e.targets[c.name] || 0}" aria-label="${esc(c.name)} weekly budget"></span><small>/wk</small></span>`
      : canEditPlans()
        ? `<span class="plan-in"><span class="money-in">$<input type="number" inputmode="decimal" min="0" step="1" data-plan="${esc(c.name)}" data-kind="${k}" value="${e.plans[c.name] || 0}" aria-label="${esc(c.name)} monthly amount"></span><small>/mo</small></span>`
        : '';
    return `<div class="row" data-name="${esc(c.name)}">${editable ? `<span class="grip" data-grip aria-label="Drag to reorder">${icon('grip', 18)}</span>` : ''}${catIcon(c.name, 30)}
      ${editable ? `<button class="row-name" data-cat-edit="${esc(c.name)}">${esc(c.name)}</button>` : `<span>${esc(c.name)}</span>`}
      ${cell}</div>`;
  };
  const planTotal = (k) => cats.filter((c) => kindOf(c) === k).reduce((sum, c) => sum + (e.plans[c.name] || 0), 0);
  const GROUPS = [
    { k: 'variable', title: 'Weekly spending', sub: 'Shown in the weekly report. Each one has a weekly budget; what you don\'t spend is saved, overspending carries into next week.', add: 'New spending category',
      total: `<div class="row total"><span>Weekly budget</span><b id="tTotal">${money(e.weeklyTargetTotal, { cents: false })}</b></div>` },
    { k: 'fixed', title: 'Monthly bills', sub: 'Fixed costs like rent or phone, paid once a month. Not part of the weekly budget; Insights shows which are paid.', add: 'New bill',
      total: canEditPlans() ? `<div class="row total"><span>Bills per month</span><b id="tFixed">${money(planTotal('fixed'), { cents: false })}</b></div>` : '' },
    { k: 'income', title: 'Income', sub: 'Money coming in. Insights compares it with what you expect each month.', add: 'New income',
      total: canEditPlans() ? `<div class="row total"><span>Expected per month</span><b id="tIncome">${money(planTotal('income'), { cents: false })}</b></div>` : '' },
  ];
  const catGroups = GROUPS.map((gr) => {
    const list = cats.filter((c) => kindOf(c) === gr.k);
    return `<h3 class="grp">${gr.title}</h3><p class="hint grp-sub">${gr.sub}</p>
      <div class="card form cat-group" data-kind="${gr.k}">
        ${list.map(catRow).join('') || '<p class="empty small">None yet.</p>'}
        ${gr.total}
      </div>
      ${editable ? `<button class="txt-btn add-cat" data-cat-new="${gr.k}">${icon('plus', 16, 2.4)} ${gr.add}</button>` : ''}`;
  }).join('');

  const html = `
    <div class="sheet-h"><span style="width:56px"></span><b>Settings</b><button class="txt-btn" data-close>Done</button></div>
    <div class="sheet-scroll">
      <h3 class="grp">Where your data lives</h3>
      <div class="card src-list">
        ${sourceRow('local', 'On this device', 'Free and private. No account needed.', 'phone')}
        ${sourceRow('google', 'Google Sheet', 'Sign in with Google. Syncs across your devices.', 'sync')}
      </div>
      ${isGoogle() ? `<div class="card form g-panel">
        <div class="row"><span>Sheet</span><b class="ellip">${esc(state.snapshot?.sheet?.title || gSheet?.name || '—')}</b></div>
        <div class="row"><span>Status</span><b class="${g.hasToken() ? 'pos' : 'neg'}">${g.hasToken() ? (pendingCount() ? `${pendingCount()} waiting to sync` : 'Signed in') : 'Signed out'}</b></div>
        ${g.hasToken() ? '<button class="row act" data-g="sync">' + icon('sync', 18) + '<span>Sync now</span></button>' : '<button class="row act" data-g="signin">' + icon('sync', 18) + '<span>Sign in with Google</span></button>'}
        <button class="row act" data-g="change">${icon('list', 18)}<span>Use a different sheet</span></button>
        ${state.snapshot?.sheet?.id ? `<a class="row act" href="https://docs.google.com/spreadsheets/d/${esc(state.snapshot.sheet.id)}/edit" target="_blank" rel="noopener">${icon('note', 18)}<span>Open the sheet in Google Sheets</span></a>` : ''}
      </div>` : ''}
      ${m === 'sheet' || showConnect ? '' : '<button class="txt-btn small center" id="showScript">Advanced: connect with an Apps Script link</button>'}
      <div id="sheetForm" ${m === 'sheet' || showConnect ? '' : 'hidden'}>
        <div class="card form">
          <label><span>Script URL</span><input id="sUrl" type="url" inputmode="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(store.get(LS.url) || '')}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <label><span>Token</span><input id="sTok" type="password" placeholder="From setupToken() in Apps Script" value="${esc(store.get(LS.token) || '')}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        </div>
        <p class="hint">${m === 'sheet' ? `Connected · ${state.snapshot.transactions.length} transactions` : 'Deploy Code.gs from your sheet as a Web app, then paste its URL and token.'}</p>
        <button class="primary" id="connect">${m === 'sheet' ? 'Save & reconnect' : 'Connect'}</button>
      </div>
      ${isDemo() ? '<p class="hint">You are looking at sample data. Pick where to keep your own budget above.</p>' : ''}

      ${catGroups}
      ${editable ? '<p class="hint">Drag ⋮⋮ to change the order. Tap a name to rename it, move it to another group, or delete it.</p>' : ''}
      <p class="hint">${isRemote() && !editable ? 'Budget changes are written to the Budget tab of your sheet. Categories come from its Categories tab.' : isGoogle() ? 'Changes are saved to your Google Sheet.' : ''}</p>

      ${isDemo() ? '' : `<h3 class="grp">Backup & moving phones</h3>
      <div class="card form">
        <button class="row act" id="backupSave">${icon('shield', 18)}<span>Save full backup</span></button>
        ${local ? `<label class="row act">${icon('sync', 18)}<span>Restore from backup</span><input type="file" id="backupLoad" accept=".json,application/json" hidden></label>` : ''}
        <button class="row act" id="exportCsv">${icon('note', 18)}<span>Export CSV</span></button>
        ${local ? `<label class="row act">${icon('list', 18)}<span>Import CSV</span><input type="file" id="importCsv" accept=".csv,text/csv" hidden></label>` : ''}
      </div>
      <p class="hint">${local ? '<b>Full backup</b> keeps everything (entries, categories and budgets). Use it to move to a new phone: save it here, then on the new phone choose <b>Restore from backup</b>. CSV is for spreadsheets and bank exports.' : 'Save every entry, category and budget as a backup file, or download entries as CSV.'}</p>`}

      <h3 class="grp">Install on a phone</h3>
      <div class="card install-card">${install.installGuideHTML({ showQR: true })}</div>
      <p class="hint">Share this link with anyone. Each person's data stays on their own phone.</p>

      <h3 class="grp">About</h3>
      <div class="card form">
        <div class="row"><span>Budget year</span><b>${e.year}</b></div>
        <div class="row"><span>Weeks per block</span><b>${e.weeksPerBlock}</b></div>
      </div>
      <h3 class="grp">Updates & privacy</h3>
      <div class="card form">
        ${track.signedUpEmail()
          ? `<div class="row"><span>Updates</span><b class="muted ellip">${esc(track.signedUpEmail())}</b></div>`
          : `<label><span>Email</span><input id="upEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"></label>
             <button class="row act" id="upSend">${icon('check', 18)}<span>Email me about new features</span></button>`}
        <label class="row toggle"><span>Share anonymous usage stats</span><input type="checkbox" id="anaToggle" ${track.analyticsOn() ? 'checked' : ''}></label>
        <a class="row act" href="privacy.html" target="_blank" rel="noopener">${icon('shield', 18)}<span>Privacy policy</span></a>
      </div>
      <p class="hint">Your email is optional and only used for occasional Hesab news. Usage stats are anonymous: never your money, entries or name.</p>
      ${local ? '<button class="txt-btn bad center" id="eraseAll">Erase all data on this device</button>' : ''}
      ${isRemote() ? '<button class="txt-btn bad center" id="disconnect">Disconnect Google Sheet</button>' : ''}
      <div class="about"><img class="light-only" src="hesab-lockup-dark.svg" alt="Hesab"><img class="dark-only" src="hesab-lockup-light.svg" alt="Hesab"><span>Version ${esc(track.VERSION)}</span></div>
    </div>`;

  openSheet(html, {
    cls: 'tall',
    onMount(wrap) {
      wrap.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => {
        const target = b.dataset.src;
        if (target === m) return;
        if (target === 'google') { googleSheetChooser(); return; }
        if (m === 'local') return;
        if (isRemote()) {
          const n = state.snapshot.transactions.length;
          if (!confirm(`Copy your ${n} entries, categories and budget from the sheet to this device and stop syncing? Your sheet is not changed.`)) return;
          const copy = structuredClone(state.snapshot);
          copy.transactions.forEach((t) => { t.row = 0; t.id = newId(); });
          closeSheet(); useMode('local', copy); toast(`Copied ${n} entries to this device`);
          return;
        }
        closeSheet(); startFresh();
      }));

      $('#showScript', wrap)?.addEventListener('click', (ev) => { ev.currentTarget.hidden = true; $('#sheetForm', wrap).hidden = false; $('#sUrl', wrap).focus(); });
      wrap.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.g;
        if (act === 'sync') { closeSheet(); refresh(); }
        if (act === 'signin') g.signIn({ after: 'sync' });
        if (act === 'change') googleSheetChooser();
      }));
      $('#upSend', wrap)?.addEventListener('click', async () => {
        try { await track.signUp($('#upEmail', wrap).value, mode()); toast('Thanks! You’re on the list'); settingsSheet(); }
        catch (err) { toast(err.message, 'bad'); }
      });
      $('#anaToggle', wrap)?.addEventListener('change', (ev) => { track.setAnalytics(ev.target.checked); toast(ev.target.checked ? 'Thanks for helping improve Hesab' : 'Usage stats turned off'); });

      $('#connect', wrap).addEventListener('click', async (ev) => {
        const url = $('#sUrl', wrap).value.trim(), token = $('#sTok', wrap).value.trim();
        if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { toast('Paste the Web app URL from Apps Script (it ends with /exec).', 'bad'); return; }
        if (!token) { toast('Paste the token from setupToken().', 'bad'); return; }
        if (isLocal() && state.snapshot.transactions.length &&
          !confirm('Switch to your Google Sheet? Entries saved on this device stay here, but the app will show the sheet. Export a backup first if you want to keep them.')) return;
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = 'Connecting…';
        try {
          const snap = await new Api(url, token).bootstrap();
          store.set(LS.url, url); store.set(LS.token, token); store.set(LS.mode, 'sheet');
          state.synced = new Date().toISOString(); store.set(LS.synced, state.synced);
          setSnapshot(snap); closeSheet(); render(); toast(`Connected · ${snap.transactions.length} transactions`);
        } catch (err) {
          toast(err.message, 'bad'); btn.disabled = false; btn.textContent = 'Connect';
        }
      });

      wrap.querySelectorAll('[data-target]').forEach((inp) => inp.addEventListener('change', async () => {
        const v = Math.max(0, Math.round(Number(inp.value) * 100) / 100 || 0);
        inp.value = v;
        await setTarget(inp.dataset.target, v);
        $('#tTotal', wrap).textContent = money(state.engine.weeklyTargetTotal, { cents: false });
      }));
      wrap.querySelectorAll('[data-plan]').forEach((inp) => inp.addEventListener('change', async () => {
        const v = Math.max(0, Math.round(Number(inp.value) * 100) / 100 || 0);
        inp.value = v;
        await setPlan(inp.dataset.plan, v);
        const sumKind = (k) => [...wrap.querySelectorAll(`[data-plan][data-kind="${k}"]`)].reduce((t, x) => t + (Number(x.value) || 0), 0);
        if ($('#tFixed', wrap)) $('#tFixed', wrap).textContent = money(sumKind('fixed'), { cents: false });
        if ($('#tIncome', wrap)) $('#tIncome', wrap).textContent = money(sumKind('income'), { cents: false });
      }));
      wrap.querySelectorAll('[data-cat-new]').forEach((b) => b.addEventListener('click', () => categorySheet(null, b.dataset.catNew)));
      wrap.querySelectorAll('[data-cat-edit]').forEach((b) => b.addEventListener('click', () => categorySheet(b.dataset.catEdit || null)));
      if (editable) wrap.querySelectorAll('.cat-group').forEach((list) => enableReorder(list, () => {
        reorderCategories([...wrap.querySelectorAll('.cat-group .row[data-name]')].map((r) => r.dataset.name));
        toast('Order saved');
      }));

      $('#exportCsv', wrap)?.addEventListener('click', () => saveFile(`hesab-${todayISO()}.csv`, toCSV(state.snapshot), 'text/csv'));
      $('#backupSave', wrap)?.addEventListener('click', async () => {
        if (await saveFile(`hesab-backup-${todayISO()}.json`, toBackup(state.snapshot), 'application/json')) store.set('hesab.lastBackup', todayISO());
      });
      $('#backupLoad', wrap)?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0]; if (!file) return;
        try {
          const snap = fromBackup(await file.text());
          const n = state.snapshot.transactions.length;
          if (n && !confirm(`Replace the ${n} entries on this phone with the backup (${snap.transactions.length} entries)?`)) return;
          closeSheet(); useMode('local', snap); toast(`Restored ${snap.transactions.length} entries`);
        } catch (err) { toast(err.message, 'bad'); }
      });
      $('#importCsv', wrap)?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0]; if (!file) return;
        try {
          const snap = structuredClone(state.snapshot);
          const n = importCSV(snap, await file.text());
          setSnapshot(snap, { keepWeek: true }); closeSheet(); render();
          toast(n ? `Imported ${n} entries` : 'Nothing new to import');
        } catch (err) { toast(err.message, 'bad'); }
      });
      $('#eraseAll', wrap)?.addEventListener('click', () => {
        if (!confirm('Erase every entry, category and budget on this device? This cannot be undone. Export a backup first if you might need it.')) return;
        clearLocal(); store.set(LS.mode, null); closeSheet(); state.snapshot = null; state.engine = null; render();
      });
      $('#disconnect', wrap)?.addEventListener('click', () => {
        if (pendingCount() && !confirm(`${pendingCount()} change(s) haven't reached your sheet yet and will be lost. Disconnect anyway?`)) return;
        if (!confirm('Disconnect this phone from your sheet? Your sheet is not changed.')) return;
        if (isGoogle()) { g.signOut(); sheetsClient = null; }
        [LS.url, LS.token, LS.cache, LS.synced, LS.mode, LS.queue].forEach((k) => store.set(k, null));
        state.synced = null; state.snapshot = null; state.engine = null; closeSheet(); render();
      });
    },
  });
}

function categorySheet(name, newKind = 'variable') {
  const c = name ? catByName(name) : null;
  const used = c ? state.snapshot.transactions.filter((t) => t.category === c.name).length : 0;
  let kind = c ? kindOf(c) : newKind;
  const html = `
    <div class="sheet-h"><button class="txt-btn" data-back>Back</button><b>${c ? 'Edit category' : 'New category'}</b><button class="txt-btn" id="catSave">Save</button></div>
    <div class="cat-preview" id="catPrev">${catIcon(c?.name || 'New', 64)}</div>
    <div class="card form">
      <label><span>Name</span><input id="catName" value="${esc(c?.name || '')}" placeholder="e.g. Pets" maxlength="40" autocomplete="off"></label>
    </div>
    <div class="seg small" id="catKind" style="margin-top:12px">${['variable', 'fixed', 'income'].map((k) => `<button data-k="${k}">${KIND_GROUP[k]}</button>`).join('')}</div>
    <div class="card form" id="catBudget">
      <label><span>Weekly budget</span><span class="money-in">$<input id="catTarget" type="number" inputmode="decimal" min="0" value="${c ? state.engine.targets[c.name] || 0 : 0}"></span></label>
    </div>
    <div class="card form" id="catPlan" ${canEditPlans() ? '' : 'data-off'}>
      <label><span id="catPlanL">Monthly amount</span><span class="money-in">$<input id="catPlanV" type="number" inputmode="decimal" min="0" value="${c ? state.engine.plans[c.name] || 0 : 0}"></span></label>
    </div>
    <p class="hint" id="catHint"></p>
    ${c && used ? `<div id="moveBox" hidden>
        <h3 class="grp">Move ${used} entr${used === 1 ? 'y' : 'ies'} to</h3>
        <div class="card form"><label><span>Category</span><select id="moveTo" class="select">
          ${categories().filter((x) => x.name !== c.name).sort((a, b) => (kindOf(a) === kindOf(c) ? 0 : 1) - (kindOf(b) === kindOf(c) ? 0 : 1)).map((x) => `<option value="${esc(x.name)}">${esc(x.name)} · ${KIND_LABEL[kindOf(x)]}</option>`).join('')}
        </select></label></div>
        <button class="primary danger" id="catDelMove">Move entries & delete</button>
      </div>` : ''}
    ${c ? `<button class="txt-btn bad center" id="catDel">Delete category</button>
      ${used ? `<p class="hint center">Used by ${used} entr${used === 1 ? 'y' : 'ies'}. You'll choose where they go.</p>` : ''}` : ''}`;

  openSheet(html, {
    onMount(wrap) {
      const paint = () => {
        wrap.querySelectorAll('#catKind button').forEach((b) => b.classList.toggle('on', b.dataset.k === kind));
        $('#catBudget', wrap).hidden = kind !== 'variable';
        $('#catPlan', wrap).hidden = kind === 'variable' || $('#catPlan', wrap).hasAttribute('data-off');
        $('#catPlanL', wrap).textContent = kind === 'income' ? 'Expected per month' : 'Planned per month';
        $('#catHint', wrap).textContent = kind === 'variable' ? 'Everyday spending with a weekly budget. Shown in the weekly report.'
          : kind === 'fixed' ? 'Regular bills like rent or phone. Not part of the weekly budget; Insights shows if each one is paid this month.' : 'Money coming in. Insights compares it with what you expect each month.';
        $('#catPrev', wrap).innerHTML = catIcon($('#catName', wrap).value || 'New', 64);
      };
      $('#catKind', wrap).addEventListener('click', (ev) => { const b = ev.target.closest('[data-k]'); if (b) { kind = b.dataset.k; paint(); } });
      $('#catName', wrap).addEventListener('input', paint);
      wrap.querySelector('[data-back]').addEventListener('click', () => settingsSheet());
      $('#catSave', wrap).addEventListener('click', () => {
        const err = saveCategory(c?.name || null, { name: $('#catName', wrap).value, kind, target: $('#catTarget', wrap).value, plan: $('#catPlanV', wrap).value });
        if (err) { toast(err, 'bad'); return; }
        settingsSheet();
      });
      $('#catDel', wrap)?.addEventListener('click', (ev) => {
        if (used) { $('#moveBox', wrap).hidden = false; ev.currentTarget.hidden = true; $('#moveBox', wrap).scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
        if (!confirm(`Delete “${c.name}”?`)) return;
        deleteCategory(c.name); settingsSheet(); toast('Category deleted');
      });
      $('#catDelMove', wrap)?.addEventListener('click', () => {
        const to = $('#moveTo', wrap).value;
        if (!to || !confirm(`Move ${used} entr${used === 1 ? 'y' : 'ies'} from “${c.name}” to “${to}” and delete “${c.name}”?`)) return;
        deleteCategory(c.name, to); settingsSheet(); toast(`Moved to ${to}`);
      });
      paint();
    },
  });
}

// ---- welcome ----

function startFresh() {
  useMode('local', starterSnapshot());
  toast('Your budget is ready. Tap + to add an expense.');
}

function welcomeView() {
  return `<section class="welcome">
    <div class="w-logo"><img src="hesab-icon.svg" alt="Hesab logo" width="88" height="88"></div>
    <h1>Hesab</h1>
    <p class="w-lead">A calm weekly budget. See what's left, spend with confidence, and watch your savings grow.</p>
    <ul class="w-points">
      <li>${icon('ring', 20)}<span><b>Weekly room to spend</b> per category, with overspending carried forward</span></li>
      <li>${icon('chart', 20)}<span><b>Clear insights</b>: pace, calendar, 4-week blocks and yearly cash flow</span></li>
      <li>${icon('shield', 20)}<span><b>Private by default</b>: your data stays on this phone</span></li>
    </ul>
    <div class="w-actions">
      <button class="primary" data-act="start">Start my budget</button>
      <button class="ghost g-btn" data-act="connectGoogle"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Sync with Google Sheets</button>
      <label class="txt-btn center restore">Restore from a backup<input type="file" id="welcomeRestore" accept=".json,application/json" hidden></label>
      <button class="txt-btn center" data-act="sample">Explore with sample data</button>
    </div>
    ${!install.isMobile ? `<div class="w-qr">${install.qrSVG(install.appURL(), 112)}<p><b>Using a computer?</b><small>Scan to open Hesab on your phone and add it to the Home Screen.</small></p></div>`
      : !install.isStandalone() ? `<button class="w-install" data-act="installGuide">${icon('phone', 18)}<span>How to install on this phone</span>${icon('right', 14)}</button>` : ''}
  </section>`;
}

// ───────────────────────────────────────────── toast

let toastTimer;
function toast(msg, tone = '') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = `toast ${tone}`;
  el.innerHTML = `${tone === 'bad' ? '' : icon('check', 18, 2.6)}<span>${esc(msg)}</span>`;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), tone === 'bad' ? 4200 : 2200);
}

// ───────────────────────────────────────────── events

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act]');
  if (t && t.closest('.sheet') && t.dataset.act === 'shareLink') { install.shareLink().then((r) => r === 'copied' && toast('Link copied')); return; }
  if (t && t.closest('.sheet') && t.dataset.act === 'edit') { const tx = state.snapshot.transactions.find((x) => x.id === t.dataset.id); if (tx) entrySheet(tx); return; }
  if (!t || t.closest('.sheet')) {
    const tab = ev.target.closest('.tab');
    if (tab) { state.tab = tab.dataset.tab; render(); window.scrollTo({ top: 0 }); }
    const bar = ev.target.closest('#weekBars .wbar');
    if (bar) { state.week = Number(bar.dataset.week); render(); }
    const cell = ev.target.closest('.hm[data-day]');
    if (cell) { const info = $('#hmInfo'); if (info) info.textContent = `${shortDate(cell.dataset.day)} · ${money(Number(cell.dataset.v))}`; dayEntries(cell.dataset.day); }
    return;
  }
  const act = t.dataset.act, e = state.engine;
  if (!e && !['start', 'sample', 'connectSheet', 'connectGoogle', 'installGuide', 'shareLink'].includes(act)) return;
  switch (act) {
    case 'settings': settingsSheet(); break;
    case 'welcome': store.set(LS.mode, null); state.snapshot = null; state.engine = null; render(); window.scrollTo({ top: 0 }); break;
    case 'start': startFresh(); break;
    case 'installGuide': installSheet(); break;
    case 'installNow': install.promptInstall().then((ok) => { if (ok) toast('Hesab is installed'); renderInstallBanner(); }); break;
    case 'dismissInstall': install.dismissBanner(); renderInstallBanner(); break;
    case 'shareLink': install.shareLink().then((r) => r === 'copied' && toast('Link copied')); break;
    case 'sample': useMode('demo', demoSnapshot()); break;
    case 'connectSheet': setSnapshot(starterSnapshot()); settingsSheet({ showConnect: true }); break;
    case 'connectGoogle': if (!state.engine) setSnapshot(starterSnapshot()); googleSheetChooser(); break;
    case 'gsignin': g.signIn({ after: 'sync' }); break;
    case 'sync': refresh(); break;
    case 'prevWeek': state.week = Math.max(1, state.week - 1); state.block = e.blockOf(state.week); render(); break;
    case 'nextWeek': state.week = Math.min(WEEKS, state.week + 1); state.block = e.blockOf(state.week); render(); break;
    case 'thisWeek': state.week = e.currentWeek; state.block = e.blockOf(state.week); render(); break;
    case 'prevBlock': state.block = Math.max(1, state.block - 1); render(); break;
    case 'nextBlock': state.block = Math.min(e.blockCount, state.block + 1); render(); break;
    case 'prevMonth': state.month = Math.max(1, state.month - 1); render(); break;
    case 'nextMonth': state.month = Math.min(12, state.month + 1); render(); break;
    case 'catTx': categoryEntries(t.dataset.cat, t.dataset.from, t.dataset.to); break;
    case 'tab': state.tab = t.dataset.tab; render(); window.scrollTo({ top: 0 }); break;
    case 'filter': state.filter = t.dataset.f; render(); break;
    case 'insights': state.insights = t.dataset.m; render(); break;
    case 'edit': { const tx = state.snapshot.transactions.find((x) => x.id === t.dataset.id); if (tx) entrySheet(tx); break; }
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'search') return;
  state.search = ev.target.value;
  const { items, groups } = activityData();
  $('#groups').innerHTML = groupsHTML(groups);
  $('#actCount').textContent = countLabel(items.length);
});

$('#fab').addEventListener('click', () => entrySheet());
document.addEventListener('change', async (ev) => {
  if (ev.target.id !== 'welcomeRestore') return;
  const file = ev.target.files?.[0]; if (!file) return;
  try { const snap = fromBackup(await file.text()); useMode('local', snap); toast(`Welcome back · ${snap.transactions.length} entries restored`); }
  catch (err) { toast(err.message, 'bad'); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh({ quiet: true }); });

// ───────────────────────────────────────────── boot

(function boot() {
  // Coming back from Google's sign-in page?
  const back = g.handleRedirect();
  // Earlier versions had no mode flag: a saved URL means the Apps Script sheet.
  if (!mode() && store.get(LS.url) && store.get(LS.token)) store.set(LS.mode, 'sheet');
  const m = mode();
  if (m === 'local') { const s = loadLocal(); if (s) setSnapshot(s); else store.set(LS.mode, null); }
  else if (m === 'sheet' || m === 'google') {
    const cached = store.get(LS.cache);
    try { setSnapshot(cached ? JSON.parse(cached) : starterSnapshot()); } catch { setSnapshot(starterSnapshot()); }
  } else if (m === 'demo') setSnapshot(demoSnapshot());

  if (back) {
    if (!state.engine) setSnapshot(isLocal() ? loadLocal() || starterSnapshot() : starterSnapshot());
    render();
    if (back.ok && (back.after === 'create' || back.after === 'pick')) googleConnect(back.after);
    else if (back.ok) refresh();
    else if (back.error !== 'interaction_required' && back.error !== 'login_required' && back.error !== 'consent_required') {
      toast(back.error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in did not finish. Try again.', 'bad');
    }
  } else {
    // Google tokens last an hour; renew quietly once per launch if we've signed in before.
    if (m === 'google' && !g.hasToken() && g.trySilentRefresh('sync')) return;
    render();
    refresh({ quiet: true });
  }
  track.ping(mode());
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
