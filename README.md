# Hesab

> The Google Sheet setup below is **optional**. Without it, everything is stored on the phone.

A minimal, iOS-style weekly budget web app that can sync with your own Google Sheet. Install it on an iPhone from Safari (Share → Add to Home Screen) and it opens full-screen like a native app, works offline, and syncs with the sheet.

**Week:** remaining budget ring, daily allowance, spending pace, categories with carry-over, latest entries.
**Activity:** search, filters (Spending / Bills / Income), tap any entry to edit or delete it.
**Insights:** 16-week spending bars, daily-spending calendar, savings per category, 4-week blocks with a donut chart, yearly cash flow and top categories.
**Add:** big keypad, category grid, date and note. Type and Expense Type are filled in from the Categories tab.
**Settings:** where the data lives (this phone or a Google Sheet), categories and weekly budgets, backup and restore, CSV import and export, and a QR code and link for installing on another phone.

**Free by default:** data stays on the phone. No account, server or Google Sheet is needed. To move to a new phone, use **Save full backup**, then **Restore from a backup** on the new phone. The restore option is also on the welcome screen.

The math matches the sheet exactly: the same week numbers, 4-week blocks, overspending carried into the next week, and savings.

## 1. Backend (Apps Script)

1. Open the sheet → **Extensions → Apps Script**. Replace the contents of `Code.gs` with `backend/Code.gs`, then save.
2. Pick `setupToken` in the function menu → **Run**, then approve the permissions. Copy the token from the execution log.
3. **Deploy → New deployment →** type **Web app**. Set *Execute as*: **Me** and *Who has access*: **Anyone**. Copy the URL that ends in `/exec`.

Every request needs the token, so the URL alone gives no one access. If you change `Code.gs` later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

## 2. Hosting the app

These are static files: `index.html`, `css/`, `js/`, `icons/`, `manifest.webmanifest`, `sw.js`. Any HTTPS static host works, for example GitHub Pages, Netlify or Cloudflare Pages. There is no build step.

## 3. On the iPhone

Open the hosted URL in **Safari** → Share → **Add to Home Screen**. Open Hesab → ⚙︎ → paste the Script URL and the token → **Connect**.

The token is stored only on that phone.
