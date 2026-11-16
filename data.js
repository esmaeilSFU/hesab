// On-device storage, starter categories, and CSV backup.
import { todayISO, parseRepeat, repeatValue } from './engine.js';

const KEY = 'hesab.local';

export function starterSnapshot() {
  const rows = [
    ['Rent', 'Expense', 'Fixed'], ['Car Payment', 'Expense', 'Fixed'], ['Insurance', 'Expense', 'Fixed'],
    ['Phone', 'Expense', 'Fixed'], ['Internet', 'Expense', 'Fixed'], ['Utilities', 'Expense', 'Fixed'],
    ['Subscriptions', 'Expense', 'Fixed'],
    ['Grocery', 'Expense', 'Variable'], ['Gas', 'Expense', 'Variable'], ['Food & Cafe', 'Expense', 'Variable'],
    ['Personal', 'Expense', 'Variable'], ['Entertainment', 'Expense', 'Variable'], ['Gifts', 'Expense', 'Variable'],
    ['Transportation', 'Expense', 'Variable'], ['Home & Household', 'Expense', 'Variable'], ['Other', 'Expense', 'Variable'],
    ['Salary', 'Income', ''], ['Other Income', 'Income', ''],
  ];
  const budget = { 'Grocery': 150, 'Gas': 40, 'Food & Cafe': 80, 'Personal': 60, 'Entertainment': 40, 'Gifts': 25, 'Transportation': 25, 'Home & Household': 40, 'Other': 50 };
  return {
    year: Number(todayISO().slice(0, 4)),
    weeksPerBlock: 4,
    categories: rows.map(([name, type, expenseType], i) => ({ name, type, expenseType, order: i + 1 })),
    budget: Object.entries(budget).map(([category, weeklyTarget]) => ({ category, weeklyTarget })),
    transactions: [],
  };
}

export function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (!s) return null;
    s.year = Number(todayISO().slice(0, 4)); // the budget year follows the calendar
    return s;
  } catch { return null; }
}

export function saveLocal(snap) {
  try { localStorage.setItem(KEY, JSON.stringify(snap)); return true; } catch { return false; }
}

export function clearLocal() { try { localStorage.removeItem(KEY); } catch {} }

export const newId = () => 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---- CSV ----

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCSV(snap) {
  const head = ['Date', 'Amount', 'Category', 'Type', 'Expense Type', 'Note'];
  const rows = [...snap.transactions]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((t) => [t.date, t.amount, t.category, t.type, t.expenseType, t.note].map(cell).join(','));
  return [head.join(','), ...rows].join('\n');
}

function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

function normDate(s) {
  s = String(s).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); // M/D/YYYY (Google Sheets, US)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/** Merges CSV rows into the snapshot. Unknown categories are created. Returns the number of rows added. */
export function importCSV(snap, text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('The file has no rows.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const iDate = col('date'), iAmt = col('amount'), iCat = col('category'), iType = col('type'),
    iExp = col('expense type', 'expensetype'), iNote = col('note', 'notes', 'description');
  if (iDate < 0 || iAmt < 0 || iCat < 0) throw new Error('Needs at least Date, Amount and Category columns.');

  const known = new Map(snap.categories.map((c) => [c.name.toLowerCase(), c]));
  const seen = new Set(snap.transactions.map((t) => `${t.date}|${t.amount}|${t.category}|${t.note}`));
  let added = 0;
  for (const r of rows.slice(1)) {
    const date = normDate(r[iDate] || '');
    const amount = Math.abs(Number(String(r[iAmt] || '').replace(/[$,\s]/g, '')));
    const name = String(r[iCat] || '').trim();
    if (!date || !(amount > 0) || !name) continue;
    let cat = known.get(name.toLowerCase());
    if (!cat) {
      const income = /income/i.test(r[iType] || '') || /income|salary/i.test(name);
      const fixed = /fixed/i.test(r[iExp] || '');
      cat = { name, type: income ? 'Income' : 'Expense', expenseType: income ? '' : fixed ? 'Fixed' : 'Variable', order: snap.categories.length + 1 };
      snap.categories.push(cat); known.set(name.toLowerCase(), cat);
    }
    const note = iNote >= 0 ? String(r[iNote] || '').trim() : '';
    const key = `${date}|${amount}|${cat.name}|${note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    snap.transactions.push({ row: -1, id: newId(), timestamp: new Date().toISOString(), date, amount,
      type: cat.type, expenseType: cat.expenseType, category: cat.name, note });
    added++;
  }
  return added;
}

// ---- full backup (everything: entries, categories, order, budgets) ----

export function toBackup(snap, lists = []) {
  return JSON.stringify({ app: 'hesab', version: 1, exportedAt: new Date().toISOString(), data: {
    lists, weeksPerBlock: snap.weeksPerBlock, categories: snap.categories, budget: snap.budget,
    transactions: snap.transactions.map(({ row, ...t }) => t),
  } }, null, 1);
}

export function fromBackup(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('This is not a Hesab backup file.'); }
  const d = j?.data;
  if (j?.app !== 'hesab' || !d || !Array.isArray(d.categories) || !Array.isArray(d.transactions) || !Array.isArray(d.budget)) {
    throw new Error('This is not a Hesab backup file.');
  }
  return {
    year: Number(todayISO().slice(0, 4)),
    weeksPerBlock: Number(d.weeksPerBlock) || 4,
    categories: d.categories.map((c, i) => ({ name: String(c.name), type: String(c.type || 'Expense'), expenseType: String(c.expenseType || ''), order: Number(c.order) || i + 1 })),
    budget: d.budget.map((b) => ({ category: String(b.category), weeklyTarget: Math.max(0, Number(b.weeklyTarget) || 0), monthlyPlan: Math.max(0, Number(b.monthlyPlan) || 0), repeat: repeatValue(parseRepeat(b.repeat ?? b.autoDay)) })),
    transactions: d.transactions.filter((t) => t && t.date && Number(t.amount) > 0).map((t) => ({
      row: 0, id: t.id ? String(t.id) : newId(), timestamp: t.timestamp || null, date: String(t.date), amount: Number(t.amount),
      type: String(t.type || ''), expenseType: String(t.expenseType || ''), category: String(t.category || ''), note: String(t.note || ''),
    })),
  };
}

/** Saves a file: the share sheet on phones (Save to Files, AirDrop, Mail…), a download elsewhere. */
export async function saveFile(name, text, mime) {
  const file = new File([text], name, { type: mime });
  if (/iPhone|iPad|iPod|Android/.test(navigator.userAgent) && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e?.name === 'AbortError') return false; }
  }
  download(name, text, mime);
  return true;
}

export function download(name, text, mime = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
