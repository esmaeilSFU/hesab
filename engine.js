// Budget engine — reproduces the spreadsheet's math so the app and the sheet agree.
//
//   week      = Monday-to-Sunday weeks (ISO 8601): week 1 is the week with the year's first Thursday,
//               so it can start in late December; a year has 52 or 53 weeks   (Ledger_Calc!H:J)
//   months    = calendar months, the 1st to the last day, kept separate from weeks
//   remaining = week 1: target − spent
//               later:  target + min(0, last week's remaining) − spent   (Weekly_Control!E)
//   savings   = sum of positive weekly remainders up to a week, counting only weeks with entries

/** Most weeks a year can have; each year has 52 or 53 (see weeksInYear). */
export const WEEKS = 53;

// ---- day helpers (dates are plain "YYYY-MM-DD" strings, no time zone) ----

export const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => isoOf(new Date());
export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}
export function dayIndex(iso) {
  const d = parseISO(iso);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  return Math.round((d - jan1) / 86400000);
}
/** Monday of week 1: the Monday on or before Jan 4. */
export function weekOneMonday(year) {
  const jan4 = new Date(year, 0, 4);
  return isoOf(new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7)));
}
/** The week-year and week number of a date (Mon–Sun weeks; Dec 29–31 can be week 1 of next year). */
export function isoWeek(iso) {
  const d = parseISO(iso);
  const thu = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) + 3);
  const year = thu.getFullYear();
  return { year, week: Math.round((thu - parseISO(weekOneMonday(year))) / 86400000 / 7) + 1 };
}
export const weeksInYear = (year) => isoWeek(`${year}-12-28`).week;
export const weekOf = (iso) => isoWeek(iso).week;
export const yearOf = (iso) => Number(iso.slice(0, 4));

// ---- repeating bills and income ----
// Stored in Budget column D: a day number (1–28) = every month on that day;
// "2w from 2026-11-06" = every 2 weeks from that date ("1w from …" = every week).
// "varies" added to either (or alone) = the amount changes each time (e.g. electricity): Hesab reminds
// you on the date and asks for the amount instead of recording a fixed one.
export function parseRepeat(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v.kind ? v : null;
  const n = Number(v);
  if (Number.isFinite(n)) return n >= 1 && n <= 28 ? { kind: 'month', day: Math.round(n), varies: false } : null;
  const t = String(v), varies = /varies/i.test(t), since = (t.match(/since\s+(\d{4}-\d{2})/i) || [])[1] || '';
  const w = t.match(/(\d)\s*w\D*(\d{4}-\d{2}-\d{2})/i);
  if (w && Number(w[1]) >= 1) return { kind: 'weeks', every: Number(w[1]), from: w[2], varies, since: w[2].slice(0, 7) };
  const d = t.match(/^\s*(\d{1,2})\b/);
  if (d && Number(d[1]) >= 1 && Number(d[1]) <= 28) return { kind: 'month', day: Number(d[1]), varies, since };
  return varies ? { kind: 'none', varies: true, since } : null;
}
// "since YYYY-MM" records the month a monthly item started repeating, so a missed month is only
// filled in for months after it was set up.
export function repeatValue(r) {
  if (!r) return '';
  const parts = [r.kind === 'month' ? String(r.day) : r.kind === 'weeks' ? `${r.every}w from ${r.from}` : ''];
  if (r.varies) parts.push('varies');
  if (r.since && r.kind !== 'weeks') parts.push(`since ${r.since}`);
  const out = parts.filter(Boolean).join(' ');
  return r.kind === 'month' && out === String(r.day) ? r.day : out;
}

/** Entries Hesab filled in by itself for a month that ended without them; shown until the user checks them. */
export const ESTIMATED = 'Auto-filled · check';
export const isEstimated = (t) => t?.note === ESTIMATED;
export function repeatLabel(r) {
  if (!r || r.kind === 'none') return r?.varies ? 'Amount varies' : '';
  if (r.kind === 'month') return `Every month on the ${ordinal(r.day)}`;
  return r.every === 1 ? 'Every week' : `Every ${r.every} weeks`;
}
export const ordinal = (d) => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');
/** The dates a repeating item falls on within one calendar month ('YYYY-MM'). */
export function repeatDates(r, ym) {
  if (!r || r.kind === 'none') return [];
  const days = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  if (r.kind === 'month') return [`${ym}-${pad(Math.min(r.day, days))}`];
  const first = `${ym}-01`, last = `${ym}-${pad(days)}`, step = r.every * 7;
  if (last < r.from) return [];
  let d = r.from;
  const gap = Math.round((parseISO(first) - parseISO(d)) / 86400000);
  if (gap > 0) d = addDays(d, Math.ceil(gap / step) * step);
  const out = [];
  for (; d <= last; d = addDays(d, step)) if (d >= first) out.push(d);
  return out;
}

