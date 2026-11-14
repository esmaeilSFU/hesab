// Sample data so the app looks alive before it is connected. Everything here is invented:
// it uses the same generic starter categories and budget a new user gets.
import { addDays, dayIndex, todayISO } from './engine.js';
import { starterSnapshot } from './data.js';

const NOTES = {
  'Grocery': ['Supermarket', 'Farmers market', 'Corner store'], 'Food & Cafe': ['Coffee', 'Lunch', 'Dinner out', 'Bakery'],
  'Gas': ['Fuel'], 'Personal': ['Pharmacy', 'Haircut', 'Clothes'],
  'Entertainment': ['Movie', 'Concert', 'Books'], 'Gifts': ['Birthday gift', 'Flowers'], 'Transportation': ['Transit', 'Parking'],
  'Home & Household': ['Cleaning supplies', 'Kitchen'], 'Other': ['Misc'],
};
// [category, chance per day, min, max]
const FREQ = [
  ['Food & Cafe', 0.6, 5, 28], ['Grocery', 0.3, 20, 80], ['Gas', 0.1, 40, 60], ['Personal', 0.15, 10, 60],
  ['Entertainment', 0.12, 10, 45], ['Gifts', 0.08, 15, 50], ['Transportation', 0.25, 3, 12],
  ['Home & Household', 0.1, 10, 50], ['Other', 0.15, 5, 40],
];
// Monthly bills on the 1st, and two invented paychecks a month.
const BILLS = [['Rent', 1800], ['Car Payment', 400], ['Insurance', 150], ['Phone', 50], ['Internet', 60], ['Utilities', 70], ['Subscriptions', 25]];

function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

export function demoSnapshot() {
  const r = rng(7);
  const base = starterSnapshot();
  const today = todayISO();
  const year = base.year;
  const meta = Object.fromEntries(base.categories.map((c) => [c.name, c]));
  const tx = [];
  let row = 2;
  const add = (date, amount, category, note = '') => {
    const c = meta[category];
    if (!c) return;
    tx.push({ row, id: `demo-${row}`, timestamp: date + 'T12:00:00Z', date, amount: Math.round(amount * 100) / 100,
      type: c.type, expenseType: c.expenseType, category, note });
    row++;
  };
  for (let d = `${year}-01-01`; d <= today; d = addDays(d, 1)) {
    for (const [cat, p, lo, hi] of FREQ) {
      if (r() < p) add(d, lo + r() * (hi - lo), cat, NOTES[cat][Math.floor(r() * NOTES[cat].length)]);
    }
    if (d.endsWith('-01')) for (const [cat, amt] of BILLS) add(d, amt, cat);
    if (dayIndex(d) % 14 === 4) add(d, 2000, 'Salary', 'Paycheck');
    if (d.endsWith('-15')) add(d, 300, 'Other Income', 'Side project');
  }
  return { ...base, transactions: tx };
}
