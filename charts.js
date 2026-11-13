// Hand-drawn SVG charts: crisp, light, offline, and themed by CSS variables.
import { compact, weekdayNarrow, monthShort, esc, catStyle, money } from './format.js';
import { addDays, parseISO, todayISO } from './engine.js';

const f = (n) => Math.round(n * 10) / 10;

export function ring(progress, size = 132, width = 13) {
  const r = (size - width) / 2, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(progress, 1));
  const over = progress > 1;
  const tone = over ? 'var(--bad)' : progress > 0.85 ? 'var(--warn)' : 'var(--accent)';
  const extra = over ? Math.min(progress - 1, 1) : 0;
  const r2 = r - width * 1.15, c2 = 2 * Math.PI * r2;
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--fill)" stroke-width="${width}"/>
    ${p > 0.001 ? `<circle class="ring-arc" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${tone}" stroke-width="${width}"
      stroke-linecap="round" stroke-dasharray="${f(c * p)} ${f(c)}" transform="rotate(-90 ${size / 2} ${size / 2})"
      style="--len:${f(c * p)}"/>` : ''}
    ${over ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r2}" fill="none" stroke="var(--bad)" stroke-opacity=".35"
      stroke-width="${width * 0.45}" stroke-linecap="round" stroke-dasharray="${f(c2 * extra)} ${f(c2)}"
      transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ''}
  </svg>`;
}

/** Cumulative spending through the week vs an even pace to the budget. */
export function paceChart(points, { w = 340, h = 150 } = {}) {
  const pad = { l: 4, r: 4, t: 14, b: 22 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const max = Math.max(1, ...points.map((p) => Math.max(p.cumulative, p.ideal))) * 1.08;
  const x = (i) => pad.l + (iw * i) / 6;
  const y = (v) => pad.t + ih - (ih * v) / max;
  const past = points.filter((p) => !p.future);
  const line = past.map((p, i) => `${i ? 'L' : 'M'}${f(x(i))},${f(y(p.cumulative))}`).join('');
  const area = past.length ? `${line}L${f(x(past.length - 1))},${f(y(0))}L${f(x(0))},${f(y(0))}Z` : '';
  const ideal = points.map((p, i) => `${i ? 'L' : 'M'}${f(x(i))},${f(y(p.ideal))}`).join('');
  const last = past[past.length - 1];
  const overPace = last && last.cumulative > last.ideal;
  const tone = overPace ? 'var(--bad)' : 'var(--accent)';
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Spending pace this week">
    <defs><linearGradient id="paceFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${tone}" stop-opacity=".28"/><stop offset="1" stop-color="${tone}" stop-opacity="0"/>
    </linearGradient></defs>
    <line x1="${pad.l}" x2="${w - pad.r}" y1="${f(y(0))}" y2="${f(y(0))}" class="axis"/>
    <path d="${ideal}" class="ideal"/>
    ${area ? `<path d="${area}" fill="url(#paceFill)"/>` : ''}
    ${line ? `<path d="${line}" fill="none" stroke="${tone}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" class="draw"/>` : ''}
    ${last ? `<circle cx="${f(x(past.length - 1))}" cy="${f(y(last.cumulative))}" r="4.5" fill="var(--card)" stroke="${tone}" stroke-width="2.6"/>` : ''}
    ${points.map((p, i) => `<text x="${f(x(i))}" y="${h - 5}" class="tick ${p.day === todayISO() ? 'strong' : ''}" text-anchor="${i === 0 ? 'start' : i === 6 ? 'end' : 'middle'}">${weekdayNarrow(p.day)}</text>`).join('')}
  </svg>`;
}

/** Weekly spending bars with the weekly budget as a dashed line. Bars carry data-week for taps. */
export function weekBars(bars, selected, { w = 340, h = 170 } = {}) {
  const pad = { l: 4, r: 30, t: 18, b: 22 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const target = bars[0]?.target || 0;
  const max = Math.max(target, ...bars.map((b) => b.spent)) * 1.12 || 1;
  const slot = iw / bars.length, bw = Math.min(18, slot * 0.62);
  const y = (v) => pad.t + ih - (ih * v) / max;
  const sel = bars.find((b) => b.week === selected);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" aria-label="Weekly spending">
    ${bars.map((b, i) => {
      const cx = pad.l + slot * i + slot / 2;
      const top = y(b.spent), hh = Math.max(2, y(0) - top);
      const cls = b.week === selected ? 'sel' : '';
      const tone = b.spent > b.target ? 'var(--bad)' : 'var(--accent)';
      return `<g class="wbar ${cls}" data-week="${b.week}">
        <rect x="${f(cx - slot / 2)}" y="${pad.t}" width="${f(slot)}" height="${ih}" fill="transparent"/>
        <rect x="${f(cx - bw / 2)}" y="${f(y(0) - hh)}" width="${f(bw)}" height="${f(hh)}" rx="${f(Math.min(6, bw / 2))}" fill="${tone}" opacity="${b.week === selected ? 1 : 0.55}"/>
        ${i % 2 === bars.length % 2 || b.week === selected ? `<text x="${f(cx)}" y="${h - 5}" class="tick ${b.week === selected ? 'strong' : ''}" text-anchor="middle">${b.week}</text>` : ''}
      </g>`;
    }).join('')}
    <line x1="${pad.l}" x2="${w - pad.r + 2}" y1="${f(y(target))}" y2="${f(y(target))}" class="target"/>
    <text x="${w - 2}" y="${f(y(target)) + 4}" class="tick" text-anchor="end">${compact(target)}</text>
    ${sel ? `<text x="${f(pad.l + slot * bars.indexOf(sel) + slot / 2)}" y="${f(y(sel.spent)) - 6}" class="tick strong" text-anchor="middle">${compact(sel.spent)}</text>` : ''}
  </svg>`;
}

/** Donut of spending by category with a total in the middle. */
export function donut(items, { size = 168, width = 22, label = 'Spent' } = {}) {
  const total = items.reduce((s, i) => s + i.amount, 0);
  const r = (size - width) / 2, c = 2 * Math.PI * r, cx = size / 2;
  let offset = 0;
  const gap = items.length > 1 ? 2.5 : 0;
  const arcs = total > 0 ? items.filter((i) => i.amount > 0).map((i) => {
    const len = (c * i.amount) / total;
    const seg = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${catStyle(i.category).color}" stroke-width="${width}"
      stroke-dasharray="${f(Math.max(0.5, len - gap))} ${f(c)}" stroke-dashoffset="${f(-offset)}" transform="rotate(-90 ${cx} ${cx})"/>`;
    offset += len;
    return seg;
  }).join('') : `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="var(--fill)" stroke-width="${width}"/>`;
  return `<svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-label="Spending by category">
    ${arcs}
    <text x="${cx}" y="${cx - 4}" text-anchor="middle" class="donut-v">${compact(total)}</text>
    <text x="${cx}" y="${cx + 15}" text-anchor="middle" class="tick">${esc(label)}</text>
  </svg>`;
}