export const isIncome = (t) => String(t.type).toLowerCase() === 'income';
export const isFixed = (t) => !isIncome(t) && String(t.expenseType).toLowerCase() === 'fixed';
export const isVariable = (t) => !isIncome(t) && String(t.expenseType).toLowerCase() === 'variable';
/** Money set aside to invest or save (TFSA, emergency fund…): Expense Type "Invest". Not spending, not a bill. */
export const isInvest = (t) => !isIncome(t) && String(t.expenseType).toLowerCase() === 'invest';
export const kindOf = (t) => (isIncome(t) ? 'income' : isFixed(t) ? 'fixed' : isInvest(t) ? 'invest' : 'variable');

export class Engine {
  constructor(snapshot) {
    this.year = snapshot.year;
    this.weeksPerBlock = Math.max(1, snapshot.weeksPerBlock || 4);
    this.categories = [...snapshot.categories].sort((a, b) => a.order - b.order);
    this.transactions = snapshot.transactions;
    this.targets = Object.fromEntries(snapshot.budget.map((b) => [b.category, Number(b.weeklyTarget) || 0]));
    this.plans = Object.fromEntries(snapshot.budget.map((b) => [b.category, Number(b.monthlyPlan) || 0]));
    this.repeats = Object.fromEntries(snapshot.budget.map((b) => [b.category, parseRepeat(b.repeat ?? b.autoDay)]));
    this.variable = this.categories.filter((c) => isVariable(c));

    this.spent = {};
    this.remaining = {};
    // A week counts as "tracked" once it has at least one entry of any kind. Weeks with nothing logged
    // (e.g. months when the budget wasn't used) are left out of savings and averages.
    this.weeks = weeksInYear(this.year);
    this.active = new Array(this.weeks).fill(false);
    for (const c of this.variable) this.spent[c.name] = new Array(this.weeks).fill(0);
    for (const t of this.transactions) {
      if (!t.date) continue;
      const { year, week: w } = isoWeek(t.date);
      if (year !== this.year || w < 1 || w > this.weeks) continue;
      this.active[w - 1] = true;
      if (!this.spent[t.category]) continue;
      this.spent[t.category][w - 1] += t.amount;
    }
    for (const c of this.variable) {
      const target = this.targets[c.name] || 0;
      const row = new Array(this.weeks).fill(0);
      for (let i = 0; i < this.weeks; i++) {
        const carry = i === 0 ? 0 : Math.min(0, row[i - 1]);
        row[i] = target + carry - this.spent[c.name][i];
      }
      this.remaining[c.name] = row;
    }
  }

