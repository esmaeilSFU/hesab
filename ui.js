// Shared UI primitives: DOM helpers, bottom sheets, toast, native-feel guards.
// Used by app.js. Kept separate so the big orchestrator file stays focused on data + views.

import { esc } from './format.js';
import { icon } from './icons.js';

export const $ = (s, el = document) => el.querySelector(s);

export function openSheet(html, { onMount, cls = '' } = {}) {
  closeSheet(true);
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="backdrop" data-close></div><div class="sheet ${cls}" role="dialog" aria-modal="true"><div class="grab" data-grab></div>${html}</div>`;
  document.body.appendChild(wrap);
  document.body.classList.add('locked');
  requestAnimationFrame(() => wrap.classList.add('open'));
  wrap.addEventListener('click', (ev) => { if (ev.target.closest('[data-close]')) closeSheet(); });
  enableDragToClose(wrap);
  onMount?.(wrap);
  return wrap;
}

export function closeSheet(immediate = false) {
  const wrap = $('.sheet-wrap');
  if (!wrap) return;
  document.body.classList.remove('locked');
  if (immediate) { wrap.remove(); return; }
  wrap.classList.remove('open');
  setTimeout(() => wrap.remove(), 320);
}

function enableDragToClose(wrap) {
  const sheet = $('.sheet', wrap), grab = $('[data-grab]', wrap);
  let y0 = null, dy = 0;
  grab.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; sheet.style.transition = 'none'; }, { passive: true });
  grab.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sheet.style.transform = `translateY(${dy}px)`; }, { passive: true });
  grab.addEventListener('touchend', () => {
    sheet.style.transition = ''; sheet.style.transform = '';
    if (dy > 110) closeSheet();
    y0 = null; dy = 0;
  });
}

let toastTimer;
export function toast(msg, tone = '') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = `toast ${tone}`;
  el.innerHTML = `${tone === 'bad' ? '' : icon('check', 18, 2.6)}<span>${esc(msg)}</span>`;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), tone === 'bad' ? 4200 : 2200);
}

/** Call once at boot. Makes the page feel more like a native app. */
export function initNativeFeel() {
  // No long-press menu (copy / look up) outside text fields, and no image dragging.
  document.addEventListener('contextmenu', (ev) => { if (!ev.target.closest('input, textarea, select')) ev.preventDefault(); });
  document.addEventListener('dragstart', (ev) => { if (ev.target.closest('img, svg, a')) ev.preventDefault(); });
  // Double-tap zoom is off through CSS (touch-action: manipulation); iOS ignores user-scalable=no for pinch.
  document.addEventListener('gesturestart', (ev) => ev.preventDefault());
  // Clear stray text selection on the next tap.
  document.addEventListener('touchstart', (ev) => {
    if (ev.target.closest('input, textarea, select')) return;
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
  }, { passive: true });
}
