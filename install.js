// Install helpers: platform detection, the "Add to Home Screen" guide, Android's install
// prompt, and a QR code that opens the app on a phone. iOS has no install API, so it gets
// clear step-by-step instructions instead.
import { icon } from './icons.js';

const ua = navigator.userAgent;
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(ua);
export const isMobile = isIOS || isAndroid;
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|Telegram|WhatsApp|Snapchat|LinkedInApp/i.test(ua);
const iosSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

export const appURL = () => location.origin + location.pathname.replace(/index\.html$/, '');

// Android / desktop Chrome hand us a real install prompt.
let deferred = null;
const listeners = new Set();
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; listeners.forEach((f) => f()); });
window.addEventListener('appinstalled', () => { deferred = null; listeners.forEach((f) => f()); });
export const onInstallChange = (f) => listeners.add(f);
export const canPrompt = () => !!deferred;
export async function promptInstall() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  return outcome === 'accepted';
}

// The banner can be hidden for two weeks.
const DISMISS = 'hesab.installDismissed';
export const bannerDismissed = () => Number(localStorage.getItem(DISMISS) || 0) > Date.now();
export const dismissBanner = () => localStorage.setItem(DISMISS, String(Date.now() + 14 * 86400000));

// iOS share glyph (square with an arrow), drawn to match the Safari toolbar icon.
const shareGlyph = `<svg class="share-glyph" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Share"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M7 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1"/></svg>`;
const addGlyph = `<svg class="share-glyph" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>`;

/** Ordered steps for this device, or null when there is nothing to do. */
export function installSteps() {
  if (isStandalone()) return null;
  if (isIOS) {
    if (inAppBrowser) return [`Tap <b>•••</b> and choose <b>Open in Safari</b>`, `Tap ${shareGlyph} <b>Share</b>`, `Choose ${addGlyph} <b>Add to Home Screen</b>`];
    return [
      `Tap ${shareGlyph} <b>Share</b> ${iosSafari ? 'in the toolbar' : 'in the address bar'}`,
      `Scroll down and choose ${addGlyph} <b>Add to Home Screen</b>`,
      `Tap <b>Add</b>. Hesab now opens full-screen from your Home Screen`,
    ];
  }
  if (isAndroid) {
    return [`Tap <b>⋮</b> in Chrome`, `Choose <b>Install app</b> or <b>Add to Home screen</b>`, `Tap <b>Install</b>`];
  }
  return null;
}

/** QR code as an SVG string (uses the vendored MIT qrcode-generator). */
export function qrSVG(text, size = 168) {
  if (typeof window.qrcode !== 'function') return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), q = 2; // quiet zone in modules
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q},${r + q}h1v1h-1z`;
  const full = n + q * 2;
  return `<svg class="qr" width="${size}" height="${size}" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges" role="img" aria-label="QR code that opens Hesab">
    <rect width="${full}" height="${full}" fill="#fff"/><path d="${d}" fill="#111114"/></svg>`;
}

/** Floating card shown above the tab bar on phones that have not installed the app yet. */
export function installBannerHTML() {
  if (isStandalone() || bannerDismissed() || !isMobile) return '';
  const android = isAndroid && canPrompt();
  return `<div class="install-banner" role="dialog" aria-label="Install Hesab">
    <div class="ib-head">
      <img class="ib-icon" src="icon.svg" alt="">
      <div class="ib-t"><b>Install Hesab</b><small>Free · opens like an app · works offline</small></div>
      <button class="ib-x" data-act="dismissInstall" aria-label="Not now">${icon('close', 16, 2.4)}</button>
    </div>
    ${android
      ? `<button class="primary slim" data-act="installNow">Install</button>`
      : `<button class="primary slim" data-act="installGuide">Show me how</button>`}
  </div>`;
}

/** Full instructions sheet body (also used on the welcome screen and in Settings). */
export function installGuideHTML({ showQR = !isMobile } = {}) {
  const steps = installSteps();
  const url = appURL();
  return `
    ${steps ? `<ol class="steps">${steps.map((s, i) => `<li><span class="step-n">${i + 1}</span><span>${s}</span></li>`).join('')}</ol>` : ''}
    ${isStandalone() ? `<p class="hint center">Hesab is installed on this device.</p>` : ''}
    ${showQR ? `<div class="qr-card">${qrSVG(url)}<p><b>Scan with your phone's camera</b><small>Opens Hesab in the browser, then add it to your Home Screen.</small></p></div>` : ''}
    <div class="share-row">
      <input class="share-url" value="${url}" readonly aria-label="App link">
      <button class="ghost slim" data-act="shareLink">${navigator.share ? 'Share' : 'Copy'}</button>
    </div>`;
}

export async function shareLink() {
  const url = appURL();
  if (navigator.share) {
    try { await navigator.share({ title: 'Hesab', text: 'A calm weekly budget app', url }); return 'shared'; } catch { return null; }
  }
  try { await navigator.clipboard.writeText(url); return 'copied'; } catch { return null; }
}