  // ---- calendar ----
  get currentWeek() {
    const { year, week } = isoWeek(todayISO());
    if (year < this.year) return 1;
    if (year > this.year) return this.weeks;
    return Math.min(this.weeks, Math.max(1, week));
  }
  firstDay(week) { return addDays(weekOneMonday(this.year), (week - 1) * 7); }
  daysOf(week) { const s = this.firstDay(week); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(s, i)); }
  get weeklyTargetTotal() { return this.variable.reduce((s, c) => s + (this.targets[c.name] || 0), 0); }

  // ---- weekly ----
  lines(week) {
    const i = week - 1;
    return this.variable.map((c) => {
      const rem = this.remaining[c.name];
      const target = this.targets[c.name] || 0;
      const carried = i === 0 ? 0 : Math.min(0, rem[i - 1]);
      return { category: c, spent: this.spent[c.name][i], target, carried, available: target + carried, remaining: rem[i] };
    });
  }
  summary(week) {
    const l = this.lines(week);
    const sum = (k) => l.reduce((s, x) => s + x[k], 0);
    return { week, spent: sum('spent'), target: sum('target'), available: sum('available'), remaining: sum('remaining') };
  }
  savings(throughWeek) {
    const upto = Math.min(this.weeks, Math.max(0, throughWeek));
    return this.variable.map((c) => ({
      category: c,
      amount: this.remaining[c.name].slice(0, upto).reduce((s, v, i) => s + (this.active[i] ? Math.max(0, v) : 0), 0),
    }));
  }
  /** Number of tracked weeks up to and including a week. */
  trackedWeeks(throughWeek) { return this.active.slice(0, Math.max(0, throughWeek)).filter(Boolean).length; }

  // ---- daily ----
  dailyVariable() {
    const out = {};
    for (const t of this.transactions) if (isVariable(t)) out[t.date] = (out[t.date] || 0) + t.amount;
    return out;
  }
  pace(week) {
    const daily = this.dailyVariable();
    const target = Math.max(0, this.lines(week).reduce((s, l) => s + l.available, 0));
    const today = todayISO();
    let run = 0;
    const days = this.daysOf(week);
    return days.map((d, i) => {
      run += daily[d] || 0;
      return { day: d, cumulative: run, ideal: (target * (i + 1)) / days.length, future: d > today };
    });
  }

  // ---- calendar months (exactly the 1st to the last day) ----
  /** Spending, bills and income for one calendar month (1–12). Spending targets are the weekly
   *  targets scaled to the month's length: weekly × days ÷ 7. */
  month(m) {
    const ym = `${this.year}-${pad(m)}`;
    const days = new Date(this.year, m, 0).getDate();
    const first = `${ym}-01`, last = `${ym}-${pad(days)}`;
    const spent = {}, daily = new Array(days).fill(0);
    let income = 0, fixed = 0, invest = 0, count = 0;
    for (const t of this.transactions) {
      if (!t.date || t.date.slice(0, 7) !== ym) continue;
      count++;
      if (isIncome(t)) income += t.amount;
      else if (isFixed(t)) fixed += t.amount;
      else if (isInvest(t)) invest += t.amount;
      else if (isVariable(t)) {
        spent[t.category] = (spent[t.category] || 0) + t.amount;
        daily[Number(t.date.slice(8, 10)) - 1] += t.amount;
      }
    }
    const lines = this.variable.map((c) => ({ category: c, spent: spent[c.name] || 0, target: ((this.targets[c.name] || 0) * days) / 7 }));
    const variableSpent = lines.reduce((s, l) => s + l.spent, 0);
    const variableTarget = lines.reduce((s, l) => s + l.target, 0);
    return { month: m, ym, first, last, days, daily, count, lines, income, fixed, invest, variableSpent, variableTarget, net: income - variableSpent - fixed - invest };
  }
  get currentMonth() {
    const t = todayISO();
    if (yearOf(t) < this.year) return 1;
    if (yearOf(t) > this.year) return 12;
    return Number(t.slice(5, 7));
  }

  // ---- trends ----
  weekBars(endWeek, count) {
    const start = Math.max(1, endWeek - count + 1);
    const out = [];
    for (let w = start; w <= endWeek; w++) {
      const spent = this.variable.reduce((s, c) => s + this.spent[c.name][w - 1], 0);
      out.push({ week: w, spent, target: this.weeklyTargetTotal, active: this.active[w - 1] });
    }
    return out;
  }
  monthly() {
    const m = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, income: 0, variable: 0, fixed: 0, invest: 0 }));
    for (const t of this.transactions) {
      if (!t.date || yearOf(t.date) !== this.year) continue;
      const r = m[Number(t.date.slice(5, 7)) - 1];
      if (isIncome(t)) r.income += t.amount; else if (isFixed(t)) r.fixed += t.amount; else if (isInvest(t)) r.invest += t.amount; else r.variable += t.amount;
    }
    return m;
  }
  /** Bills and income for one calendar month ('YYYY-MM') against their monthly plan. */
  monthVsPlan(ym) {
    const actual = {};
    for (const t of this.transactions) {
      if (!t.date || t.date.slice(0, 7) !== ym || isVariable(t)) continue;
      actual[t.category] = (actual[t.category] || 0) + t.amount;
    }
    // The amount in Budget column C is per time: per month, or per payment for items that repeat every few weeks.
    const rows = this.categories.filter((c) => !isVariable(c)).map((c) => {
      const repeat = this.repeats[c.name] || null;
      const each = this.plans[c.name] || (repeat?.varies ? this.typical(c.name, ym) : 0);
      const dates = repeatDates(repeat, ym);
      const times = repeat?.kind === 'weeks' && this.plans[c.name] ? dates.length : 1;
      return { category: c, kind: kindOf(c), each, times, plan: each * times, actual: actual[c.name] || 0, repeat, dates };
    }).filter((r) => r.plan || r.actual);
    const sum = (k, f) => rows.filter((r) => r.kind === k).reduce((s, r) => s + r[f], 0);
    return { rows, income: { plan: sum('income', 'plan'), actual: sum('income', 'actual') }, fixed: { plan: sum('fixed', 'plan'), actual: sum('fixed', 'actual') }, invest: { plan: sum('invest', 'plan'), actual: sum('invest', 'actual') } };
  }
  /** Average monthly total of a category over the 3 months before 'YYYY-MM' that had entries. */
  typical(category, ym) {
    const by = {};
    for (const t of this.transactions) if (t.category === category && t.date.slice(0, 7) < ym) by[t.date.slice(0, 7)] = (by[t.date.slice(0, 7)] || 0) + t.amount;
    const last = Object.keys(by).sort().slice(-3);
    return last.length ? Math.round(last.reduce((s, k) => s + by[k], 0) / last.length) : 0;
  }
  totalsBy(filter) {
    const out = {};
    for (const t of this.transactions) if (filter(t)) out[t.category] = (out[t.category] || 0) + t.amount;
    return Object.entries(out).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
  }
}
