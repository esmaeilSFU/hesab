// Anonymous usage counts and opt-in email sign-ups, sent to the developer's Google Form.
// No financial data, names or Google account details are ever sent. See privacy.html.
import { isIOS, isAndroid, isStandalone } from './install.js';

export const FORM = {
  // Filled in after the Google Form is created. Leave action empty to disable all sending.
  action: 'https://docs.google.com/forms/d/e/1FAIpQLSf9YtrtQdne0svIRicVJU20-X5KH8RE9z4WlZGASu2FMuUfTQ/formResponse',
  fields: { event: 'entry.1590593901', device: 'entry.616312612', platform: 'entry.1873268121', mode: 'entry.355557302', version: 'entry.1460387134', tz: 'entry.1433201628', email: 'entry.2046709935' },
};
export const VERSION = '1.4';

const K = { device: 'hesab.t.device', day: 'hesab.t.day', installed: 'hesab.t.installed', optout: 'hesab.t.optout', email: 'hesab.t.email' };
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

export const analyticsOn = () => get(K.optout) !== '1';
export const setAnalytics = (on) => set(K.optout, on ? null : '1');
export const signedUpEmail = () => get(K.email);

function device() {
  let id = get(K.device);
  if (!id) { id = crypto.getRandomValues(new Uint32Array(2)).join('').slice(0, 12); set(K.device, id); }
  return id;
}

function send(fields) {
  if (!FORM.action || !navigator.onLine) return Promise.resolve(false);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (FORM.fields[k] && v != null) body.set(FORM.fields[k], String(v));
  // Google Forms accepts a plain form post; no-cors means we can't read the reply, which we don't need.
  return fetch(FORM.action, { method: 'POST', mode: 'no-cors', body }).then(() => true, () => false);
}

const base = (mode) => ({
  device: device(),
  platform: isIOS ? 'ios' : isAndroid ? 'android' : 'desktop',
  mode: mode || 'none',
  version: VERSION,
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
});

/** At most one "open" per device per day, plus a one-time "install" from the Home Screen. */
export function ping(mode) {
  if (!analyticsOn()) return;
  const today = new Date().toISOString().slice(0, 10);
  if (isStandalone() && !get(K.installed)) { set(K.installed, '1'); send({ event: 'install', ...base(mode) }); }
  if (get(K.day) === today) return;
  set(K.day, today);
  send({ event: isStandalone() ? 'open-app' : 'open-web', ...base(mode) });
}

export function event(name, mode) {
  if (analyticsOn()) send({ event: name, ...base(mode) });
}

/** Opt-in email for product updates. */
export async function signUp(email, mode) {
  const e = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new Error('Enter a valid email address.');
  const ok = await send({ event: 'signup', email: e, ...base(mode) });
  if (!ok && FORM.action) throw new Error('Could not send. Check your connection and try again.');
  set(K.email, e);
  return true;
}
