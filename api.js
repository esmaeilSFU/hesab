// Client for the Apps Script web app (backend/Code.gs).
// GET and text/plain POST are "simple" CORS requests, so no preflight is needed.

export class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class Api {
  constructor(url, token) { this.url = url; this.token = token; }

  async bootstrap() {
    const u = new URL(this.url);
    u.searchParams.set('action', 'bootstrap');
    u.searchParams.set('token', this.token);
    return this.#read(await this.#fetch(u.toString(), { method: 'GET' }));
  }
  add(entry) { return this.#post({ action: 'add', entry }).then((d) => d.transaction); }
  update(tx, entry) { return this.#post({ action: 'update', row: tx.row, id: tx.id, entry }).then((d) => d.transaction); }
  remove(tx) { return this.#post({ action: 'delete', row: tx.row, id: tx.id }); }
  setBudget(category, weeklyTarget) { return this.#post({ action: 'setBudget', category, weeklyTarget }); }

  async #post(body) {
    const res = await this.#fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, token: this.token }),
    });
    return this.#read(res);
  }

  async #fetch(url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      return await fetch(url, { ...init, redirect: 'follow', signal: ctrl.signal });
    } catch (e) {
      throw new ApiError('network', navigator.onLine ? 'Could not reach your Google Sheet.' : 'You are offline.');
    } finally {
      clearTimeout(timer);
    }
  }

  async #read(res) {
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      if (/<html|<!doctype/i.test(text)) {
        throw new ApiError('html', 'The script answered with a web page. Deploy it as a Web app with access set to "Anyone".');
      }
      throw new ApiError('decode', 'Unexpected response from the script.');
    }
    if (json.ok) return json.data;
    throw new ApiError(json.error?.code || 'server', json.error?.message || 'The script returned an error.');
  }
}
