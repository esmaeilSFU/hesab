/**
 * Hesab API — Google Apps Script backend for a Hesab budget sheet.
 *
 * Install:
 *   1. Open the spreadsheet → Extensions → Apps Script. Paste this file as Code.gs.
 *   2. Run `setupToken` once (Run ▶). Approve the permissions. Copy the token from
 *      View → Logs (or Executions). You will paste it into the app's Settings.
 *   3. Deploy → New deployment → type "Web app".
 *        Execute as: Me    Who has access: Anyone
 *      Copy the Web app URL (ends with /exec) into the app's Settings.
 *
 * The app reads raw rows and computes reports itself, so the sheet tabs and
 * formulas keep working exactly as before. Writes go to the Ledger tab (the
 * Google Form response sheet) in the same column layout the form uses.
 */

var SHEETS = {
  ledger: 'Ledger',
  categories: 'Categories',
  budget: 'Budget',
  control: 'Weekly_Control',
  block: '4Week_Report'
};

// Ledger columns (1-based): Timestamp, Date, Amount, Type, Expense Type, Category, Note
var COL = { ts: 1, date: 2, amount: 3, type: 4, expenseType: 5, category: 6, note: 7 };
var LEDGER_WIDTH = 7;

/* ------------------------------------------------------------------ setup */

function setupToken() {
  var token = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', token);
  Logger.log('Your Hesab API token: ' + token);
  return token;
}

/* -------------------------------------------------------------- endpoints */

function doGet(e) {
  return handle_(function () {
    var p = (e && e.parameter) || {};
    checkToken_(p.token);
    var action = p.action || 'bootstrap';
    if (action === 'bootstrap') return bootstrap_();
    if (action === 'ping') return { pong: true };
    throw apiError_('unknown_action', 'Unknown action: ' + action);
  });
}

function doPost(e) {
  return handle_(function () {
    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
    checkToken_(body.token);

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (body.action) {
        case 'add': return { transaction: addEntry_(body.entry) };
        case 'update': return { transaction: updateEntry_(body.row, body.id, body.entry) };
        case 'delete': deleteEntry_(body.row, body.id); return { deleted: true };
        case 'setBudget': return { budget: setBudget_(body.category, body.weeklyTarget) };
        default: throw apiError_('unknown_action', 'Unknown action: ' + body.action);
      }
    } finally {
      SpreadsheetApp.flush();
      lock.releaseLock();
    }
  });
}

/* ------------------------------------------------------------------ reads */

function bootstrap_() {
  var ss = SpreadsheetApp.getActive();
  var tz = ss.getSpreadsheetTimeZone();

  var year = Number(ss.getSheetByName(SHEETS.control).getRange('B1').getValue()) || new Date().getFullYear();
  var weeksPerBlock = Number(ss.getSheetByName(SHEETS.block).getRange('D2').getValue()) || 4;

  return {
    year: year,
    weeksPerBlock: weeksPerBlock,
    timeZone: tz,
    categories: readCategories_(),
    budget: readBudget_(),
    transactions: readTransactions_(tz),
    serverTime: new Date().toISOString()
  };
}

function readCategories_() {
  var values = SpreadsheetApp.getActive().getSheetByName(SHEETS.categories).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var name = String(values[i][0] || '').trim();
    if (!name) continue;
    out.push({
      name: name,
      type: String(values[i][1] || '').trim(),          // Expense | Income
      expenseType: String(values[i][2] || '').trim(),   // Fixed | Variable | ''
      order: i
    });
  }
  return out;
}

function readBudget_() {
  var values = SpreadsheetApp.getActive().getSheetByName(SHEETS.budget).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var name = String(values[i][0] || '').trim();
    if (!name || name.toLowerCase() === 'total') continue;
    out.push({ category: name, weeklyTarget: Number(values[i][1]) || 0 });
  }
  return out;
}

function readTransactions_(tz) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.ledger);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, LEDGER_WIDTH).getValues();
  var catMap = categoryMap_();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (!r[COL.ts - 1] && r[COL.amount - 1] === '') continue;
    out.push(rowToTransaction_(r, i + 2, tz, catMap));
  }
  return out;
}

