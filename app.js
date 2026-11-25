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
import { $, openSheet, closeSheet, toast, initNativeFeel } from './ui.js';

/**
 * Hesab — main app orchestrator
 *
 * Architecture (v27 refactor):
 *   engine.js   pure budget math (weeks, remaining, pace, month reports)
 *   data.js     localStorage + CSV + full backup
 *   api.js      Apps Script client (legacy sheet mode)
 *   google.js   Google Sign-In + Sheets API
 *   lists.js    shopping lists
 *   charts.js   SVG charts
 *   format.js   money / dates / category colors
 *   icons.js    SVG icons
 *   install.js  Add-to-Home-Screen helpers
 *   ui.js       openSheet / closeSheet / toast / native-feel  ← extracted
 *   app.js      state, sync, mutations, views, bottom-sheet content, events, boot
 *
 * Data modes: local | google | sheet | demo
 */

// PLACEHOLDER_FOR_REST_OF_FILE_WILL_BE_REPLACED
