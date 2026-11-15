// Budget engine — reproduces the spreadsheet's math so the app and the sheet agree.
//
//   week      = floor(days since Jan 1 / 7) + 1                 (Ledger_Calc!J)
//   block     = ceil(week / weeksPerBlock)                      (Ledger_Calc!K)
//   remaining = week 1: target − spent
//               later:  target + min(0, last week's remaining) − spent   (Weekly_Control!E)
//   savings   = sum of positive weekly remainders up to a week, counting only weeks with entries

export const WEEKS = 52;

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
export const weekOf = (iso) => Math.floor(dayIndex(iso) / 7) + 1;
export const yearOf = (iso) => Number(iso.slice(0, 4));

export const isIncome = (t) => String(t.type).toLowerCase() === 'income';
export const isFixed = (t) => !isIncome(t) && String(t.expenseType).toLowerCase() === 'fixed';
export const isVariable = (t) => !isIncome(t) && String(t.expenseType).toLowerCase() === 'variable';
export const kindOf = (t) => (isIncome(t) ? 'income' : isFixed(t) ? 'fixed' : 'variable');

export class Engine {
  constructor(snapshot) {
    this.year = snapshot.year;
    this.weeksPerBlock = Math.max(1, snapshot.weeksPerBlock || 4);
    this.categories = [...snapshot.categories].sort((a, b) => a.order - b.order);
    this.transactions = snapshot.transactions;
    this.targets = Object.fromEntries(snapshot.budget.map((b) => [b.category, Number(b.weeklyTarget) || 0]));
    this.plans = Object.fromEntries(snapshot.budget.map((b) => [b.category, Number(b.monthlyPlan) || 0]));
    this.variable = this.categories.filter((c) => isVariable(c));

    this.spent = {};
    this.remaining = {};
    // A week counts as "tracked" once it has at least one entry of any kind. Weeks with nothing logged
    // (e.g. months when the budget wasn't used) are left out of savings and averages.
    this.active = new Array(WEEKS).fill(false);
    for (const c of this.variable) this.spent[c.name] = new Array(WEEKS).fill(0);
    for (const t of this.transactions) {
      if (!t.date || yearOf(t.date) !== this.year) continue;
      const w = weekOf(t.date);
      if (w < 1 || w > WEEKS) continue;
      this.active[w - 1] = true;
      if (!this.spent[t.category]) continue;
      this.spent[t.category][w - 1] += t.amount;
    }
    for (const c of this.variable) {
      const target = this.targets[c.name] || 0;
      const row = new Array(WEEKS).fill(0);
      for (let i = 0; i < WEEKS; i++) {
        const carry = i === 0 ? 0 : Math.min(0, row[i - 1]);
        row[i] = target + carry - this.spent[c.name][i];
      }
      this.remaining[c.name] = row;
    }
  }

  // ---- calendar ----
  get currentWeek() {
    const t = todayISO();
    if (yearOf(t) < this.year) return 1;
    if (yearOf(t) > this.year) return WEEKS;
    return Math.min(WEEKS, Math.max(1, weekOf(t)));
  }
  blockOf(week) { return Math.ceil(week / this.weeksPerBlock); }
  get blockCount() { return this.blockOf(WEEKS); }
  weeksIn(block) {
    const start = (block - 1) * this.weeksPerBlock + 1;
    const end = Math.min(WEEKS, start + this.weeksPerBlock - 1);
    return [start, end];
  }
  firstDay(week) { return addDays(`${this.year}-01-01`, (week - 1) * 7); }
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
    const upto = Math.min(WEEKS, Math.max(0, throughWeek));
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
    return this.daysOf(week).map((d, i) => {
      run += daily[d] || 0;
      return { day: d, cumulative: run, ideal: (target * (i + 1)) / 7, future: d > today };
    });
  }

  // ---- blocks ----
  block(block) {
    const [a, b] = this.weeksIn(block);
    const n = b - a + 1;
    const spent = {};
    let income = 0, fixed = 0;
    for (const t of this.transactions) {
      if (!t.date || yearOf(t.date) !== this.year) continue;
      const w = weekOf(t.date);
      if (w < a || w > b) continue;
      if (isIncome(t)) income += t.amount;
      else if (isFixed(t)) fixed += t.amount;
      else if (isVariable(t)) spent[t.category] = (spent[t.category] || 0) + t.amount;
    }
    const lines = this.variable.map((c) => ({ category: c, spent: spent[c.name] || 0, target: (this.targets[c.name] || 0) * n }));
    const variableSpent = lines.reduce((s, l) => s + l.spent, 0);
    const variableTarget = lines.reduce((s, l) => s + l.target, 0);
    return { block, weeks: [a, b], lines, income, fixed, variableSpent, variableTarget, net: income - variableSpent - fixed };
  }

  // ---- calendar months (exactly the 1st to the last day) ----
  /** Spending, bills and income for one calendar month (1–12). Spending targets are the weekly
   *  targets scaled to the month's length: weekly × days ÷ 7. */
  month(m) {
    const ym = `${this.year}-${pad(m)}`;
    const days = new Date(this.year, m, 0).getDate();
    const first = `${ym}-01`, last = `${ym}-${pad(days)}`;
    const spent = {}, daily = new Array(days).fill(0);
    let income = 0, fixed = 0, count = 0;
    for (const t of this.transactions) {
      if (!t.date || t.date.slice(0, 7) !== ym) continue;
      count++;
      if (isIncome(t)) income += t.amount;
      else if (isFixed(t)) fixed += t.amount;
      else if (isVariable(t)) {
        spent[t.category] = (spent[t.category] || 0) + t.amount;
        daily[Number(t.date.slice(8, 10)) - 1] += t.amount;
      }
    }
    const lines = this.variable.map((c) => ({ category: c, spent: spent[c.name] || 0, target: ((this.targets[c.name] || 0) * days) / 7 }));
    const variableSpent = lines.reduce((s, l) => s + l.spent, 0);
    const variableTarget = lines.reduce((s, l) => s + l.target, 0);
    return { month: m, ym, first, last, days, daily, count, lines, income, fixed, variableSpent, variableTarget, net: income - variableSpent - fixed };
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
    const m = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, income: 0, variable: 0, fixed: 0 }));
    for (const t of this.transactions) {
      if (!t.date || yearOf(t.date) !== this.year) continue;
      const r = m[Number(t.date.slice(5, 7)) - 1];
      if (isIncome(t)) r.income += t.amount; else if (isFixed(t)) r.fixed += t.amount; else r.variable += t.amount;
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
    const rows = this.categories.filter((c) => !isVariable(c)).map((c) => ({
      category: c, kind: isIncome(c) ? 'income' : 'fixed', plan: this.plans[c.name] || 0, actual: actual[c.name] || 0,
    })).filter((r) => r.plan || r.actual);
    const sum = (k, f) => rows.filter((r) => r.kind === k).reduce((s, r) => s + r[f], 0);
    return { rows, income: { plan: sum('income', 'plan'), actual: sum('income', 'actual') }, fixed: { plan: sum('fixed', 'plan'), actual: sum('fixed', 'actual') } };
  }
  totalsBy(filter) {
    const out = {};
    for (const t of this.transactions) if (filter(t)) out[t.category] = (out[t.category] || 0) + t.amount;
    return Object.entries(out).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
  }
}
