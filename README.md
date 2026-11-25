# trading-dashboard

Mobile-first dashboard for the Bull trading agent. Reads data from the private trading-agent repo using a fine-grained GitHub token stored in the visitor's browser localStorage (never on any server). Live at https://vinay8558.github.io/trading-dashboard/

## Flash News panel (`flash_news.js`)

A slim banner under the top bar that shows only major, market-moving news for Bull's holdings, Bull's trending picks (top of the momentum ranking) and a fixed tech + energy focus list. Self-contained: if it fails, the rest of the dashboard keeps working.

**API key.** Uses [Finnhub](https://finnhub.io/register) (free tier, 60 calls/min). Paste the key into the panel once. It is stored only in that browser (`localStorage` key `bull_finnhub_key_v1`) and sent only to Finnhub. Use ⚙ in the panel to change or remove it. Each device needs the key pasted once.

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

**Signals, not orders.** Green ▲ / red ▼ reflect the wording of the headline plus the 5-minute price move. They are news signals for a human to look at, not buy/sell instructions — Bull's routines do not read this panel.

**Testing.** Open the dashboard with `?flashtest=1` (or run `FlashNews.injectMock()` in the browser console). It adds two fake items without needing a key:
- `NVDA beats earnings, raises full-year guidance (TEST)` with a pretend +2.6% move → score 7, **HIGH**, 🟢▲
- `Fed warns of rate hike at next rate decision as CPI runs hot (TEST)` → score 3, **MEDIUM**, 🔴▼
- Sector outlook: Energy 🟢▲ and Health & Biotech 🟢▲ may go up, Tech 🔴▼ may go down, Financials ⚪ mixed

To test background alerts: click 🔔 to allow notifications, switch to another tab, then run `FlashNews.injectMock()` from the console of the dashboard tab after it has been hidden (or wait for real news).
