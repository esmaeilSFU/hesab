// "Sign in with Google" sync: OAuth (redirect flow, works in iPhone Home Screen apps),
// Google Picker to choose a spreadsheet, and direct Sheets API calls from the phone.
// Scope is drive.file: the app can only open sheets the user picks or that it created.
import { ApiError } from './api.js';
import { todayISO } from './engine.js';

export const GOOGLE = {
  clientId: '245754808267-njukruqopk9hqrclcoil0htdtlg559fo.apps.googleusercontent.com',
  apiKey: 'AIzaSyDk0mK8YfxHjVHp7b4B4DxW_wYNJGhYyf8', // restricted to the Picker API on esmaeilsfu.github.io
  appId: '245754808267',
  scope: 'https://www.googleapis.com/auth/drive.file',
};

const K = { token: 'hesab.g.token', exp: 'hesab.g.exp', state: 'hesab.g.state', sheet: 'hesab.g.sheet', after: 'hesab.g.after', silent: 'hesab.g.silentTried' };
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

export const redirectURI = () => location.origin + location.pathname.replace(/index\.html$/, '');

// ───────────── auth

export function token() {
  const t = ls.get(K.token), exp = Number(ls.get(K.exp) || 0);
  return t && exp - Date.now() > 60_000 ? t : null;
}
export const hasToken = () => !!token();
export const signedInBefore = () => !!ls.get(K.exp);

/** Sends the browser to Google. `after` is remembered and returned by handleRedirect(). */
export function signIn({ silent = false, after = '' } = {}) {
  const state = crypto.getRandomValues(new Uint32Array(2)).join('-');
  ls.set(K.state, state);
  ls.set(K.after, after);
  const p = new URLSearchParams({
    client_id: GOOGLE.clientId, redirect_uri: redirectURI(), response_type: 'token',
    scope: GOOGLE.scope, include_granted_scopes: 'true', state,
  });
  if (silent) p.set('prompt', 'none');
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p);
}

/** Call once on load. Returns { ok, after, error } when we just came back from Google, else null. */
export function handleRedirect() {
  if (!location.hash.includes('state=')) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  const expected = ls.get(K.state);
  ls.set(K.state, null);
  const after = ls.get(K.after) || '';
  ls.set(K.after, null);
  if (!expected || h.get('state') !== expected) return { ok: false, after, error: 'state' };
  if (h.get('error')) return { ok: false, after, error: h.get('error') };
  const t = h.get('access_token');
  if (!t) return { ok: false, after, error: 'no_token' };
  ls.set(K.token, t);
  ls.set(K.exp, String(Date.now() + Number(h.get('expires_in') || 3600) * 1000));
  ls.set(K.silent, null);
  return { ok: true, after };
}

/** Tries a silent sign-in at most once per app launch. Returns true if it navigated away. */
export function trySilentRefresh(after = '') {
  if (hasToken() || !signedInBefore() || sessionStorage.getItem(K.silent)) return false;
  sessionStorage.setItem(K.silent, '1');
  signIn({ silent: true, after });
  return true;
}

export function signOut() {
  const t = ls.get(K.token);
  if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST', mode: 'no-cors' }).catch(() => {});
  [K.token, K.exp, K.sheet, K.after].forEach((k) => ls.set(k, null));
}

// ───────────── chosen sheet

export const chosenSheet = () => { try { return JSON.parse(ls.get(K.sheet)); } catch { return null; } };
export const setChosenSheet = (s) => ls.set(K.sheet, s ? JSON.stringify(s) : null);

// ───────────── Picker

let pickerReady = null;
function loadPicker() {
  if (pickerReady) return pickerReady;
  pickerReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.onload = () => window.gapi.load('picker', { callback: resolve, onerror: reject });
    s.onerror = () => { pickerReady = null; reject(new Error('Could not load Google Picker.')); };
    document.head.appendChild(s);
  });
  return pickerReady;
}

