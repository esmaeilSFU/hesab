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
  const a = parseISO(days[0]), b = parseISO(days[days.length - 1]);
  const sameMonth = a.getMonth() === b.getMonth();
  return sameMonth ? `${md.format(a)} – ${b.getDate()}` : `${md.format(a)} – ${md.format(b)}`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- category look ----
// Exact names first, then keywords, so custom categories still get a fitting icon.
const STYLE = {
  'Rent': ['house', '#6A5A9E'], 'Car Payment': ['car', '#3F6A96'], 'Car Insurance': ['shield', '#3E7884'], 'Insurance': ['shield', '#3E7884'],
  'Phone': ['phone', '#6A6578'], 'Internet': ['wifi', '#3A7699'], 'Electricity': ['bolt', '#9A6A14'], 'Utilities': ['bolt', '#9A6A14'],
  'Memberships': ['star', '#86578F'], 'Subscriptions': ['star', '#86578F'], 'Grocery': ['cart', '#3F7A4E'], 'Gas': ['fuel', '#B05A2C'],
  'Food & Cafe': ['cup', '#8E5E36'], 'Personal Stuff': ['bag', '#A4486D'], 'Personal': ['bag', '#A4486D'], 'Entertainment': ['sparkle', '#6B56A3'],
  'Gifts': ['gift', '#A9464E'], 'Transportation': ['tram', '#2E7A7E'], 'Home & Household': ['sofa', '#66773A'],
  'ETC': ['dots', '#7A736C'], 'Other': ['dots', '#7A736C'],
};
const KEYWORDS = [
  [/invest|tfsa|rrsp|fhsa|resp|saving|emergency|stock|etf|retire/i, 'chart', '#1F6B55'], [/income|salary|paycheck|wage|bonus|refund/i, 'income', '#28745B'], [/rent|mortgage|house/i, 'house', '#6A5A9E'],
  [/car|auto|vehicle/i, 'car', '#3F6A96'], [/insur/i, 'shield', '#3E7884'], [/phone|mobile/i, 'phone', '#6A6578'],
  [/internet|wifi/i, 'wifi', '#3A7699'], [/electric|hydro|utilit|power|water/i, 'bolt', '#9A6A14'],
  [/subscri|member|netflix|spotify|gym/i, 'star', '#86578F'], [/grocer|market|supermarket/i, 'cart', '#3F7A4E'],
  [/gas|fuel|petrol/i, 'fuel', '#B05A2C'], [/food|cafe|coffee|restaurant|dining|eat/i, 'cup', '#8E5E36'],
  [/cloth|shop|personal|beauty|care/i, 'bag', '#A4486D'], [/fun|entertain|movie|game|travel|trip/i, 'sparkle', '#6B56A3'],
  [/gift|donat|charity/i, 'gift', '#A9464E'], [/transport|transit|bus|train|taxi|uber|parking/i, 'tram', '#2E7A7E'],
  [/home|household|furnit|kitchen/i, 'sofa', '#66773A'],
];
const PALETTE = ['#6A5A9E', '#3F7A4E', '#B05A2C', '#A4486D', '#2E7A7E', '#6B56A3', '#8E5E36', '#3F6A96', '#66773A', '#A9464E'];

export function catStyle(name) {
  if (STYLE[name]) return { icon: STYLE[name][0], color: STYLE[name][1] };
  for (const [re, ic, color] of KEYWORDS) if (re.test(name)) return { icon: ic, color };
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { icon: 'tag', color: PALETTE[h % PALETTE.length] };
}
