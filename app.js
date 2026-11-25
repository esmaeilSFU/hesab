import { Engine, todayISO, kindOf, isIncome, isVariable, isFixed, isInvest, parseRepeat, repeatValue, repeatLabel, repeatDates, ordinal, addDays, ESTIMATED, isEstimated } from './engine.js';
import { Api } from './api.js';
import { demoSnapshot } from './demo.js';
import { starterSnapshot, loadLocal, saveLocal, clearLocal, newId, toCSV, importCSV, toBackup, fromBackup, saveFile } from './data.js';
import { money, compact, shortDate, dayTitle, weekRange, esc, catStyle } from './format.js';
import { icon } from './icons.js';
import * as chart from './charts.js';
import * as install from './install.js';
import * as g from './google.js';
import * as track from './track.js';
import * as lists from './lists.js';

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
  month: 0,
  insights: 'month',
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

/** Joined someone's budget as a viewer: Google won't accept changes, so the app doesn't offer them. */
const VIEW_KEY = (id) => 'hesab.g.view.' + id;
const isViewOnly = () => isGoogle() && store.get(VIEW_KEY(g.chosenSheet()?.id || '')) === '1';
function viewOnlyStop() { if (!isViewOnly()) return false; toast('You can view this budget but not change it. Ask its owner for edit access.', 'bad'); return true; }

/** Shopping lists follow the budget: in Google Sheet mode they're saved in its "Lists" tab too. */
function wireLists() {
  const c = isGoogle() && g.hasToken() ? api() : null;
  lists.setRemote(c ? { pull: () => c.readLists(), push: (rows) => c.writeLists(rows), canWrite: !isViewOnly() } : null);
}

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
  if (m !== 'google' && prev === 'google') { g.signOut(); sheetsClient = null; lists.setRemote(null); }
  if (!isRemote()) { [LS.cache, LS.synced, LS.queue].forEach((k) => store.set(k, null)); state.synced = null; }
  setSnapshot(snap);
  render();
  if (prev !== m) track.event('mode-' + m, m);
}

// NOTE: This is a PARTIAL restore attempt. The full 122KB file exceeds the tool argument size limit in this session.
// The live app is currently loading the complete working version from the historical commit via index.html.
// Full file restore will be completed in the next step or via a different method.
console.warn('Hesab: app.js is a partial restore. Full version is loaded from historical commit via index.html.');