/** Opens Google's file picker filtered to spreadsheets. Resolves { id, name } or null. */
export async function pickSheet() {
  const t = token();
  if (!t) throw new ApiError('auth', 'Sign in with Google first.');
  await loadPicker();
  const g = window.google.picker;
  return new Promise((resolve) => {
    const view = new g.DocsView(g.ViewId.SPREADSHEETS).setMode(g.DocsViewMode.LIST).setIncludeFolders(true);
    const picker = new g.PickerBuilder()
      .addView(view)
      .setOAuthToken(t)
      .setDeveloperKey(GOOGLE.apiKey)
      .setAppId(GOOGLE.appId)
      .setTitle('Choose your Hesab sheet')
      .setSize(Math.min(window.innerWidth - 20, 1051), Math.min(window.innerHeight - 40, 650))
      .setCallback((d) => {
        if (d.action === g.Action.PICKED) resolve({ id: d.docs[0].id, name: d.docs[0].name });
        else if (d.action === g.Action.CANCEL) resolve(null);
      })
      .build();
    picker.setVisible(true);
  });
}

/** Google's Picker runs in a cross-site iframe that needs Google cookies; iPhone/iPad Safari blocks them. */
export const pickerWorks = () => !(/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/** Spreadsheets this app can already open (created by Hesab, or chosen once in the Picker on any device). */
export async function listAppSheets() {
  const t = token();
  if (!t) throw new ApiError('auth', 'Sign in with Google first.');
  const qs = new URLSearchParams({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: 'files(id,name,modifiedTime)', orderBy: 'modifiedTime desc', pageSize: '25',
  });
  let res;
  try { res = await fetch('https://www.googleapis.com/drive/v3/files?' + qs, { headers: { Authorization: 'Bearer ' + t } }); }
  catch { throw new ApiError('network', navigator.onLine ? 'Could not reach Google.' : 'You are offline.'); }
  if (res.status === 401) { ls.set(K.exp, String(Date.now())); throw new ApiError('auth', 'Your Google sign-in expired.'); }
  if (!res.ok) throw new ApiError('google', `Google returned an error (${res.status}).`);
  return ((await res.json()).files || []).map((f) => ({ id: f.id, name: f.name, modified: f.modifiedTime }));
}

/** Accepts a full Google Sheets link or a bare spreadsheet id. */
export function sheetIdFromLink(s) {
  const m = String(s || '').trim().match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/) || String(s || '').trim().match(/^([a-zA-Z0-9_-]{30,})$/);
  return m ? m[1] : null;
}

// ───────────── Sheets API

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';
const LEDGER_HEAD = ['Timestamp', 'Date', 'Amount', 'Type', 'Expense Type', 'Category', 'Note'];

async function call(path, { method = 'GET', body } = {}) {
  const t = token();
  if (!t) throw new ApiError('auth', 'Your Google sign-in expired.');
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('network', navigator.onLine ? 'Could not reach Google.' : 'You are offline.');
  }
  if (res.status === 401) { ls.set(K.exp, String(Date.now())); throw new ApiError('auth', 'Your Google sign-in expired.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 || res.status === 404) throw new ApiError('access', 'Hesab can\'t open this sheet anymore. Choose it again in Settings.');
    throw new ApiError('google', json.error?.message || `Google returned an error (${res.status}).`);
  }
  return json;
}

// Google stores dates as days since 1899-12-30.
const EPOCH = Date.UTC(1899, 11, 30);
const serialToISO = (n) => new Date(EPOCH + Math.round(Number(n)) * 86400000).toISOString().slice(0, 10);
const serialToMs = (n) => EPOCH + Number(n) * 86400000; // local wall time, treated as UTC
const pad = (n) => String(n).padStart(2, '0');
// Dates are written as raw serial numbers so the sheet's own date format applies (same as Form entries).
const dateSerial = (iso) => { const [y, m, d] = iso.split('-').map(Number); return (Date.UTC(y, m - 1, d) - EPOCH) / 86400000; };
const nowSerial = (d = new Date()) => (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - EPOCH) / 86400000;
const q = (s) => encodeURIComponent(s);

