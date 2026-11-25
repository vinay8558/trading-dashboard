/* ─────────────────────────────────────────────────────────────────────────
 * Flash News — surfaces only major, market-moving news for Bull's watchlist.
 *
 * Self-contained: no dependencies, its own styles, its own error handling.
 * Nothing in here can throw into the host page — every timer/fetch is wrapped.
 *
 * Public interface (window.FlashNews):
 *   FlashNews.CONFIG                         – tunables (keywords, weights, thresholds)
 *   FlashNews.computeFlashItems(news, watchlist, priceMoves, now?)
 *        news       = [{headline, url, source, datetime(ms), related:[SYM]}]
 *        watchlist  = ["NVDA","MSFT",...]
 *        priceMoves = {NVDA: 2.4, ...}   // % move over the last 5 minutes
 *        → [{...item, score, impact:"HIGH"|"MEDIUM", reasons:[...]}]  newest first
 *   FlashNews.mount(containerEl, {getWatchlist})   – starts polling + renders the panel
 *   FlashNews.injectMock()                   – adds a fake HIGH + MEDIUM item (testing)
 *
 * API key: stored only in this browser (localStorage "bull_finnhub_key_v1"),
 * entered once through the panel. Never hardcoded, never committed.
 * ───────────────────────────────────────────────────────────────────────── */
