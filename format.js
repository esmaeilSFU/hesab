import { parseISO, todayISO, addDays } from './engine.js';

const fmt0 = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0, minimumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2, minimumFractionDigits: 2 });

export function money(v, { cents, sign } = {}) {
  const showCents = cents ?? Math.round(v) !== Math.round(v * 100) / 100;
  const s = (showCents ? fmt2 : fmt0).format(Math.abs(v));
  if (v < -0.004) return '−' + s;
  return sign && v > 0.004 ? '+' + s : s;
}

export function compact(v) {
  const a = Math.abs(v);
  const s = a >= 1000 ? '$' + (a / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : '$' + Math.round(a);
  return v < 0 ? '−' + s : s;
}

const md = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric' });
const wd = new Intl.DateTimeFormat('en-CA', { weekday: 'long' });
const wdShort = new Intl.DateTimeFormat('en-CA', { weekday: 'narrow' });
const mon = new Intl.DateTimeFormat('en-CA', { month: 'short' });

export const shortDate = (iso) => md.format(parseISO(iso));
export const weekdayNarrow = (iso) => wdShort.format(parseISO(iso));
export const monthShort = (m) => mon.format(new Date(2026, m - 1, 1));

export function dayTitle(iso) {
  const t = todayISO();
  if (iso === t) return 'Today';
  if (iso === addDays(t, -1)) return 'Yesterday';
  const d = parseISO(iso);
  const days = (parseISO(t) - d) / 86400000;
  return days < 7 && days > 0 ? wd.format(d) : md.format(d) + (d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : '');
}

export function weekRange(days) {
  const a = parseISO(days[0]), b = parseISO(days[6]);
  const sameMonth = a.getMonth() === b.getMonth();
  return sameMonth ? `${md.format(a)} – ${b.getDate()}` : `${md.format(a)} – ${md.format(b)}`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- category look ----
// Exact names first, then keywords, so custom categories still get a fitting icon.
const STYLE = {
  'Rent': ['house', '#6E6AF0'], 'Car Payment': ['car', '#5B8DEF'], 'Car Insurance': ['shield', '#4FA3C7'], 'Insurance': ['shield', '#4FA3C7'],
  'Phone': ['phone', '#7C8AA5'], 'Internet': ['wifi', '#5AA9E6'], 'Electricity': ['bolt', '#E0A93B'], 'Utilities': ['bolt', '#E0A93B'],
  'Memberships': ['star', '#B08AE0'], 'Subscriptions': ['star', '#B08AE0'], 'Grocery': ['cart', '#3FB37F'], 'Gas': ['fuel', '#F08A4B'],
  'Food & Cafe': ['cup', '#C98552'], 'Personal Stuff': ['bag', '#E26D9C'], 'Personal': ['bag', '#E26D9C'], 'Entertainment': ['sparkle', '#9B6CE8'],
  'Gifts': ['gift', '#EF5B6B'], 'Transportation': ['tram', '#3E9FB8'], 'Home & Household': ['sofa', '#8C9F5A'],
  'ETC': ['dots', '#8E8E93'], 'Other': ['dots', '#8E8E93'],
};
const KEYWORDS = [
  [/income|salary|paycheck|wage|bonus|refund/i, 'income', '#2F9BDB'], [/rent|mortgage|house/i, 'house', '#6E6AF0'],
  [/car|auto|vehicle/i, 'car', '#5B8DEF'], [/insur/i, 'shield', '#4FA3C7'], [/phone|mobile/i, 'phone', '#7C8AA5'],
  [/internet|wifi/i, 'wifi', '#5AA9E6'], [/electric|hydro|utilit|power|water/i, 'bolt', '#E0A93B'],
  [/subscri|member|netflix|spotify|gym/i, 'star', '#B08AE0'], [/grocer|market|supermarket/i, 'cart', '#3FB37F'],
  [/gas|fuel|petrol/i, 'fuel', '#F08A4B'], [/food|cafe|coffee|restaurant|dining|eat/i, 'cup', '#C98552'],
  [/cloth|shop|personal|beauty|care/i, 'bag', '#E26D9C'], [/fun|entertain|movie|game|travel|trip/i, 'sparkle', '#9B6CE8'],
  [/gift|donat|charity/i, 'gift', '#EF5B6B'], [/transport|transit|bus|train|taxi|uber|parking/i, 'tram', '#3E9FB8'],
  [/home|household|furnit|kitchen/i, 'sofa', '#8C9F5A'],
];
const PALETTE = ['#6E6AF0', '#3FB37F', '#F08A4B', '#E26D9C', '#3E9FB8', '#9B6CE8', '#C98552', '#5B8DEF', '#8C9F5A', '#EF5B6B'];

export function catStyle(name) {
  if (STYLE[name]) return { icon: STYLE[name][0], color: STYLE[name][1] };
  for (const [re, ic, color] of KEYWORDS) if (re.test(name)) return { icon: ic, color };
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { icon: 'tag', color: PALETTE[h % PALETTE.length] };
}
