# trading-dashboard

Mobile-first dashboard for the Bull trading agent. Reads data from the private trading-agent repo using a fine-grained GitHub token stored in the visitor's browser localStorage (never on any server). Live at https://vinay8558.github.io/trading-dashboard/

## Flash News panel (`flash_news.js`)

A slim banner under the top bar that shows only major, market-moving news for Bull's holdings, Bull's trending picks (top of the momentum ranking) and a fixed tech + energy focus list. Self-contained: if it fails, the rest of the dashboard keeps working.

**News source (recommended: Alpaca).** Tap ⚙ in the panel and paste your Alpaca API key ID + secret (the same keys as the paper account). With Alpaca the panel gets:
- a **live news stream** (Benzinga newswire via `wss://stream.data.alpaca.markets/v1beta1/news`) — stories are pushed the moment they're published, status shows **● LIVE**;
- **one-call price snapshots** for every watched stock and sector fund, every 10 seconds;
- 3 days of a stock's news for search, and a whole sector's prices in one call when you tap it.
Alpaca allows one live news connection per account; if another device already holds it, that device falls back to fetching news every 10 seconds (status shows ◌ polling 10s). Keys are kept only in that browser (`localStorage` key `bull_alpaca_news_v1`) and sent only to Alpaca.

**Timing.** Every story shows its publish time to the second in ET (e.g. `10:42:17 AM ET`) plus a live "1m 05s ago" counter that ticks every second. Hover a time for when it was received and by which feed. If a story reached us more than 2 minutes after it was published, it's tagged **arrived Xm late** (stories already on the page at load are history, not flagged). The **↻** button fetches news and prices immediately and reconnects the live stream if it dropped; the header shows the exact time of the last update.

**Backup key (Finnhub).** Uses [Finnhub](https://finnhub.io/register) (free tier, 60 calls/min). Paste the key into the panel once. It is stored only in that browser (`localStorage` key `bull_finnhub_key_v1`) and sent only to Finnhub. Use ⚙ in the panel to change or remove it. Each device needs the key pasted once.

**Tuning.** Everything lives in `CONFIG` at the top of `flash_news.js`, or override any part before the script loads:

```html
<script>window.FLASH_NEWS_CONFIG = { pollSeconds: 60, movePct: 3 };</script>
```

| Setting | Default | Meaning |
|---|---|---|
| `pollSeconds` | 30 | How often news and quotes are polled |
| `flashThreshold` / `highThreshold` | 3 / 5 | Score to show at all / score for the red HIGH badge |
| `weights` | watchlist 2, keyword 2, priceMove 2, fresh 1 | Points per signal |
| `movePct`, `moveWindowMinutes` | 2, 5 | "Big move" = ±2% within 5 minutes (from live Finnhub quotes) |
| `maxAgeMinutes`, `freshMinutes` | 60, 10 | Ignore older news / bonus for very new news |
| `keywords`, `acronyms` | see file | High-impact words (acronyms like SEC, Fed, CPI match case-sensitively) |
| `focusSymbols` | tech + energy lists | Always-watched names, after holdings and trending picks |
| `bullishWords`, `bearishWords` | see file | Decide 🟢▲ bullish vs 🔴▼ bearish colouring |
| `maxSymbols`, `companyNewsPerCycle` | 14, 3 | With the 4 sector-fund quotes, keeps each 30s cycle at ~22 calls, inside the free rate limit |

**Sector outlook.** Under the news list, one line per sector (Tech, Energy, Health & Biotech, Financials) gives a quick lean: 🟢▲ *may go up*, 🔴▼ *may go down*, or ⚪ *mixed*. It counts bullish vs bearish headlines from the last 3 hours that mention the sector's stocks or words (a headline that would also be a flash item counts double), adds ±1 if the sector fund (XLK, XLE, XLV, XLF) is up or down 1%+ today, and leans when the net is ±2 or more. It also links the headline driving the lean. Sectors, their stocks, words and thresholds live in `CONFIG.sectors`, `sectorWindowMinutes`, `sectorLeanAt` and `etfDayPct`.

**Tap a sector for details.** Tapping a sector line opens:
- **Why** the sector leans that way, in plain English. Big-picture rules in `CONFIG.macroRules` map news types to sectors, e.g. *Fed / higher interest rates → Tech ▼ ("higher rates make future tech profits worth less today") and Financials ▲*, *oil rising → Energy ▲*, *war / sanctions → Energy ▲, Tech ▼*, *FDA approval → Health ▲*, *export curbs / tariffs → Tech ▼*. Each reason links the headline behind it.
- **Stocks that may go up / down** in that sector (e.g. NVDA, SNDK, AAOI), each with a one-line reason: its own good/bad headline, today's move (fetched when you tap, cached 2 minutes), and the sector-wide reason when the stock is already moving that way. Company names (`CONFIG.companyNames`) let "Nvidia" in a headline count for NVDA.

**Search.** Type a ticker or company name (NVDA, SanDisk, Exxon) and press Analyze. It finds the symbol (known names first, otherwise Finnhub's symbol search), pulls 3 days of that company's news and today's quote, and shows **may go up / may go down / no clear direction** with a confidence level (Low / Medium / High), the reasons, and the latest headlines. A stock's own news and price decide the call; sector-wide themes are listed as context and move the score by at most ±0.5. Each search uses 2-3 API calls.

**Signals, not orders.** Green ▲ / red ▼ reflect the wording of the headline plus the 5-minute price move. They are news signals for a human to look at, not buy/sell instructions — Bull's routines do not read this panel.

**Auto-update on every device.** `index.html` has `const BUILD = "…"`, `version.json` holds `{"v": "…"}`, and the script tag loads `flash_news.js?v=…`. Every open dashboard checks `version.json` every 2 minutes (and when the tab comes back) and reloads itself onto the new version. **On every deploy, bump all three to the same new value.** Devices still running a version from before this feature need one manual refresh.

**Testing.** Open the dashboard with `?flashtest=1` (or run `FlashNews.injectMock()` in the browser console). It adds two fake items without needing a key:
- `NVDA beats earnings, raises full-year guidance (TEST)` with a pretend +2.6% move → score 7, **HIGH**, 🟢▲
- `Fed warns of rate hike at next rate decision as CPI runs hot (TEST)` → score 3, **MEDIUM**, 🔴▼
- Sector outlook: Energy 🟢▲ and Health & Biotech 🟢▲ may go up, Tech 🔴▼ may go down, Financials ⚪ mixed

To test background alerts: click 🔔 to allow notifications, switch to another tab, then run `FlashNews.injectMock()` from the console of the dashboard tab after it has been hidden (or wait for real news).
