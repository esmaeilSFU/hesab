// Sample data so the app looks alive before it is connected to the sheet.
import { addDays, dayIndex, todayISO } from './engine.js';

const CATS = [
  ['Rent', 'Expense', 'Fixed'], ['Car Payment', 'Expense', 'Fixed'], ['Car Insurance', 'Expense', 'Fixed'],
  ['Phone', 'Expense', 'Fixed'], ['Internet', 'Expense', 'Fixed'], ['Electricity', 'Expense', 'Fixed'],
  ['Memberships', 'Expense', 'Fixed'],
  ['Grocery', 'Expense', 'Variable'], ['Gas', 'Expense', 'Variable'], ['Food & Cafe', 'Expense', 'Variable'],
  ['Personal Stuff', 'Expense', 'Variable'], ['Entertainment', 'Expense', 'Variable'], ['Gifts', 'Expense', 'Variable'],
  ['Transportation', 'Expense', 'Variable'], ['Home & Household', 'Expense', 'Variable'], ['ETC', 'Expense', 'Variable'],
  ['Esmaeil Income', 'Income', ''], ['Maryam Income', 'Income', ''], ['Other Income', 'Income', ''],
];
const BUDGET = { 'Grocery': 150, 'Gas': 35, 'Food & Cafe': 120, 'Personal Stuff': 95, 'Entertainment': 34, 'Gifts': 34, 'Transportation': 19, 'Home & Household': 40, 'ETC': 80 };
const NOTES = {
  'Grocery': ['Costco', 'Save-On', 'T&T', 'Fruit stand'], 'Food & Cafe': ['Coffee', 'Lunch', 'Sushi', 'Bakery'],
  'Gas': ['Shell', 'Petro-Canada'], 'Personal Stuff': ['Pharmacy', 'Haircut', 'Clothes'],
  'Entertainment': ['Cinema', 'Concert'], 'Gifts': ['Birthday gift', 'Flowers'], 'Transportation': ['Compass card', 'Parking'],
  'Home & Household': ['IKEA', 'Cleaning supplies'], 'ETC': ['Misc'],
};
const FREQ = [
  ['Food & Cafe', 0.8, 4, 32], ['Grocery', 0.36, 15, 85], ['Gas', 0.08, 50, 70], ['Personal Stuff', 0.2, 15, 95],
  ['Entertainment', 0.12, 12, 58], ['Gifts', 0.14, 10, 50], ['Transportation', 0.25, 4, 16],
  ['Home & Household', 0.11, 15, 75], ['ETC', 0.22, 10, 80],
];

function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

export function demoSnapshot() {
  const r = rng(42);
  const today = todayISO();
  const year = Number(today.slice(0, 4));
  const categories = CATS.map(([name, type, expenseType], i) => ({ name, type, expenseType, order: i + 1 }));
  const meta = Object.fromEntries(categories.map((c) => [c.name, c]));
  const tx = [];
  let row = 2;
  const add = (date, amount, category, note = '') => {
    const c = meta[category];
    tx.push({ row, id: `demo-${row}`, timestamp: date + 'T12:00:00Z', date, amount: Math.round(amount * 100) / 100,
      type: c.type, expenseType: c.expenseType, category, note });
    row++;
  };
  for (let d = `${year}-01-01`; d <= today; d = addDays(d, 1)) {
    for (const [cat, p, lo, hi] of FREQ) {
      if (r() < p) add(d, lo + r() * (hi - lo), cat, NOTES[cat][Math.floor(r() * NOTES[cat].length)]);
    }
    if (d.endsWith('-01')) {
      add(d, 2100, 'Rent'); add(d, 604, 'Car Payment'); add(d, 214, 'Car Insurance');
      add(d, 65, 'Phone'); add(d, 70, 'Internet'); add(d, 48, 'Electricity'); add(d, 22, 'Memberships');
    }
    if (dayIndex(d) % 14 === 5) add(d, 2150, 'Esmaeil Income');
    if (dayIndex(d) % 14 === 12) add(d, 1150, 'Maryam Income');
  }
  return {
    year, weeksPerBlock: 4, categories,
    budget: Object.entries(BUDGET).map(([category, weeklyTarget]) => ({ category, weeklyTarget })),
    transactions: tx,
  };
}