/** Client with the same shape as the Apps Script Api: bootstrap / add / update / remove / setBudget. */
export class SheetsClient {
  constructor(sheet) { this.id = sheet.id; this.name = sheet.name; this.meta = null; }

  async #meta() {
    if (this.meta) return this.meta;
    const m = await call(`${this.id}?fields=properties(title,timeZone),sheets(properties(sheetId,title))`);
    const tabs = Object.fromEntries(m.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
    for (const need of ['Ledger', 'Categories', 'Budget']) {
      if (!(need in tabs)) throw new ApiError('format', `"${m.properties.title}" has no ${need} tab, so it isn't a Hesab sheet. Choose another sheet or create a new one.`);
    }
    this.meta = { title: m.properties.title, tz: m.properties.timeZone, tabs, template: '_hesab' in tabs };
    return this.meta;
  }

  async bootstrap() {
    const meta = await this.#meta();
    const ranges = ['Ledger!A2:G', 'Categories!A2:C', 'Budget!A2:C'];
    const hasYear = 'Weekly_Control' in meta.tabs, hasBlock = '4Week_Report' in meta.tabs;
    if (hasYear) ranges.push('Weekly_Control!B1');
    if (hasBlock) ranges.push('4Week_Report!D2');
    const r = await call(`${this.id}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&${ranges.map((x) => 'ranges=' + q(x)).join('&')}`);
    const v = (i) => r.valueRanges[i]?.values || [];

    const categories = v(1).map((row, i) => ({ name: String(row[0] ?? '').trim(), type: String(row[1] ?? '').trim(), expenseType: String(row[2] ?? '').trim(), order: i + 1 }))
      .filter((c) => c.name);
    const meta2 = Object.fromEntries(categories.map((c) => [c.name, c]));
    const budget = v(2).map((row) => ({ category: String(row[0] ?? '').trim(), weeklyTarget: Number(row[1]) || 0, monthlyPlan: Number(row[2]) || 0 }))
      .filter((b) => b.category && b.category.toLowerCase() !== 'total');

    const transactions = [];
    v(0).forEach((row, i) => {
      const [ts, date, amount, type, expType, cat, note] = row;
      if ((ts === '' || ts == null) && (amount === '' || amount == null)) return;
      const category = String(cat ?? '').trim();
      const m = meta2[category] || {};
      const tsNum = typeof ts === 'number' ? ts : null;
      transactions.push({
        row: i + 2,
        id: tsNum != null ? 's' + tsNum : 'row-' + (i + 2),
        timestamp: tsNum != null ? new Date(serialToMs(tsNum)).toISOString() : null,
        date: typeof date === 'number' ? serialToISO(date) : tsNum != null ? serialToISO(Math.floor(tsNum)) : todayISO(),
        amount: Number(amount) || 0,
        type: String(type || m.type || '').trim(),
        expenseType: String(expType || m.expenseType || '').trim(),
        category,
        note: String(note ?? ''),
      });
    });

    const thisYear = Number(todayISO().slice(0, 4));
    return {
      year: hasYear ? Number(v(3)[0]?.[0]) || thisYear : thisYear,
      weeksPerBlock: hasBlock ? Number(v(hasYear ? 4 : 3)[0]?.[0]) || 4 : 4,
      timeZone: meta.tz,
      categories, budget, transactions,
      sheet: { id: this.id, title: meta.title, template: meta.template },
    };
  }