function rowToTransaction_(r, rowNumber, tz, catMap) {
  var ts = r[COL.ts - 1] instanceof Date ? r[COL.ts - 1] : null;
  var d = r[COL.date - 1] instanceof Date ? r[COL.date - 1] : ts;
  var category = String(r[COL.category - 1] || '').trim();
  var meta = catMap[category] || {};
  return {
    row: rowNumber,
    id: ts ? String(ts.getTime()) : 'row-' + rowNumber,
    timestamp: ts ? ts.toISOString() : null,
    date: d ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : null,
    amount: Number(r[COL.amount - 1]) || 0,
    type: String(r[COL.type - 1] || meta.type || '').trim(),
    expenseType: String(r[COL.expenseType - 1] || meta.expenseType || '').trim(),
    category: category,
    note: String(r[COL.note - 1] || '')
  };
}

function categoryMap_() {
  var map = {};
  readCategories_().forEach(function (c) { map[c.name] = c; });
  return map;
}

/* ----------------------------------------------------------------- writes */

function addEntry_(entry) {
  var clean = validateEntry_(entry);
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.ledger);
  var now = new Date();
  var row = [now, clean.date, clean.amount, clean.type, clean.expenseType, clean.category, clean.note];
  var target = sheet.getLastRow() + 1;
  sheet.getRange(target, 1, 1, LEDGER_WIDTH).setValues([row]);
  sheet.getRange(target, COL.date).setNumberFormat('m/d/yyyy');
  return rowToTransaction_(row, target, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), categoryMap_());
}

function updateEntry_(rowNumber, id, entry) {
  var clean = validateEntry_(entry);
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.ledger);
  var target = resolveRow_(sheet, rowNumber, id);
  var range = sheet.getRange(target, 1, 1, LEDGER_WIDTH);
  var current = range.getValues()[0];
  var row = [current[0], clean.date, clean.amount, clean.type, clean.expenseType, clean.category, clean.note];
  range.setValues([row]);
  return rowToTransaction_(row, target, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), categoryMap_());
}

function deleteEntry_(rowNumber, id) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.ledger);
  sheet.deleteRow(resolveRow_(sheet, rowNumber, id));
}

function setBudget_(category, weeklyTarget) {
  var value = Number(weeklyTarget);
  if (!(value >= 0)) throw apiError_('invalid', 'Weekly target must be 0 or more.');
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.budget);
  var names = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  for (var i = 1; i < names.length; i++) {
    if (String(names[i][0]).trim() === category) {
      sheet.getRange(i + 1, 2).setValue(value);
      return { category: category, weeklyTarget: value };
    }
  }
  throw apiError_('not_found', 'Category is not in the Budget tab: ' + category);
}

/** Finds the row for a transaction, guarding against rows that moved since the app last synced. */
function resolveRow_(sheet, rowNumber, id) {
  var last = sheet.getLastRow();
  var matches = function (r) {
    if (r < 2 || r > last) return false;
    var ts = sheet.getRange(r, COL.ts).getValue();
    var key = ts instanceof Date ? String(ts.getTime()) : 'row-' + r;
    return key === String(id);
  };
  if (matches(Number(rowNumber))) return Number(rowNumber);
  if (String(id).indexOf('row-') !== 0 && last >= 2) {
    var stamps = sheet.getRange(2, COL.ts, last - 1, 1).getValues();
    for (var i = 0; i < stamps.length; i++) {
      if (stamps[i][0] instanceof Date && String(stamps[i][0].getTime()) === String(id)) return i + 2;
    }
  }
  throw apiError_('stale', 'This entry changed in the sheet. Pull to refresh and try again.');
}

function validateEntry_(entry) {
  if (!entry) throw apiError_('invalid', 'Missing entry.');
  var amount = Number(entry.amount);
  if (!(amount > 0)) throw apiError_('invalid', 'Amount must be greater than 0.');
  amount = Math.round(amount * 100) / 100;

  var category = String(entry.category || '').trim();
  var meta = categoryMap_()[category];
  if (!meta) throw apiError_('invalid', 'Unknown category: ' + category);

  var date;
  if (entry.date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(entry.date));
    if (!m) throw apiError_('invalid', 'Date must be YYYY-MM-DD.');
    date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else {
    var now = new Date();
    date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  return {
    amount: amount,
    category: category,
    type: meta.type,
    expenseType: meta.expenseType,
    date: date,
    note: String(entry.note || '').slice(0, 500)
  };
}

/* ---------------------------------------------------------------- helpers */

function checkToken_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!expected) throw apiError_('setup', 'Run setupToken() in the Apps Script editor first.');
  if (!token || String(token) !== expected) throw apiError_('unauthorized', 'Invalid token.');
}

function apiError_(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function handle_(fn) {
  var payload;
  try {
    payload = { ok: true, data: fn() };
  } catch (err) {
    payload = { ok: false, error: { code: err.code || 'server', message: String(err.message || err) } };
  }
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