/** GitHub-style calendar of daily variable spending. */
export function heatmap(daily, { weeks = 18, end = todayISO(), cell = 15, gap = 3.5 } = {}) {
  const endDate = parseISO(end);
  const endOfWeek = addDays(end, 6 - ((endDate.getDay() + 6) % 7)); // Sunday of this Mon-based week
  const start = addDays(endOfWeek, -(weeks * 7 - 1));
  const values = [];
  for (let d = start; d <= endOfWeek; d = addDays(d, 1)) values.push(daily[d] || 0);
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(nz.length * p))] || 1;
  const steps = [q(0.25), q(0.5), q(0.75), q(0.92)];
  const level = (v) => (v <= 0 ? 0 : 1 + steps.filter((s) => v > s).length);
  const w = weeks * (cell + gap) + 18, h = 7 * (cell + gap) + 18;
  let out = '', d = start, months = '', lastMonth = -1;
  for (let col = 0; col < weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const v = daily[d] || 0, lv = d > end ? -1 : level(v);
      const x = 18 + col * (cell + gap), y = 16 + row * (cell + gap);
      out += `<rect x="${f(x)}" y="${f(y)}" width="${cell}" height="${cell}" rx="4" class="hm l${lv}" data-day="${d}" data-v="${f(v)}"/>`;
      if (row === 0) {
        const m = parseISO(d).getMonth();
        if (m !== lastMonth) { months += `<text x="${f(x)}" y="10" class="tick">${monthShort(m + 1)}</text>`; lastMonth = m; }
      }
      d = addDays(d, 1);
    }
  }
  const labels = ['M', '', 'W', '', 'F', '', ''].map((l, i) => l ? `<text x="1" y="${f(16 + i * (cell + gap) + cell - 3)}" class="tick">${l}</text>` : '').join('');
  return `<svg class="chart heat" viewBox="0 0 ${f(w)} ${f(h)}" aria-label="Daily spending calendar">${months}${labels}${out}</svg>`;
}

/** Monthly income vs spending (variable + fixed stacked). */
export function monthBars(months, { w = 340, h = 180 } = {}) {
  const pad = { l: 4, r: 4, t: 12, b: 22 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const max = Math.max(1, ...months.map((m) => Math.max(m.income, m.variable + m.fixed))) * 1.08;
  const slot = iw / 12, bw = Math.min(9, slot * 0.32);
  const y = (v) => pad.t + ih - (ih * v) / max;
  const thisMonth = new Date().getMonth() + 1;
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" aria-label="Monthly income and spending">
    <line x1="${pad.l}" x2="${w - pad.r}" y1="${f(y(0))}" y2="${f(y(0))}" class="axis"/>
    ${months.map((m, i) => {
      const x = pad.l + slot * i + slot / 2;
      const inc = y(0) - y(m.income), fx = y(0) - y(m.fixed), va = y(0) - y(m.variable);
      return `<g>
        <rect x="${f(x - bw - 1)}" y="${f(y(m.income))}" width="${f(bw)}" height="${f(Math.max(0, inc))}" rx="3" fill="var(--income)"/>
        <rect x="${f(x + 1)}" y="${f(y(m.fixed))}" width="${f(bw)}" height="${f(Math.max(0, fx))}" rx="3" fill="var(--fixed)"/>
        <rect x="${f(x + 1)}" y="${f(y(m.fixed) - va)}" width="${f(bw)}" height="${f(Math.max(0, va))}" rx="3" fill="var(--accent)"/>
        <text x="${f(x)}" y="${h - 5}" class="tick ${m.month === thisMonth ? 'strong' : ''}" text-anchor="middle">${monthShort(m.month).slice(0, 1)}</text>
      </g>`;
    }).join('')}
  </svg>`;
}

/** Horizontal bars, e.g. savings per category. */
export function hbars(items) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.amount)));
  return `<div class="hbars">${items.map((i) => {
    const st = catStyle(i.category);
    return `<div class="hbar">
      <span class="hbar-l">${esc(i.category)}</span>
      <span class="hbar-t"><i style="width:${f((100 * Math.abs(i.amount)) / max)}%;background:${st.color}"></i></span>
      <span class="hbar-v">${money(i.amount, { cents: false })}</span>
    </div>`;
  }).join('')}</div>`;
}