  #row(entry, cats, ts) {
    const c = cats.find((x) => x.name === entry.category) || {};
    return [ts, dateSerial(entry.date), entry.amount, c.type || 'Expense', c.expenseType || '', entry.category, entry.note || ''];
  }

  async #categories() {
    const r = await call(`${this.id}/values/${q('Categories!A2:C')}?valueRenderOption=UNFORMATTED_VALUE`);
    return (r.values || []).map((row) => ({ name: String(row[0] ?? '').trim(), type: String(row[1] ?? '').trim(), expenseType: String(row[2] ?? '').trim() }));
  }

  async add(entry) {
    await this.#meta();
    const values = [this.#row(entry, await this.#categories(), nowSerial())];
    const r = await call(`${this.id}/values/${q('Ledger!A:G')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=true&responseValueRenderOption=UNFORMATTED_VALUE`, { method: 'POST', body: { values } });
    const range = r.updates?.updatedRange || '';
    const row = Number((range.match(/!A(\d+)/) || [])[1]) || -1;
    const tsVal = r.updates?.updatedData?.values?.[0]?.[0];
    const c = values[0];
    return { row, id: typeof tsVal === 'number' ? 's' + tsVal : 'row-' + row, timestamp: new Date().toISOString(),
      date: entry.date, amount: entry.amount, type: c[3], expenseType: c[4], category: entry.category, note: entry.note || '' };
  }

  async #resolveRow(tx) {
    const r = await call(`${this.id}/values/${q('Ledger!A2:A')}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
    const col = (r.values || []).map((x) => x[0]);
    const key = (v, i) => (typeof v === 'number' ? 's' + v : 'row-' + (i + 2));
    if (tx.row >= 2 && key(col[tx.row - 2], tx.row - 2) === tx.id) return tx.row;
    const i = col.findIndex((v, j) => key(v, j) === tx.id && tx.id.startsWith('s'));
    if (i >= 0) return i + 2;
    throw new ApiError('stale', 'This entry changed in the sheet. Pull to refresh and try again.');
  }

  async update(tx, entry) {
    await this.#meta();
    const row = await this.#resolveRow(tx);
    const c = this.#row(entry, await this.#categories(), null);
    await call(`${this.id}/values/${q(`Ledger!B${row}:G${row}`)}?valueInputOption=RAW`, { method: 'PUT', body: { values: [c.slice(1)] } });
    return { ...tx, row, date: entry.date, amount: entry.amount, type: c[3], expenseType: c[4], category: entry.category, note: entry.note || '' };
  }

  async remove(tx) {
    const meta = await this.#meta();
    const row = await this.#resolveRow(tx);
    await call(`${this.id}:batchUpdate`, { method: 'POST', body: { requests: [{ deleteDimension: { range: { sheetId: meta.tabs.Ledger, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }] } });
    return { deleted: true };
  }

  /** Writes one Budget cell for a category: column B (weekly target) or C (monthly plan). */
  async #budgetCell(category, col, value) {
    const r = await call(`${this.id}/values/${q('Budget!A1:A')}?valueRenderOption=UNFORMATTED_VALUE`);
    const rows = r.values || [];
    const i = rows.findIndex((x) => String(x[0] ?? '').trim() === category);
    if (i < 1) {
      const meta = await this.#meta();
      if (!meta.template) throw new ApiError('not_found', `"${category}" is not in the Budget tab of your sheet.`);
      const row = rows.length + 1;
      await call(`${this.id}/values/${q(`Budget!A${row}:C${row}`)}?valueInputOption=RAW`, { method: 'PUT', body: { values: [[category, col === 'B' ? value : '', col === 'C' ? value : '']] } });
      return;
    }
    await call(`${this.id}/values/${q(`Budget!${col}${i + 1}`)}?valueInputOption=RAW`, { method: 'PUT', body: { values: [[value]] } });
  }
  setBudget(category, weeklyTarget) { return this.#budgetCell(category, 'B', weeklyTarget); }
  setPlan(category, monthlyPlan) { return this.#budgetCell(category, 'C', monthlyPlan); }

  /** Only for sheets Hesab created: rewrites Categories and Budget, and renames categories in the Ledger. */
  async saveCategories(snapshot, renames = {}) {
    const meta = await this.#meta();
    if (!meta.template) throw new ApiError('format', 'Categories of this sheet are edited in the sheet itself.');
    const cats = [...snapshot.categories].sort((a, b) => a.order - b.order);
    const isVar = (c) => c.type === 'Expense' && c.expenseType === 'Variable';
    const budget = cats.map((c) => {
      const b = snapshot.budget.find((x) => x.category === c.name) || {};
      return [c.name, isVar(c) ? b.weeklyTarget || 0 : '', !isVar(c) && b.monthlyPlan ? b.monthlyPlan : ''];
    }).filter((r) => r[1] !== '' || r[2] !== '');
    const data = [
      { range: 'Categories!A2:C', values: cats.map((c) => [c.name, c.type, c.expenseType]) },
      { range: 'Budget!A2:C', values: budget },
    ];
    // Keep every Ledger row in step: renamed categories get the new name, and rows whose stored
    // Type / Expense Type no longer match their category (its kind was changed) are corrected.
    const byName = Object.fromEntries(cats.map((c) => [c.name, c]));
    const ledger = (await call(`${this.id}/values/${q('Ledger!D2:F')}`)).values || [];
    ledger.forEach((r, i) => {
      const was = String(r[2] ?? '').trim();
      const name = renames[was] || was;
      const c = byName[name];
      if (!was) return;
      if (name !== was) data.push({ range: `Ledger!F${i + 2}`, values: [[name]] });
      const stored = [String(r[0] ?? '').trim(), String(r[1] ?? '').trim()];
      // Blank Type cells are filled by the sheet from the Categories tab, so only stored values need fixing.
      if (c && (stored[0] || stored[1]) && (stored[0] !== c.type || stored[1] !== c.expenseType)) {
        data.push({ range: `Ledger!D${i + 2}:E${i + 2}`, values: [[c.type, c.expenseType]] });
      }
    });
    await call(`${this.id}/values:batchClear`, { method: 'POST', body: { ranges: ['Categories!A2:C', 'Budget!A2:C'] } });
    await call(`${this.id}/values:batchUpdate`, { method: 'POST', body: { valueInputOption: 'RAW', data } });
  }
}

/** Creates a fresh Hesab spreadsheet in the user's Drive from a starter snapshot. */
export async function createSheet(starter) {
  const cats = [...starter.categories].sort((a, b) => a.order - b.order);
  const head = (cells) => ({ values: cells.map((v) => ({ userEnteredValue: { stringValue: v }, userEnteredFormat: { textFormat: { bold: true } } })) });
  const rows = (arr) => arr.map((r) => ({ values: r.map((v) => (typeof v === 'number' ? { userEnteredValue: { numberValue: v } } : { userEnteredValue: { stringValue: String(v) } })) }));
  const body = {
    properties: { title: 'Hesab' },
    sheets: [
      { properties: { sheetId: 1, title: 'Ledger', gridProperties: { frozenRowCount: 1 } }, data: [{ rowData: [head(LEDGER_HEAD)] }] },
      { properties: { sheetId: 2, title: 'Categories', gridProperties: { frozenRowCount: 1 } }, data: [{ rowData: [head(['Category', 'Type', 'Expense Type']), ...rows(cats.map((c) => [c.name, c.type, c.expenseType]))] }] },
      { properties: { sheetId: 3, title: 'Budget', gridProperties: { frozenRowCount: 1 } }, data: [{ rowData: [head(['Category', 'Weekly Target', 'Monthly Plan']), ...rows(starter.budget.map((b) => [b.category, b.weeklyTarget || '', b.monthlyPlan || '']))] }] },
      { properties: { sheetId: 4, title: '_hesab', hidden: true }, data: [{ rowData: rows([['Created by Hesab', 'https://esmaeilsfu.github.io/hesab/'], ['Do not rename the Ledger, Categories or Budget tabs.', '']]) }] },
    ],
  };
  const t = token();
  if (!t) throw new ApiError('auth', 'Sign in with Google first.');
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError('google', json.error?.message || 'Could not create the sheet.');
  // Date-friendly formats for the Ledger.
  await call(`${json.spreadsheetId}:batchUpdate`, { method: 'POST', body: { requests: [
    { repeatCell: { range: { sheetId: 1, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { repeatCell: { range: { sheetId: 1, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { repeatCell: { range: { sheetId: 1, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 }, cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '$#,##0.00' } } }, fields: 'userEnteredFormat.numberFormat' } },
  ] } }).catch(() => {});
  return { id: json.spreadsheetId, name: json.properties?.title || 'Hesab' };
}