(function (global) {
  "use strict";

  // ── All tunables in one place ──────────────────────────────────────────
  const CONFIG = Object.assign({
    pollSeconds: 30,              // how often to poll news + quotes
    maxItems: 20,                 // items kept in the panel
    flashThreshold: 3,            // score needed to show at all
    highThreshold: 5,             // score for the red HIGH badge (3-4 = MEDIUM)
    maxAgeMinutes: 60,            // ignore news older than this
    freshMinutes: 10,             // "+fresh" bonus window
    moveWindowMinutes: 5,         // price-move lookback
    movePct: 2,                   // |move| >= this % counts as a big move
    maxSymbols: 14,               // cap on watched symbols (Finnhub free tier = 60 calls/min; ~22 calls per cycle)
    companyNewsPerCycle: 3,       // symbols whose company-news is fetched each cycle (rotates)
    // Always watched, after Bull's holdings and trending picks (sector focus).
    focusSymbols: {
      tech:   ["NVDA", "MSFT", "AAPL", "GOOGL", "AMZN", "META", "AVGO", "AMD", "TSM"],
      energy: ["XOM", "CVX", "COP", "OXY", "VST", "CEG"],
    },
    // Direction of the news (colours the row). Whole words, case-insensitive.
    bullishWords: ["beats", "beat", "tops", "raises", "raised", "upgrade", "upgraded", "record", "surges", "soars",
      "jumps", "rally", "rallies", "rises", "gains", "climbs", "rebounds", "approves", "approval", "approved", "buyback", "wins", "awarded", "partnership", "outperform",
      "strong demand", "rate cut", "cuts rates", "ceasefire"],
    bearishWords: ["misses", "miss", "falls", "drops", "slides", "declines", "slips", "plunges", "tumbles", "sinks", "slumps", "downgrade", "downgraded",
      "cuts guidance", "lowers", "warns", "warning", "lawsuit", "sues", "probe", "investigation", "recall", "halt",
      "halted", "bankruptcy", "layoffs", "resigns", "sanctions", "war", "tariff", "tariffs", "rate hike", "hikes rates",
      "fraud", "delisted", "underperform"],
    staggerMs: 350,               // gap between API calls inside one cycle
    highlightSeconds: 5,          // new-item flash duration
    weights: { watchlist: 2, keyword: 2, priceMove: 2, fresh: 1 },
    // Matched as whole words, case-insensitive…
    keywords: [
      "earnings", "beats", "misses", "guidance", "acquisition", "merger", "buyout",
      "bankruptcy", "halt", "halted", "lawsuit", "downgrade", "upgrade", "recall",
      "CEO resigns", "rate decision", "inflation", "war", "sanctions",
    ],
    // …except these acronyms, matched case-sensitively so "fed up" ≠ "Fed".
    acronyms: ["SEC", "FDA", "Fed", "RBI", "CPI"],
    // ── Sector Outlook (quick read per sector from recent headlines + the sector fund's day move) ──
    sectorWindowMinutes: 180,     // headlines from the last 3 hours count toward the outlook
    sectorLeanAt: 2,              // net score >= +2 → "may go up", <= -2 → "may go down"
    etfDayPct: 1,                 // sector fund up/down >= 1% today adds +1/-1
    sectors: {
      "Tech":             { etf: "XLK", symbols: ["NVDA","MSFT","AAPL","GOOGL","AMZN","META","AVGO","AMD","TSM","ORCL","MU","SNDK","AAOI","ANET","INTC","PLTR"],
                            words: ["chip","chips","chipmaker","semiconductor","software","cloud","tech","Nvidia","Apple","Microsoft","Google","Meta","AI","data center"] },
      "Energy":           { etf: "XLE", symbols: ["XOM","CVX","COP","OXY","SLB","EOG","VST","CEG","NEE","GEV"],
                            words: ["oil","crude","OPEC","natural gas","energy","gasoline","refinery","drilling","power grid","Brent","WTI"] },
      "Health & Biotech": { etf: "XLV", symbols: ["LLY","UNH","JNJ","MRK","ABBV","PFE","AMGN","MRNA","VRTX","REGN","GILD","ISRG"],
                            words: ["FDA","drug","drugmaker","biotech","pharma","trial","vaccine","Medicare","Medicaid","obesity","cancer","therapy"] },
      "Financials":       { etf: "XLF", symbols: ["JPM","BAC","GS","MS","WFC","C","SCHW","BLK","V","MA"],
                            words: ["bank","banks","lender","lenders","Treasury yields","credit","mortgage","Wall Street"] },
    },
    // Company names, so a headline saying "Nvidia" counts for NVDA in the per-stock view.
    companyNames: {
      NVDA: "Nvidia", MSFT: "Microsoft", AAPL: "Apple", GOOGL: "Alphabet|Google", AMZN: "Amazon", META: "Meta",
      AVGO: "Broadcom", AMD: "AMD|Advanced Micro", TSM: "TSMC|Taiwan Semiconductor", ORCL: "Oracle", MU: "Micron",
      SNDK: "SanDisk|Sandisk", AAOI: "Applied Optoelectronics", ANET: "Arista", INTC: "Intel", PLTR: "Palantir",
      XOM: "Exxon", CVX: "Chevron", COP: "ConocoPhillips", OXY: "Occidental", SLB: "Schlumberger|SLB", EOG: "EOG",
      VST: "Vistra", CEG: "Constellation Energy", NEE: "NextEra", GEV: "GE Vernova",
      LLY: "Lilly", UNH: "UnitedHealth", JNJ: "Johnson & Johnson|J&J", MRK: "Merck", ABBV: "AbbVie", PFE: "Pfizer",
      AMGN: "Amgen", MRNA: "Moderna", VRTX: "Vertex", REGN: "Regeneron", GILD: "Gilead", ISRG: "Intuitive Surgical",
      JPM: "JPMorgan", BAC: "Bank of America", GS: "Goldman", MS: "Morgan Stanley", WFC: "Wells Fargo", C: "Citigroup|Citi",
      SCHW: "Schwab", BLK: "BlackRock", V: "Visa", MA: "Mastercard",
      TSLA: "Tesla", NFLX: "Netflix", CRM: "Salesforce", QCOM: "Qualcomm", ARM: "Arm Holdings",
    },
    // Big-picture rules: what kind of news usually moves which sector, and why (plain English).
    // `match` = phrases (whole words, normal endings allowed). Effects: +1 helps, -1 hurts.
    macroRules: [
      { label: "Fed / higher interest rates",
        match: ["rate hike", "hikes rates", "raise rates", "higher rates", "higher for longer", "hawkish", "yields rise", "yields jump", "yields climb", "yields surge"],
        effects: { "Tech": [-1, "higher rates make future tech profits worth less today, so tech and growth stocks often fall"],
                   "Financials": [+1, "banks usually earn more on loans when rates are higher"] } },
      { label: "Fed / lower interest rates",
        match: ["rate cut", "cuts rates", "lower rates", "dovish", "yields fall", "yields drop", "yields slide"],
        effects: { "Tech": [+1, "cheaper money usually lifts tech and growth stocks"],
                   "Financials": [-1, "lower rates can squeeze what banks earn on loans"] } },
      { label: "Hot inflation",
        match: ["hot inflation", "inflation rises", "inflation jumps", "inflation accelerates", "CPI runs hot", "hotter-than-expected", "prices rise faster"],
        effects: { "Tech": [-1, "hot inflation raises the chance of higher rates, which usually hurts tech"] } },
      { label: "Oil prices rising",
        match: ["oil jumps", "oil rises", "oil surges", "oil climbs", "crude rises", "crude jumps", "crude surges", "OPEC cut", "OPEC extends", "output limits", "supply cut"],
        effects: { "Energy": [+1, "higher oil and gas prices lift energy companies' profits"] } },
      { label: "Oil prices falling",
        match: ["oil falls", "oil drops", "oil slumps", "oil tumbles", "crude falls", "crude drops", "crude slumps", "oversupply", "OPEC boosts output", "OPEC raises output"],
        effects: { "Energy": [-1, "lower oil prices squeeze energy companies' profits"] } },
      { label: "Trade limits / tariffs",
        match: ["export curbs", "export controls", "export ban", "chip ban", "chip restrictions", "tariff", "trade war"],
        effects: { "Tech": [-1, "export limits and tariffs can cut chipmakers' overseas sales and raise costs"] } },
      { label: "War / sanctions",
        match: ["war", "missile", "airstrike", "invasion", "sanctions", "military strike"],
        effects: { "Energy": [+1, "conflict raises oil supply risk, which tends to push energy stocks up"],
                   "Tech": [-1, "investors often sell riskier stocks like tech when conflict flares"] } },
      { label: "FDA approval",
        match: ["FDA approves", "FDA approval", "FDA clears", "wins approval"],
        effects: { "Health & Biotech": [+1, "a drug approval opens a new source of sales"] } },
      { label: "FDA rejection / failed trial",
        match: ["FDA rejects", "FDA declines", "complete response letter", "trial fails", "failed trial", "trial halted"],
        effects: { "Health & Biotech": [-1, "a rejection or failed trial wipes out expected future sales"] } },
      { label: "Slowing economy",
        match: ["recession", "jobless claims rise", "weak jobs", "layoffs surge", "economy shrinks", "GDP contracts"],
        effects: { "Financials": [-1, "a slowing economy means fewer loans and more defaults"],
                   "Tech": [-1, "companies and shoppers cut spending when the economy slows"] } },
      { label: "AI spending boom",
        match: ["AI spending", "AI demand", "data center demand", "AI capex", "AI orders"],
        effects: { "Tech": [+1, "more AI spending means more chip and server sales"],
                   "Energy": [+1, "AI data centers need a lot more electricity, helping power producers"] } },
    ],
    stockDayPct: 2,               // a stock up/down >= 2% today adds +1/-1 to its lean
    stockQuoteCacheSeconds: 120,  // tapped-sector quotes are reused for 2 minutes
    keyStorage: "bull_finnhub_key_v1",
    muteStorage: "bull_flash_muted_v1",
    apiBase: "https://finnhub.io/api/v1",
  }, global.FLASH_NEWS_CONFIG || {});

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyOf = it => (String(it.headline || "").toLowerCase().replace(/\W+/g, " ").trim()) + "|" + String(it.url || "").split("?")[0];

  // Whole word, allowing normal endings: downgrade → downgraded (but "war" never matches "warehouse").
  // Base forms are tried too, so "surges" also matches "surge" and "falls" matches "fall".
  const wordRe = w => {
    const forms = [...new Set([w, w.replace(/es$/i, ""), w.replace(/s$/i, "")])].filter(f => f.length >= 3)
      .map(f => reEsc(f).replace(/\s+/g, "\\s+"));
    return new RegExp("\\b(?:" + forms.join("|") + ")(?:s|es|d|ed|ing)?\\b", "i");
  };
  const BULL_RES = CONFIG.bullishWords.map(wordRe);
  const BEAR_RES = CONFIG.bearishWords.map(wordRe);

  /** "bull" | "bear" | "neutral" — from headline wording plus the 5-min price move. */
  function sentimentOf(headline, move) {
    let n = 0;
    BULL_RES.forEach(re => { if (re.test(headline)) n += 1; });
    BEAR_RES.forEach(re => { if (re.test(headline)) n -= 1; });
    if (Math.abs(move || 0) >= CONFIG.movePct) n += move > 0 ? 1 : -1;   // the tape counts too
    return n > 0 ? "bull" : n < 0 ? "bear" : "neutral";
  }

  // Sector matchers: ALL-CAPS short words (AI, FDA, OPEC, WTI) are case-sensitive, others not.
  const SECTOR_RES = Object.fromEntries(Object.entries(CONFIG.sectors).map(([name, s]) => [name, {
    symbols: new Set(s.symbols), etf: s.etf,
    words: s.words.map(w => /^[A-Z]{2,5}$/.test(w) ? new RegExp("\\b" + reEsc(w) + "\\b") : wordRe(w)),
  }]));

  /**
   * Quick per-sector read. input = recent news + sector-fund day moves ({XLK: -1.2, ...})
   * output = [{sector, direction:"up"|"down"|"mixed", net, bull, bear, etf, etfMove, count, driver, summary}]
   * Each headline is matched to sectors by its related symbols or sector words, then counted as
   * bullish (+1) or bearish (-1) — double weight if it would also be a flash item (score >= threshold).
   */
  // Which big-picture rules fired in the window (latest headline per rule).
  function macroHits(news, now) {
    const hits = new Map();
    for (const it of news || []) {
      if (!it || !it.headline || (now - it.datetime) / 60000 > CONFIG.sectorWindowMinutes) continue;
      MACRO_RES.forEach((rule, i) => {
        if (!rule.res.some(re => re.test(it.headline))) return;
        const prev = hits.get(i);
        if (!prev || it.datetime > prev.item.datetime) hits.set(i, { rule, item: it });
      });
    }
    return [...hits.values()];
  }

  function sectorOutlook(news, etfMoves, now, watchlist) {
    now = now || Date.now();
    etfMoves = etfMoves || {};
    const watchSet = new Set(watchlist || []);
    const macros = macroHits(news, now);
    const out = [];
    for (const [name, sec] of Object.entries(SECTOR_RES)) {
      let bull = 0, bear = 0, count = 0, best = { bull: null, bear: null }, bestW = { bull: 0, bear: 0 };
      const seen = new Set();
      for (const it of news || []) {
        if (!it || !it.headline || (now - it.datetime) / 60000 > CONFIG.sectorWindowMinutes) continue;
        const k = keyOf(it);
        if (seen.has(k)) continue;
        seen.add(k);
        const head = String(it.headline);
        const hit = (it.related || []).some(s => sec.symbols.has(s)) || sec.words.some(re => re.test(head));
        if (!hit) continue;
        count++;
        const sent = sentimentOf(head, 0);
        if (sent === "neutral") continue;
        const big = scoreItem(it, watchSet, {}, now).score >= CONFIG.flashThreshold;
        const w = big ? 2 : 1;
        if (sent === "bull") bull += w; else bear += w;
        if (w > bestW[sent] || (w === bestW[sent] && best[sent] && it.datetime > best[sent].datetime)) { best[sent] = Object.assign({ sentiment: sent }, it); bestW[sent] = w; }
      }
      const etfMove = typeof etfMoves[sec.etf] === "number" ? etfMoves[sec.etf] : null;
      let net = bull - bear;
      if (etfMove !== null && Math.abs(etfMove) >= CONFIG.etfDayPct) net += etfMove > 0 ? 1 : -1;

      // Plain-English reasons: big-picture rules first, then the strongest company headlines.
      const reasons = [];
      let macroNet = 0;
      for (const h of macros) {
        const eff = h.rule.effects[name];
        if (!eff) continue;
        // Same headline, same direction → count it once (e.g. "rate hike … CPI runs hot" is one story).
        if (reasons.some(r => r.macro && r.headline === h.item.headline && r.dir === (eff[0] > 0 ? "up" : "down"))) continue;
        net += eff[0]; macroNet += eff[0];
        reasons.push({ dir: eff[0] > 0 ? "up" : "down", label: h.rule.label, why: eff[1], headline: h.item.headline, url: h.item.url, macro: true });
      }
      for (const side of ["bear", "bull"]) {
        const b = best[side];
        if (!b || reasons.some(r => r.headline === b.headline)) continue;
        const who = (b.related || []).filter(s => sec.symbols.has(s))[0];
        reasons.push({ dir: side === "bull" ? "up" : "down", label: `${side === "bull" ? "Good" : "Bad"} news${who ? " for " + who : ""}`,
                       why: side === "bull" ? "positive company news tends to lift the stock and its peers" : "negative company news tends to drag the stock and its peers",
                       headline: b.headline, url: b.url });
      }
      if (etfMove !== null && Math.abs(etfMove) >= CONFIG.etfDayPct)
        reasons.push({ dir: etfMove > 0 ? "up" : "down", label: `${sec.etf} ${etfMove > 0 ? "up" : "down"} ${Math.abs(etfMove).toFixed(1)}% today`,
                       why: `the whole sector is already moving ${etfMove > 0 ? "up" : "down"} today`, headline: "", url: "" });

      const direction = net >= CONFIG.sectorLeanAt ? "up" : net <= -CONFIG.sectorLeanAt ? "down" : "mixed";
      // Reasons that agree with the lean go first.
      reasons.sort((a, b) => (b.dir === direction) - (a.dir === direction));
      const verb = direction === "up" ? "may go up" : direction === "down" ? "may go down" : "mixed / no clear lean";
      const parts = [];
      if (bull || bear) parts.push(`${bull} bullish vs ${bear} bearish`);
      else parts.push(count ? `${count} headline(s), none clearly good or bad` : "no recent headlines");
      if (etfMove !== null) parts.push(`${sec.etf} ${etfMove >= 0 ? "+" : ""}${etfMove.toFixed(1)}% today`);
      const lead = reasons.find(r => r.macro && r.dir === direction);
      if (lead) parts.unshift(lead.label);
      const mainMacro = macroNet ? reasons.find(r => r.macro && r.dir === (macroNet > 0 ? "up" : "down")) : null;
      out.push({ sector: name, direction, net, bull, bear, count, etf: sec.etf, etfMove, reasons, macroNet, mainMacro,
                 driver: direction === "up" ? best.bull : direction === "down" ? best.bear : null,
                 summary: `${name} ${verb} — ${parts.join(" · ")}` });
    }
    // Strongest leans first.
    out.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    return out;
  }

  const MACRO_RES = CONFIG.macroRules.map(r => Object.assign({}, r, {
    res: r.match.map(w => /^[A-Z]{2,5}\b/.test(w) && w === w.toUpperCase() ? new RegExp("\\b" + reEsc(w) + "\\b") : wordRe(w)),
  }));

  const NAME_RES = Object.fromEntries(Object.entries(CONFIG.companyNames).map(([sym, n]) =>
    [sym, new RegExp("(^|[^A-Za-z])(?:" + n.split("|").map(reEsc).join("|") + ")(?![A-Za-z])", "i")]));

  /**
   * Per-stock lean inside one sector (shown when a sector line is tapped).
   * input = sector name, recent news, {SYM: day %}, {SYM: 5-min %}
   * output = { up:[...], down:[...], quiet:[...] } each {sym, score, bull, bear, dayPct, move5, reason, driver}
   * Score = bullish − bearish headlines about that stock (high-impact ones count double)
   *         ± 1 if the stock is up/down >= 2% today, ± 1 if it moved >= 2% in the last 5 minutes.
   */
  function stockLeans(sectorName, news, dayPct, moves5, now, watchlist, sectorMacro) {
    now = now || Date.now();
    const sec = CONFIG.sectors[sectorName];
    if (!sec) return { up: [], down: [], quiet: [] };
    const watchSet = new Set(watchlist || []);
    const recent = (news || []).filter(it => it && it.headline && (now - it.datetime) / 60000 <= CONFIG.sectorWindowMinutes);
    const rows = sec.symbols.map(sym => {
      let bull = 0, bear = 0, nBull = 0, nBear = 0, driver = null, driverW = 0;
      const seen = new Set();
      for (const it of recent) {
        const k = keyOf(it);
        if (seen.has(k)) continue;
        const head = String(it.headline);
        const about = (it.related || []).includes(sym) ||
          (sym.length >= 3 && new RegExp("(^|[^A-Za-z])\\$?" + reEsc(sym) + "(?![A-Za-z])").test(head)) ||
          (NAME_RES[sym] && NAME_RES[sym].test(head));
        if (!about) continue;
        seen.add(k);
        const sent = sentimentOf(head, 0);
        if (sent === "neutral") continue;
        const w = KEYWORD_RES.some(re => re.test(head)) ? 2 : 1;   // high-impact headline counts double
        if (sent === "bull") { bull += w; nBull++; } else { bear += w; nBear++; }
        if (w >= driverW) { driver = Object.assign({ sentiment: sent }, it); driverW = w; }
      }
      const d = typeof (dayPct || {})[sym] === "number" ? dayPct[sym] : null;
      const m5 = typeof (moves5 || {})[sym] === "number" ? moves5[sym] : null;
      let score = bull - bear;
      if (d !== null && Math.abs(d) >= CONFIG.stockDayPct) score += d > 0 ? 1 : -1;
      if (m5 !== null && Math.abs(m5) >= CONFIG.movePct) score += m5 > 0 ? 1 : -1;
      // Big-picture reason (e.g. higher rates hurt tech) applies when the stock is already moving that way today.
      let macroApplied = null;
      if (sectorMacro && sectorMacro.macroNet && d !== null && Math.abs(d) >= 0.5 && Math.sign(d) === Math.sign(sectorMacro.macroNet)) {
        score += Math.sign(sectorMacro.macroNet);
        macroApplied = sectorMacro.mainMacro;
      }
      const bits = [];
      if (nBull) bits.push(`${nBull} good headline${nBull > 1 ? "s" : ""}`);
      if (nBear) bits.push(`${nBear} bad headline${nBear > 1 ? "s" : ""}`);
      if (m5 !== null && Math.abs(m5) >= CONFIG.movePct) bits.push(`${m5 > 0 ? "+" : ""}${m5.toFixed(1)}% in 5 min`);
      if (macroApplied) bits.push(macroApplied.label);
      if (!bits.length && d !== null) bits.push("price move only");

      // One plain-English sentence for the expanded view.
      const cut = (t, n) => t.length > n ? t.slice(0, n - 1) + "…" : t;
      let why;
      if (driver && score !== 0 && (driver.sentiment === "bull") === (score > 0))
        why = `${driver.sentiment === "bull" ? "Good" : "Bad"} news: “${cut(String(driver.headline).replace(/\s*\(TEST\)$/, ""), 80)}”`;
      else if (macroApplied)
        why = `${macroApplied.label} → ${macroApplied.why}`;
      else if (d !== null && Math.abs(d) >= CONFIG.stockDayPct)
        why = `Already ${d > 0 ? "up" : "down"} ${Math.abs(d).toFixed(1)}% today with no single headline behind it`;
      else why = bits.join(", ");
      if (macroApplied && driver && !why.startsWith(macroApplied.label)) why += ` · also ${macroApplied.label}`;
      return { sym, score, bull, bear, dayPct: d, move5: m5, reason: bits.join(", "), why, driver };
    });
    const byStrength = (a, b) => Math.abs(b.score) - Math.abs(a.score) || Math.abs(b.dayPct || 0) - Math.abs(a.dayPct || 0);
    return {
      up: rows.filter(r => r.score > 0).sort(byStrength),
      down: rows.filter(r => r.score < 0).sort(byStrength),
      quiet: rows.filter(r => r.score === 0),
    };
  }

  /**
   * Single-stock analysis for the search box.
   * input  = symbol, news (its own company news + market news), today's % move, 5-min % move,
   *          the sector-outlook rows (for big-picture reasons like Fed rates)
   * output = { sym, sector, direction:"up"|"down"|"mixed", score, confidence, reasons:[{dir,text,url}], headlines:[...] }
   * Headlines from the last 24h count fully, 1-3 days old count half; high-impact ones count double.
   */
  function analyzeSymbol(sym, news, dayPct, move5, sectorRows, now) {
    now = now || Date.now();
    sym = String(sym).toUpperCase();
    const sector = Object.keys(CONFIG.sectors).find(n => CONFIG.sectors[n].symbols.includes(sym)) || null;
    const nameRe = NAME_RES[sym];
    const symRe = sym.length >= 2 ? new RegExp("(^|[^A-Za-z])\\$?" + reEsc(sym) + "(?![A-Za-z])") : null;
    const seen = new Set();
    const about = (news || []).filter(it => {
      if (!it || !it.headline || (now - it.datetime) / 3600000 > 72) return false;
      const k = keyOf(it);
      if (seen.has(k)) return false;
      seen.add(k);
      const h = String(it.headline);
      return (it.related || []).includes(sym) || (symRe && symRe.test(h)) || (nameRe && nameRe.test(h));
    }).sort((a, b) => b.datetime - a.datetime);

    let score = 0;
    const reasons = [];
    const clean = t => String(t).replace(/\s*\(TEST\)$/, "");
    const cut = (t, n) => t.length > n ? t.slice(0, n - 1) + "…" : t;
    for (const it of about) {
      const sent = sentimentOf(it.headline, 0);
      it._sent = sent;
      if (sent === "neutral") continue;
      const w = (KEYWORD_RES.some(re => re.test(it.headline)) ? 2 : 1) * ((now - it.datetime) / 3600000 <= 24 ? 1 : 0.5);
      score += sent === "bull" ? w : -w;
      if (reasons.filter(r => r.kind === "news").length < 3)
        reasons.push({ kind: "news", dir: sent === "bull" ? "up" : "down", w,
          text: `${sent === "bull" ? "Good" : "Bad"} news: “${cut(clean(it.headline), 90)}”`, url: it.url });
    }
    if (typeof dayPct === "number" && Math.abs(dayPct) >= CONFIG.stockDayPct) {
      score += dayPct > 0 ? 1 : -1;
      reasons.push({ kind: "price", dir: dayPct > 0 ? "up" : "down", w: 1, text: `Already ${dayPct > 0 ? "up" : "down"} ${Math.abs(dayPct).toFixed(1)}% today — the market is reacting` });
    }
    if (typeof move5 === "number" && Math.abs(move5) >= CONFIG.movePct) {
      score += move5 > 0 ? 1 : -1;
      reasons.push({ kind: "price", dir: move5 > 0 ? "up" : "down", w: 1, text: `Moved ${move5 > 0 ? "+" : ""}${move5.toFixed(1)}% in the last 5 minutes` });
    }
    const row = sector && (sectorRows || []).find(r => r.sector === sector);
    // Big-picture (sector-wide) reasons are context: listed, but together they move the score by at most ±0.5,
    // so a stock's own news and price action decide the call.
    if (row) {
      let macroSum = 0;
      for (const m of (row.reasons || []).filter(r => r.macro).slice(0, 2)) {
        macroSum += m.dir === "up" ? 1 : -1;
        reasons.push({ kind: "macro", dir: m.dir, w: 0.5, text: `${m.label} → ${m.why}`, url: m.url });
      }
      score += Math.sign(macroSum) * 0.5;
    }
    const direction = score >= 1.5 ? "up" : score <= -1.5 ? "down" : "mixed";
    const agree = reasons.filter(r => r.dir === direction).length, against = reasons.filter(r => r.dir !== direction).length;
    const confidence = direction === "mixed" ? "Low" : (agree >= 3 && Math.abs(score) >= 3 && agree > against * 2) ? "High" : agree >= 2 ? "Medium" : "Low";
    reasons.sort((a, b) => (b.dir === direction) - (a.dir === direction) || b.w - a.w);
    return { sym, sector, direction, score: Math.round(score * 10) / 10, confidence, dayPct: typeof dayPct === "number" ? dayPct : null,
             reasons, headlines: about.slice(0, 5).map(it => ({ headline: clean(it.headline), url: it.url, source: it.source, datetime: it.datetime, sentiment: it._sent })) };
  }

  const KEYWORD_RES = [
    ...CONFIG.keywords.map(wordRe),
    ...CONFIG.acronyms.map(k => new RegExp("\\b" + reEsc(k) + "\\b")),
  ];

  // ── Scoring (pure) ─────────────────────────────────────────────────────
  function scoreItem(item, watchSet, priceMoves, now) {
    const w = CONFIG.weights;
    const reasons = [];
    let score = 0;
    const head = String(item.headline || "");

    const related = (item.related || []).filter(s => watchSet.has(s));
    const mentioned = [...watchSet].filter(s =>
      s.length >= 2 && (new RegExp("(^|[^A-Za-z])\\$?" + reEsc(s) + "(?![A-Za-z])").test(head)));
    const syms = [...new Set([...related, ...mentioned])];
    if (syms.length) { score += w.watchlist; reasons.push("watchlist"); }

    if (KEYWORD_RES.some(re => re.test(head))) { score += w.keyword; reasons.push("keyword"); }

    const moved = syms.find(s => Math.abs(priceMoves[s] || 0) >= CONFIG.movePct);
    if (moved) { score += w.priceMove; reasons.push(`${moved} ${priceMoves[moved] > 0 ? "+" : ""}${priceMoves[moved].toFixed(1)}%`); }

    const ageMin = (now - item.datetime) / 60000;
    if (ageMin < CONFIG.freshMinutes) { score += w.fresh; reasons.push("fresh"); }

    const move = syms.map(s => priceMoves[s]).find(m => Math.abs(m || 0) >= CONFIG.movePct) || 0;
    return { score, reasons, symbols: syms, sentiment: sentimentOf(head, move) };
  }

  /** input = news + watchlist + recent price moves → output = flash items, newest first */
  function computeFlashItems(news, watchlist, priceMoves, now) {
    now = now || Date.now();
    const watchSet = new Set((watchlist || []).map(s => String(s).toUpperCase()));
    const seen = new Set();
    const out = [];
    for (const it of news || []) {
      if (!it || !it.headline || !it.datetime) continue;
      const age = (now - it.datetime) / 60000;
      if (age > CONFIG.maxAgeMinutes || age < -5) continue;      // too old (or bad clock)
      const k = keyOf(it);
      if (seen.has(k)) continue;
      seen.add(k);
      const s = scoreItem(it, watchSet, priceMoves || {}, now);
      if (s.score < CONFIG.flashThreshold) continue;
      out.push(Object.assign({}, it, s, {
        key: k, impact: s.score >= CONFIG.highThreshold ? "HIGH" : "MEDIUM",
      }));
    }
    out.sort((a, b) => b.datetime - a.datetime);
    return out.slice(0, CONFIG.maxItems);
  }

  // ── Price tracker: 5-minute moves from repeated quote snapshots ───────
  const priceHistory = {};   // sym -> [{t, p}]
  function recordPrice(sym, p, t) {
    if (!(p > 0)) return;
    const h = priceHistory[sym] = priceHistory[sym] || [];
    h.push({ t, p });
    const cutoff = t - (CONFIG.moveWindowMinutes + 2) * 60000;
    while (h.length && h[0].t < cutoff) h.shift();
  }
  function priceMoves(now) {
    const out = {};
    const from = now - CONFIG.moveWindowMinutes * 60000;
    for (const [sym, h] of Object.entries(priceHistory)) {
      if (h.length < 2) continue;
      const base = h.find(x => x.t >= from) || h[0];
      const last = h[h.length - 1];
      if (base !== last) out[sym] = (last.p / base.p - 1) * 100;
    }
    return out;
  }

  // ── Finnhub client with staggering + 429 backoff ───────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let backoffUntil = 0, backoffMs = 0;

  async function api(path, params) {
    if (Date.now() < backoffUntil) throw new Error("rate-limited, backing off");
    const key = getKey();
    if (!key) throw new Error("no API key");
    const q = new URLSearchParams(Object.assign({}, params, { token: key }));
    const r = await fetch(`${CONFIG.apiBase}${path}?${q}`, { cache: "no-store" });
    if (r.status === 429) {
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 60000, 5 * 60000);
      backoffUntil = Date.now() + backoffMs;
      throw new Error(`rate limit hit, pausing ${Math.round(backoffMs / 1000)}s`);
    }
    if (r.status === 401 || r.status === 403) throw new Error("Finnhub key rejected");
    if (!r.ok) throw new Error(`Finnhub error ${r.status}`);
    backoffMs = 0;
    return r.json();
  }

  const normalize = (raw, fallbackSym) => ({
    headline: raw.headline,
    url: /^https?:\/\//i.test(raw.url || "") ? raw.url : "",
    source: raw.source || "",
    datetime: (raw.datetime || 0) * 1000,
    related: String(raw.related || fallbackSym || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
  });

  // ── Panel state ────────────────────────────────────────────────────────
  const pool = new Map();          // key -> news item (last maxAge minutes)
  const shownKeys = new Set();     // flash items already displayed (for "new" detection)
  let firstCycle = true;
  let rotate = 0;
  let mockItems = [];
  let mockEtf = {};
  const etfDay = {};               // sector fund -> % change today
  const stockDay = {}, stockDayAt = {};   // stock -> % change today (+ when fetched)
  let mockDay = {};
  let state = { items: [], sectors: [], updated: null, error: null };
  let root, getWatchlist = () => [];
  let audioCtx = null;

  function getKey() { try { return localStorage.getItem(CONFIG.keyStorage) || ""; } catch { return ""; } }
  function setKey(k) { try { k ? localStorage.setItem(CONFIG.keyStorage, k) : localStorage.removeItem(CONFIG.keyStorage); } catch {} }
  function isMuted() { try { return localStorage.getItem(CONFIG.muteStorage) === "1"; } catch { return false; } }
  function setMuted(m) { try { localStorage.setItem(CONFIG.muteStorage, m ? "1" : "0"); } catch {} }

  function watchSymbols() {
    let list = [];
    try { list = getWatchlist() || []; } catch {}
    const focus = [...(CONFIG.focusSymbols.tech || []), ...(CONFIG.focusSymbols.energy || [])];
    return [...new Set([...list, ...focus].map(s => String(s).toUpperCase()).filter(s => /^[A-Z]{1,5}$/.test(s)))].slice(0, CONFIG.maxSymbols);
  }

  async function pollOnce() {
    const now = Date.now();
    const syms = watchSymbols();
    const errors = [];
    const ymd = d => d.toISOString().slice(0, 10);
    const from = ymd(new Date(now - 86400000)), to = ymd(new Date(now));

    try {
      (await api("/news", { category: "general" }) || []).forEach(n => { const it = normalize(n); pool.set(keyOf(it), it); });
    } catch (e) { errors.push(e.message); }

    // Company news: a few symbols per cycle, rotating, so we stay under rate limits.
    const batch = [];
    for (let i = 0; i < Math.min(CONFIG.companyNewsPerCycle, syms.length); i++) batch.push(syms[(rotate + i) % syms.length]);
    rotate = syms.length ? (rotate + batch.length) % syms.length : 0;
    for (const s of batch) {
      await sleep(CONFIG.staggerMs);
      try { (await api("/company-news", { symbol: s, from, to }) || []).forEach(n => { const it = normalize(n, s); pool.set(keyOf(it), it); }); }
      catch (e) { errors.push(e.message); }
    }

    // Quotes for every symbol → 5-minute move tracking.
    for (const s of syms) {
      await sleep(CONFIG.staggerMs);
      try {
        const q = await api("/quote", { symbol: s });
        recordPrice(s, q && q.c, Date.now());
        if (q && typeof q.dp === "number") { stockDay[s] = q.dp; stockDayAt[s] = Date.now(); }
      }
      catch (e) { errors.push(e.message); }
    }

    // Sector funds' day move (Finnhub quote "dp" = % change vs previous close) for the outlook.
    const etfs = Object.values(CONFIG.sectors).map(s => s.etf);
    for (const e of etfs) {
      await sleep(CONFIG.staggerMs);
      try { const q = await api("/quote", { symbol: e }); if (q && typeof q.dp === "number") etfDay[e] = q.dp; }
      catch (err) { errors.push(err.message); }
    }

    // Drop stale pool entries (kept long enough for the 3-hour sector view).
    const cutoff = Date.now() - Math.max(CONFIG.maxAgeMinutes, CONFIG.sectorWindowMinutes) * 60000;
    for (const [k, it] of pool) if (it.datetime < cutoff) pool.delete(k);

    const allErr = errors.length && errors.length >= 1 + batch.length + syms.length + etfs.length;
    state.error = allErr ? errors[0] : (errors.length ? `${errors.length} request(s) failed — ${errors[0]}` : null);
    if (!allErr) state.updated = new Date();
    recompute(true);
  }

  function recompute(fromPoll) {
    const now = Date.now();
    const items = computeFlashItems([...pool.values(), ...mockItems], watchSymbols(), Object.assign(priceMoves(now), mockMoves), now);
    const fresh = items.filter(it => !shownKeys.has(it.key));
    items.forEach(it => shownKeys.add(it.key));
    state.items = items;
    state.sectors = sectorOutlook([...pool.values(), ...mockItems], Object.assign({}, etfDay, mockEtf), now, watchSymbols());
    render(fresh.map(f => f.key));
    // On first load just show what's there; alert only on genuinely new arrivals.
    if (fresh.length && !(fromPoll && firstCycle)) alertNew(fresh);
    if (fromPoll) firstCycle = false;
  }

  function alertNew(fresh) {
    if (!document.hidden) return;
    const top = fresh[0];
    try {
      if ("Notification" in global && Notification.permission === "granted") {
        const n = new Notification(`${top.sentiment === "bull" ? "🟢▲" : top.sentiment === "bear" ? "🔴▼" : "⚪"} ${top.impact} · ${top.symbols[0] || "Market"}: ${top.headline}`,
          { body: `${top.source} · ${fresh.length} new flash item(s)`, tag: "bull-flash" });
        n.onclick = () => { global.focus(); n.close(); };
      }
    } catch {}
    if (!isMuted()) beep(top.impact === "HIGH");
  }

  function beep(high) {
    try {
      audioCtx = audioCtx || new (global.AudioContext || global.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = high ? 880 : 660;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.4);
    } catch {}
  }

  // ── Rendering ──────────────────────────────────────────────────────────
  const fmtTime = d => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fmtClock = d => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function render(newKeys) {
    if (!root) return;
    newKeys = new Set(newKeys || []);
    const hasKey = !!getKey();
    const muted = isMuted();
    const perm = ("Notification" in global) ? Notification.permission : "unsupported";

    let status;
    if (!hasKey && !mockItems.length) status = `<span class="fn-muted">Not connected</span>`;
    else if (state.error) status = `<span class="fn-err" title="${esc(state.error)}">⚠ ${esc(state.error.length > 40 ? state.error.slice(0, 40) + "…" : state.error)}</span>`;
    else status = state.updated ? `<span class="fn-muted">Last updated ${fmtClock(state.updated)}</span>` : `<span class="fn-muted">Loading…</span>`;

    let body;
    if (!hasKey && !mockItems.length) {
      body = `<div class="fn-setup">
        <div class="fn-muted">Add a free <a href="https://finnhub.io/register" target="_blank" rel="noopener">Finnhub API key</a> to turn on flash news. It's stored only in this browser.</div>
        <div class="fn-row"><input type="password" class="fn-input" placeholder="Finnhub API key" autocomplete="off" spellcheck="false">
        <button class="fn-btn fn-save">Save</button></div></div>`;
    } else if (!state.items.length) {
      body = `<div class="fn-empty">No major news in the last ${CONFIG.maxAgeMinutes} min.</div>`;
    } else {
      body = `<div class="fn-list">${state.items.map(it => `
        <div class="fn-item fn-${it.sentiment} ${newKeys.has(it.key) ? "fn-new" : ""}">
          <span class="fn-dir" title="${it.sentiment === "bull" ? "Bullish news" : it.sentiment === "bear" ? "Bearish news" : "Neutral / unclear"}">${it.sentiment === "bull" ? "🟢▲" : it.sentiment === "bear" ? "🔴▼" : "⚪"}</span>
          <span class="fn-time">${fmtTime(new Date(it.datetime))}</span>
          <span class="fn-badge fn-${it.impact === "HIGH" ? "high" : "med"}">${it.impact}</span>
          ${(it.symbols.length ? it.symbols : ["MKT"]).slice(0, 2).map(s => `<span class="fn-sym">${esc(s)}</span>`).join("")}
          <span class="fn-head">${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.headline)}</a>` : esc(it.headline)}
            <span class="fn-src">${esc(it.source)}${it.mock ? " · TEST" : ""}</span></span>
        </div>`).join("")}</div>`;
    }

    // Keep whatever is being typed in the search box across the 30-second re-renders.
    const q0 = root.querySelector(".fn-q");
    const typing = q0 ? { v: q0.value, focus: document.activeElement === q0, a: q0.selectionStart, b: q0.selectionEnd } : null;

    root.innerHTML = `<div class="fn-panel">
      <div class="fn-top">
        <span class="fn-title">⚡ Flash News${state.items.length ? ` <span class="fn-count">${state.items.length}</span>` : ""}</span>
        <span class="fn-status">${status}</span>
        <span class="fn-actions">
          ${perm === "default" ? `<button class="fn-icon fn-notify" title="Allow notifications when this tab is in the background">🔔</button>` : ""}
          <button class="fn-icon fn-mute" title="${muted ? "Unmute" : "Mute"} alert sound">${muted ? "🔇" : "🔊"}</button>
          ${hasKey ? `<button class="fn-icon fn-key" title="Change or remove the Finnhub key">⚙</button>` : ""}
        </span>
      </div>${renderSearch(hasKey)}${body}${renderSectors(hasKey)}${(state.items.length || (state.sectors || []).length) && (hasKey || mockItems.length) ? `<div class="fn-legend">🟢▲ bullish · 🔴▼ bearish · ⚪ mixed — quick read of the news, not buy/sell orders</div>` : ""}</div>`;

    const q1 = root.querySelector(".fn-q");
    if (q1 && typing) {
      q1.value = typing.v;
      if (typing.focus) { q1.focus(); try { q1.setSelectionRange(typing.a, typing.b); } catch {} }
    }

    if (newKeys.size) setTimeout(() => root && root.querySelectorAll(".fn-new").forEach(el => el.classList.remove("fn-new")), CONFIG.highlightSeconds * 1000);
  }

  // ── Search: ticker or company → "may go up / down" with reasons ───────
  function renderSearch(hasKey) {
    if (!(hasKey || mockItems.length)) return "";
    const s = state.search || {};
    let out = "";
    if (s.loading) out = `<div class="fn-muted fn-stk-note">Analyzing ${esc(s.query)}…</div>`;
    else if (s.error) out = `<div class="fn-err fn-stk-note">${esc(s.error)}</div>`;
    else if (s.result) {
      const r = s.result;
      const icon = r.direction === "up" ? "🟢▲" : r.direction === "down" ? "🔴▼" : "⚪";
      const verdict = r.direction === "up" ? "may go up" : r.direction === "down" ? "may go down" : "no clear direction";
      const link = (t, u) => u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t)}</a>` : esc(t);
      const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
      out = `<div class="fn-result fn-sec-${r.direction}">
        <div class="fn-res-head">${icon} <b>${esc(r.sym)}</b>${s.name && s.name.toUpperCase() !== r.sym ? ` <span class="fn-muted">${esc(s.name)}</span>` : ""}
          <span class="fn-res-verdict fn-${r.direction}-lbl">${verdict}</span>
          ${r.dayPct !== null ? `<span class="${r.dayPct >= 0 ? "fn-pos" : "fn-negt"}">${r.dayPct >= 0 ? "+" : ""}${r.dayPct.toFixed(2)}% today</span>` : ""}
          <span class="fn-muted">· confidence ${r.confidence}${r.sector ? ` · ${esc(r.sector)}` : ""}</span>
          <button class="fn-icon fn-res-close" title="Close">✕</button></div>
        ${r.reasons.length ? `<ul class="fn-res-why">${r.reasons.slice(0, 5).map(x =>
          `<li class="fn-why-${x.dir}"><b>${x.dir === "up" ? "▲" : "▼"}</b> ${link(x.text, x.url)}</li>`).join("")}</ul>`
          : `<div class="fn-muted fn-stk-note">No news about ${esc(r.sym)} in the last 3 days and no big price move — nothing to lean on.</div>`}
        ${r.headlines.length ? `<div class="fn-stk-label" style="margin-top:6px">Latest headlines</div>${r.headlines.map(h =>
          `<div class="fn-res-hl">${h.sentiment === "bull" ? "🟢" : h.sentiment === "bear" ? "🔴" : "⚪"} ${link(h.headline, h.url)} <span class="fn-muted">${esc(h.source || "")} · ${ago(h.datetime)}</span></div>`).join("")}` : ""}
        <div class="fn-muted fn-stk-note">A quick read of recent news and price, not a prediction or a buy/sell call.</div>
      </div>`;
    }
    return `<div class="fn-search">
      <input class="fn-q" type="search" placeholder="Search ticker or company — e.g. NVDA, SanDisk, Exxon" autocomplete="off" spellcheck="false" enterkeyhint="search">
      <button class="fn-btn fn-go">Analyze</button></div>${out}`;
  }

  // Ticker or company name → symbol. Known names first (no API call), then Finnhub symbol search.
  async function resolveSymbol(q) {
    const t = q.trim();
    const up = t.toUpperCase().replace(/^\$/, "");
    const known = new Set(Object.values(CONFIG.sectors).flatMap(s => s.symbols));
    if (known.has(up)) return { sym: up, name: (CONFIG.companyNames[up] || "").split("|")[0] };
    for (const [sym, n] of Object.entries(CONFIG.companyNames))
      if (n.split("|").some(x => x.toLowerCase() === t.toLowerCase() || (t.length >= 4 && x.toLowerCase().startsWith(t.toLowerCase())))) return { sym, name: n.split("|")[0] };
    if (!getKey()) {
      if (/^[A-Z]{1,5}$/.test(up)) return { sym: up, name: "" };
      throw new Error("Add your Finnhub key to search any company");
    }
    const res = await api("/search", { q: t });
    const list = (res && res.result) || [];
    const pick = list.find(x => x.symbol === up) || list.find(x => x.type === "Common Stock" && !/[.:]/.test(x.symbol)) || list[0];
    if (!pick) throw new Error(`No US stock found for “${t}”`);
    return { sym: pick.symbol, name: pick.description || "" };
  }

  async function doSearch(q) {
    q = String(q || "").trim();
    if (!q || (state.search && state.search.loading)) return;
    state.search = { query: q, loading: true };
    render();
    try {
      const { sym, name } = await resolveSymbol(q);
      state.search.query = sym;
      const now = Date.now();
      const ymd = d => d.toISOString().slice(0, 10);
      let own = [], dp = (stockDay[sym] !== undefined ? stockDay[sym] : mockDay[sym]);
      if (getKey()) {
        try {
          own = ((await api("/company-news", { symbol: sym, from: ymd(new Date(now - 3 * 86400000)), to: ymd(new Date(now)) })) || []).map(n => normalize(n, sym));
        } catch (e) { if (!pool.size) throw e; }
        try { const qd = await api("/quote", { symbol: sym }); if (qd && typeof qd.dp === "number" && qd.c > 0) { dp = qd.dp; stockDay[sym] = dp; stockDayAt[sym] = Date.now(); } } catch {}
      }
      const result = analyzeSymbol(sym, [...own, ...pool.values(), ...mockItems], dp, priceMoves(now)[sym] ?? mockMoves[sym], state.sectors, now);
      state.search = { query: sym, name, result };
    } catch (e) {
      state.search = { query: q, error: e.message || "Search failed" };
    }
    render();
  }

  // Sector Outlook strip: one line per sector, strongest lean first.
  function renderSectors(hasKey) {
    const rows = state.sectors || [];
    if (!(hasKey || mockItems.length) || !rows.length) return "";
    const icon = d => d === "up" ? "🟢▲" : d === "down" ? "🔴▼" : "⚪";
    return `<div class="fn-sectors">
      <div class="fn-sec-title">📊 Sector outlook <span class="fn-muted">· last ${Math.round(CONFIG.sectorWindowMinutes / 60)}h of news</span></div>
      ${rows.map(r => {
        const open = state.expanded === r.sector;
        return `<div class="fn-sec fn-sec-${r.direction} ${open ? "fn-open" : ""}" data-sector="${esc(r.sector)}" role="button" tabindex="0" aria-expanded="${open}">
        <span class="fn-dir">${icon(r.direction)}</span>
        <span class="fn-sec-text"><b>${esc(r.summary.split(" — ")[0])}</b> <span class="fn-muted">— ${esc(r.summary.split(" — ").slice(1).join(" — "))}</span>
        ${r.driver && r.direction !== "mixed" ? `<span class="fn-sec-why">Driver: ${r.driver.url ? `<a href="${esc(r.driver.url)}" target="_blank" rel="noopener noreferrer">${esc(r.driver.headline)}</a>` : esc(r.driver.headline)}</span>` : ""}</span>
        <span class="fn-chev">${open ? "▾" : "›"}</span>
      </div>${open ? renderStocks(r) : ""}`;
      }).join("")}
    </div>`;
  }

  // Expanded view for one sector: which of its stocks may go up / down, and why.
  function renderStocks(r) {
    const leans = stockLeans(r.sector, [...pool.values(), ...mockItems], Object.assign({}, stockDay, mockDay),
                             Object.assign(priceMoves(Date.now()), mockMoves), Date.now(), watchSymbols(), r);
    const pct = x => x === null ? "" : `<span class="${x >= 0 ? "fn-pos" : "fn-negt"}">${x >= 0 ? "+" : ""}${x.toFixed(1)}%</span>`;
    const link = (txt, url) => url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(txt)}</a>` : esc(txt);
    const clean = t => String(t || "").replace(/\s*\(TEST\)$/, "");

    // 1) Why the sector leans this way — plain English, strongest first.
    const verb = r.direction === "up" ? "may go up" : r.direction === "down" ? "may go down" : "is mixed";
    const whyList = (r.reasons || []).slice(0, 4).map(x => `<li class="fn-why-${x.dir}">
        <b>${x.dir === "up" ? "▲" : "▼"} ${esc(x.label)}</b> → ${esc(x.why)}
        ${x.headline ? `<span class="fn-why-src">${link("“" + clean(x.headline) + "”", x.url)}</span>` : ""}</li>`).join("");
    const whyHtml = whyList
      ? `<div class="fn-why"><div class="fn-stk-label">Why ${esc(r.sector)} ${verb}</div><ul>${whyList}</ul></div>`
      : `<div class="fn-muted fn-stk-note">No clear reason in the news yet.</div>`;

    // 2) Which stocks, each with its own one-line reason.
    const row = s => `<div class="fn-stk fn-stk-${s.score > 0 ? "up" : "down"}">
        <span class="fn-stk-head"><b>${esc(s.sym)}</b> ${pct(s.dayPct)}</span>
        <span class="fn-stk-why">${s.driver && s.driver.url && s.why.includes("news:") ? link(s.why, s.driver.url) : esc(s.why)}</span></div>`;
    const groups = r.direction === "down"
      ? [["down", "🔴▼ Stocks that may go down", leans.down], ["up", "🟢▲ Stocks that may go up", leans.up]]
      : [["up", "🟢▲ Stocks that may go up", leans.up], ["down", "🔴▼ Stocks that may go down", leans.down]];
    const loading = state.loadingSector === r.sector ? `<div class="fn-muted fn-stk-note">Getting today's prices…</div>` : "";
    const body = groups.filter(g => g[2].length).map(g =>
      `<div class="fn-stk-group"><div class="fn-stk-label fn-${g[0]}-lbl">${g[1]}</div><div class="fn-stk-list">${g[2].slice(0, 6).map(row).join("")}</div></div>`).join("");

    return `<div class="fn-stocks">${whyHtml}${loading}${body || `<div class="fn-muted fn-stk-note">No stock in ${esc(r.sector)} has a clear signal right now.</div>`}
      <div class="fn-muted fn-stk-note">Based on the last ${Math.round(CONFIG.sectorWindowMinutes / 60)}h of headlines + today's move. A quick read of the news, not a buy/sell call.</div></div>`;
  }

  // Tapping a sector: open it and fetch today's % move for its stocks (cached 2 min, staggered).
  async function loadSectorQuotes(sector) {
    const sec = CONFIG.sectors[sector];
    if (!sec || !getKey()) return;
    const stale = s => !stockDayAt[s] || Date.now() - stockDayAt[s] > CONFIG.stockQuoteCacheSeconds * 1000;
    const need = sec.symbols.filter(stale);
    if (!need.length) return;
    state.loadingSector = sector; render();
    for (const s of need) {
      if (state.expanded !== sector) break;          // user closed it — stop spending calls
      try { const q = await api("/quote", { symbol: s }); if (q && typeof q.dp === "number") { stockDay[s] = q.dp; stockDayAt[s] = Date.now(); } }
      catch (e) { if (/rate|key/i.test(e.message)) break; }
      await sleep(CONFIG.staggerMs);
    }
    if (state.loadingSector === sector) state.loadingSector = null;
    render();
  }

  function toggleSector(sector) {
    state.expanded = state.expanded === sector ? null : sector;
    render();
    if (state.expanded) loadSectorQuotes(state.expanded);
  }

  function onKey(e) {
    if (e.target.classList && e.target.classList.contains("fn-q") && e.key === "Enter") { e.preventDefault(); doSearch(e.target.value); return; }
    const row = e.target.closest && e.target.closest(".fn-sec");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleSector(row.dataset.sector); }
  }

  function onClick(e) {
    if (e.target.closest(".fn-go")) { doSearch((root.querySelector(".fn-q") || {}).value); return; }
    if (e.target.closest(".fn-res-close")) { state.search = null; render(); return; }
    const row = e.target.closest(".fn-sec");
    if (row && !e.target.closest("a")) { toggleSector(row.dataset.sector); return; }
    const t = e.target.closest("button");
    if (!t) return;
    if (t.classList.contains("fn-save")) {
      const v = (root.querySelector(".fn-input") || {}).value || "";
      if (v.trim()) { setKey(v.trim()); state.error = null; render(); safePoll(); }
    } else if (t.classList.contains("fn-mute")) {
      setMuted(!isMuted());
      if (!isMuted()) beep(false);          // also unlocks audio for later background alerts
      render();
    } else if (t.classList.contains("fn-notify")) {
      try { Notification.requestPermission().then(() => render()); } catch {}
    } else if (t.classList.contains("fn-key")) {
      const v = global.prompt("Finnhub API key (leave empty to remove):", "");
      if (v === null) return;
      setKey(v.trim()); state = { items: [], sectors: [], updated: null, error: null }; pool.clear(); render(); if (v.trim()) safePoll();
    }
  }

  // ── Styles (scoped with fn- prefix; uses the host page's CSS variables) ──
  function injectStyles() {
    if (document.getElementById("fn-styles")) return;
    const s = document.createElement("style");
    s.id = "fn-styles";
    s.textContent = `
.fn-panel{background:var(--card,rgba(255,255,255,.04));border:1px solid var(--line,rgba(255,255,255,.07));border-radius:14px;padding:8px 10px;margin:0 0 16px}
.fn-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fn-title{font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--gold,#eab308)}
.fn-count{background:var(--card-h,rgba(255,255,255,.07));color:var(--ink2,#94a3b8);font-size:10px;padding:1px 7px;border-radius:99px}
.fn-status{font-size:11px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fn-muted{color:var(--muted,#64748b)} .fn-err{color:var(--bear,#ef4444)}
.fn-actions{display:flex;gap:4px}
.fn-icon{background:none;border:1px solid var(--line,rgba(255,255,255,.07));border-radius:8px;color:var(--ink2,#94a3b8);font-size:13px;padding:2px 7px;cursor:pointer}
.fn-list{max-height:220px;overflow-y:auto;margin-top:6px}
.fn-item{display:flex;align-items:baseline;gap:6px;padding:6px 4px;border-top:1px solid var(--line,rgba(255,255,255,.07));font-size:13px;transition:background 1s}
.fn-item.fn-new{background:rgba(234,179,8,.18);animation:fnPulse 1s ease-in-out 5}
@keyframes fnPulse{50%{background:rgba(234,179,8,.32)}}
.fn-item.fn-bull{box-shadow:inset 3px 0 0 var(--bull,#22c55e)} .fn-item.fn-bull .fn-head{color:#bbf7d0}
.fn-item.fn-bear{box-shadow:inset 3px 0 0 var(--bear,#ef4444)} .fn-item.fn-bear .fn-head{color:#fecaca}
.fn-dir{font-size:11px;flex:none;letter-spacing:-2px}
.fn-legend{font-size:10px;color:var(--muted,#64748b);margin-top:4px}
.fn-sectors{margin-top:8px;padding-top:6px;border-top:1px dashed var(--line,rgba(255,255,255,.1))}
.fn-sec-title{font-size:11px;font-weight:800;letter-spacing:.04em;color:var(--ink2,#94a3b8);margin-bottom:2px}
.fn-sec{display:flex;gap:6px;align-items:baseline;font-size:12px;padding:3px 4px;border-radius:6px}
.fn-sec-up{background:rgba(34,197,94,.08)} .fn-sec-up b{color:var(--bull,#22c55e)}
.fn-sec-down{background:rgba(239,68,68,.08)} .fn-sec-down b{color:var(--bear,#ef4444)}
.fn-sec-mixed b{color:var(--ink2,#94a3b8)}
.fn-sec-text{min-width:0} .fn-sec-why{display:block;font-size:11px;color:var(--muted,#64748b)}
.fn-sec-why a{color:inherit}
.fn-sec{cursor:pointer} .fn-sec:hover{filter:brightness(1.25)} .fn-sec:focus-visible{outline:2px solid var(--accent,#8b5cf6)}
.fn-chev{margin-left:auto;color:var(--muted,#64748b);font-size:13px;flex:none;padding-left:6px}
.fn-stocks{margin:2px 0 6px 22px;padding:6px 8px;border-left:2px solid var(--line,rgba(255,255,255,.1))}
.fn-stk-group{margin-bottom:6px}
.fn-stk-label{font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;margin-bottom:3px}
.fn-up-lbl{color:var(--bull,#22c55e)} .fn-down-lbl{color:var(--bear,#ef4444)}
.fn-stk-list{display:flex;flex-direction:column;gap:4px}
.fn-stk-head{white-space:nowrap}
.fn-search{display:flex;gap:6px;margin-top:8px}
.fn-q{flex:1;min-width:0;background:var(--bg2,#111827);color:var(--ink,#f1f5f9);border:1px solid var(--line,rgba(255,255,255,.12));border-radius:8px;padding:6px 9px;font-size:13px}
.fn-result{margin-top:6px;padding:8px 10px;border-radius:10px;border:1px solid var(--line,rgba(255,255,255,.08))}
.fn-res-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:13px}
.fn-res-verdict{font-weight:800;text-transform:uppercase;font-size:12px;letter-spacing:.03em}
.fn-mixed-lbl{color:var(--ink2,#94a3b8)}
.fn-res-close{margin-left:auto}
.fn-res-why{margin:6px 0 0;padding-left:16px} .fn-res-why li{font-size:12px;margin:3px 0;color:var(--ink2,#94a3b8)} .fn-res-why a{color:inherit}
.fn-res-hl{font-size:12px;margin:3px 0;color:var(--ink2,#94a3b8)} .fn-res-hl a{color:inherit}
.fn-why{margin-bottom:8px} .fn-why ul{margin:2px 0 0;padding-left:16px} .fn-why li{font-size:12px;margin:3px 0;color:var(--ink2,#94a3b8)}
.fn-why-up b{color:var(--bull,#22c55e)} .fn-why-down b{color:var(--bear,#ef4444)}
.fn-why-src{display:block;font-size:11px;color:var(--muted,#64748b)} .fn-why-src a,.fn-stk-why a{color:inherit}
.fn-stk{display:flex;flex-direction:column;font-size:12px;padding:4px 8px;border-radius:8px;line-height:1.3;max-width:100%}
.fn-stk-up{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3)}
.fn-stk-down{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3)}
.fn-stk-why{font-size:11px;color:var(--ink2,#94a3b8)}
.fn-pos{color:var(--bull,#22c55e)} .fn-negt{color:var(--bear,#ef4444)}
.fn-stk-note{font-size:11px;margin-top:3px;color:var(--ink2,#94a3b8)} .fn-stk-note a{color:inherit}
.fn-time{color:var(--muted,#64748b);font-size:11px;font-variant-numeric:tabular-nums;flex:none}
.fn-badge{font-size:9px;font-weight:800;padding:1px 5px;border-radius:5px;flex:none}
.fn-high{background:var(--bear-bg,rgba(239,68,68,.12));color:var(--bear,#ef4444)}
.fn-med{background:rgba(234,179,8,.14);color:var(--gold,#eab308)}
.fn-sym{font-size:10px;font-weight:800;color:var(--accent,#8b5cf6);background:var(--accent-bg,rgba(139,92,246,.12));padding:1px 5px;border-radius:5px;flex:none}
.fn-head{min-width:0;color:var(--ink,#f1f5f9)} .fn-head a{color:inherit;text-decoration:none} .fn-head a:hover{text-decoration:underline}
.fn-src{color:var(--muted,#64748b);font-size:11px;margin-left:4px}
.fn-empty{color:var(--muted,#64748b);font-size:12px;padding:6px 2px 2px}
.fn-setup{font-size:12px;padding-top:6px} .fn-setup a{color:var(--cyan,#06b6d4)}
.fn-row{display:flex;gap:6px;margin-top:6px}
.fn-input{flex:1;min-width:0;background:var(--bg2,#111827);color:var(--ink,#f1f5f9);border:1px solid var(--line,rgba(255,255,255,.1));border-radius:8px;padding:6px 8px;font-size:13px}
.fn-btn{background:var(--accent,#8b5cf6);color:#fff;border:0;border-radius:8px;padding:6px 12px;font-weight:700;cursor:pointer}`;
    document.head.appendChild(s);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  let timer = null, polling = false;
  async function safePoll() {
    if (polling || !getKey()) return;
    polling = true;
    try { await pollOnce(); }
    catch (e) { state.error = e.message || "fetch failed"; render(); }
    finally { polling = false; }
  }

  function mount(container, opts) {
    try {
      if (!container) return;
      if (root) { root.removeEventListener("click", onClick); root.removeEventListener("keydown", onKey); }   // safe to mount twice
      root = container;
      getWatchlist = (opts && opts.getWatchlist) || getWatchlist;
      injectStyles();
      root.addEventListener("click", onClick);
      root.addEventListener("keydown", onKey);
      render();
      safePoll();
      clearInterval(timer);
      timer = setInterval(safePoll, CONFIG.pollSeconds * 1000);
      if (/[?&]flashtest=1\b/.test(global.location.search)) injectMock();
    } catch (e) { try { console.warn("FlashNews mount failed:", e); } catch {} }
  }

  // ── Test helper: one HIGH and one MEDIUM item, no API key needed ──────
  let mockMoves = {};
  function injectMock() {
    const sym = watchSymbols()[0] || "NVDA";
    const now = Date.now();
    mockMoves = { [sym]: 2.6 };   // pretend it jumped 2.6% in 5 min
    mockItems = [
      { headline: `${sym} beats earnings, raises full-year guidance (TEST)`,
        source: "Mock Wire", datetime: now - 60000, related: [sym], mock: true },          // 2+2+2+1 = 7 → HIGH
      { headline: "Fed warns of rate hike at next rate decision as CPI runs hot (TEST)",
        source: "Mock Wire", datetime: now - 120000, related: [], mock: true },             // 2+1 = 3 → MEDIUM, bearish
      // Sector-outlook test data: Tech leans down, Health & Biotech and Energy lean up, Financials mixed.
      { headline: "Microsoft downgraded on slowing cloud growth (TEST)", source: "Mock Wire", datetime: now - 30 * 60000, related: ["MSFT"], mock: true },
      { headline: "Chip stocks fall on new export curbs (TEST)", source: "Mock Wire", datetime: now - 50 * 60000, related: [], mock: true },
      { headline: "FDA approves Lilly obesity drug (TEST)", source: "Mock Wire", datetime: now - 20 * 60000, related: ["LLY"], mock: true },
      { headline: "Biotech stocks surge after strong trial results (TEST)", source: "Mock Wire", datetime: now - 70 * 60000, related: [], mock: true },
      { headline: "Oil jumps as OPEC extends output limits (TEST)", source: "Mock Wire", datetime: now - 40 * 60000, related: [], mock: true },
      { headline: "Exxon raises production target (TEST)", source: "Mock Wire", datetime: now - 90 * 60000, related: ["XOM"], mock: true },
    ];
    mockEtf = { XLK: -1.4, XLV: 1.1, XLE: 1.6, XLF: 0.2 };
    // Per-stock test data for the tap-to-expand view (today's % move).
    mockDay = { NVDA: 2.4, SNDK: 3.1, AAOI: 1.8, AMD: 2.2, MSFT: -1.6, INTC: -2.3, XOM: 1.2, OXY: 2.5, CVX: -0.4, LLY: 3.4, MRNA: 2.6, PFE: -2.1 };
    mockItems.push(
      { headline: "SanDisk shares surge on record flash memory demand (TEST)", source: "Mock Wire", datetime: now - 35 * 60000, related: ["SNDK"], mock: true },
      { headline: "Applied Optoelectronics wins hyperscaler order (TEST)", source: "Mock Wire", datetime: now - 55 * 60000, related: ["AAOI"], mock: true },
      { headline: "Intel falls after weak guidance (TEST)", source: "Mock Wire", datetime: now - 65 * 60000, related: ["INTC"], mock: true });
    recompute(false);
    return state.items;
  }

  global.FlashNews = { CONFIG, computeFlashItems, sectorOutlook, stockLeans, analyzeSymbol, scoreItem, sentimentOf, mount, injectMock, _priceMoves: priceMoves };
})(window);
