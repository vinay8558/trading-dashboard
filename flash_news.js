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
      "Tech":             { etf: "XLK", symbols: ["NVDA","MSFT","AAPL","GOOGL","AMZN","META","AVGO","AMD","TSM","ORCL","CRM","INTC","MU","QCOM","ARM","PLTR"],
                            words: ["chip","chips","chipmaker","semiconductor","software","cloud","tech","Nvidia","Apple","Microsoft","Google","Meta","AI","data center"] },
      "Energy":           { etf: "XLE", symbols: ["XOM","CVX","COP","OXY","SLB","EOG","VST","CEG","NEE","GEV"],
                            words: ["oil","crude","OPEC","natural gas","energy","gasoline","refinery","drilling","power grid","Brent","WTI"] },
      "Health & Biotech": { etf: "XLV", symbols: ["LLY","UNH","JNJ","MRK","ABBV","PFE","AMGN","MRNA","VRTX","REGN","GILD","ISRG"],
                            words: ["FDA","drug","drugmaker","biotech","pharma","trial","vaccine","Medicare","Medicaid","obesity","cancer","therapy"] },
      "Financials":       { etf: "XLF", symbols: ["JPM","BAC","GS","MS","WFC","C","SCHW","BLK","V","MA"],
                            words: ["bank","banks","lender","lenders","Treasury yields","credit","mortgage","Wall Street"] },
    },
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
  function sectorOutlook(news, etfMoves, now, watchlist) {
    now = now || Date.now();
    etfMoves = etfMoves || {};
    const watchSet = new Set(watchlist || []);
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
      const direction = net >= CONFIG.sectorLeanAt ? "up" : net <= -CONFIG.sectorLeanAt ? "down" : "mixed";
      const verb = direction === "up" ? "may go up" : direction === "down" ? "may go down" : "mixed / no clear lean";
      const parts = [];
      if (bull || bear) parts.push(`${bull} bullish vs ${bear} bearish`);
      else parts.push(count ? `${count} headline(s), none clearly good or bad` : "no recent headlines");
      if (etfMove !== null) parts.push(`${sec.etf} ${etfMove >= 0 ? "+" : ""}${etfMove.toFixed(1)}% today`);
      out.push({ sector: name, direction, net, bull, bear, count, etf: sec.etf, etfMove, driver: direction === "up" ? best.bull : direction === "down" ? best.bear : null,
                 summary: `${name} ${verb} — ${parts.join(" · ")}` });
    }
    // Strongest leans first.
    out.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    return out;
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
      try { const q = await api("/quote", { symbol: s }); recordPrice(s, q && q.c, Date.now()); }
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

    root.innerHTML = `<div class="fn-panel">
      <div class="fn-top">
        <span class="fn-title">⚡ Flash News${state.items.length ? ` <span class="fn-count">${state.items.length}</span>` : ""}</span>
        <span class="fn-status">${status}</span>
        <span class="fn-actions">
          ${perm === "default" ? `<button class="fn-icon fn-notify" title="Allow notifications when this tab is in the background">🔔</button>` : ""}
          <button class="fn-icon fn-mute" title="${muted ? "Unmute" : "Mute"} alert sound">${muted ? "🔇" : "🔊"}</button>
          ${hasKey ? `<button class="fn-icon fn-key" title="Change or remove the Finnhub key">⚙</button>` : ""}
        </span>
      </div>${body}${renderSectors(hasKey)}${(state.items.length || (state.sectors || []).length) && (hasKey || mockItems.length) ? `<div class="fn-legend">🟢▲ bullish · 🔴▼ bearish · ⚪ mixed — quick read of the news, not buy/sell orders</div>` : ""}</div>`;

    if (newKeys.size) setTimeout(() => root && root.querySelectorAll(".fn-new").forEach(el => el.classList.remove("fn-new")), CONFIG.highlightSeconds * 1000);
  }

  // Sector Outlook strip: one line per sector, strongest lean first.
  function renderSectors(hasKey) {
    const rows = state.sectors || [];
    if (!(hasKey || mockItems.length) || !rows.length) return "";
    const icon = d => d === "up" ? "🟢▲" : d === "down" ? "🔴▼" : "⚪";
    return `<div class="fn-sectors">
      <div class="fn-sec-title">📊 Sector outlook <span class="fn-muted">· last ${Math.round(CONFIG.sectorWindowMinutes / 60)}h of news</span></div>
      ${rows.map(r => `<div class="fn-sec fn-sec-${r.direction}">
        <span class="fn-dir">${icon(r.direction)}</span>
        <span class="fn-sec-text"><b>${esc(r.summary.split(" — ")[0])}</b> <span class="fn-muted">— ${esc(r.summary.split(" — ").slice(1).join(" — "))}</span>
        ${r.driver && r.direction !== "mixed" ? `<span class="fn-sec-why">Driver: ${r.driver.url ? `<a href="${esc(r.driver.url)}" target="_blank" rel="noopener noreferrer">${esc(r.driver.headline)}</a>` : esc(r.driver.headline)}</span>` : ""}</span>
      </div>`).join("")}
    </div>`;
  }

  function onClick(e) {
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
      if (root) root.removeEventListener("click", onClick);   // safe to mount twice
      root = container;
      getWatchlist = (opts && opts.getWatchlist) || getWatchlist;
      injectStyles();
      root.addEventListener("click", onClick);
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
      { headline: `${sym} beats earnings, raises full-year guidance (TEST)`, url: "https://example.com/flash-test-high",
        source: "Mock Wire", datetime: now - 60000, related: [sym], mock: true },          // 2+2+2+1 = 7 → HIGH
      { headline: "Fed warns of rate hike at next rate decision as CPI runs hot (TEST)", url: "https://example.com/flash-test-med",
        source: "Mock Wire", datetime: now - 120000, related: [], mock: true },             // 2+1 = 3 → MEDIUM, bearish
      // Sector-outlook test data: Tech leans down, Health & Biotech and Energy lean up, Financials mixed.
      { headline: "Microsoft downgraded on slowing cloud growth (TEST)", url: "https://example.com/t1", source: "Mock Wire", datetime: now - 30 * 60000, related: ["MSFT"], mock: true },
      { headline: "Chip stocks fall on new export curbs (TEST)", url: "https://example.com/t2", source: "Mock Wire", datetime: now - 50 * 60000, related: [], mock: true },
      { headline: "FDA approves Lilly obesity drug (TEST)", url: "https://example.com/h1", source: "Mock Wire", datetime: now - 20 * 60000, related: ["LLY"], mock: true },
      { headline: "Biotech stocks surge after strong trial results (TEST)", url: "https://example.com/h2", source: "Mock Wire", datetime: now - 70 * 60000, related: [], mock: true },
      { headline: "Oil jumps as OPEC extends output limits (TEST)", url: "https://example.com/e1", source: "Mock Wire", datetime: now - 40 * 60000, related: [], mock: true },
      { headline: "Exxon raises production target (TEST)", url: "https://example.com/e2", source: "Mock Wire", datetime: now - 90 * 60000, related: ["XOM"], mock: true },
    ];
    mockEtf = { XLK: -1.4, XLV: 1.1, XLE: 1.6, XLF: 0.2 };
    recompute(false);
    return state.items;
  }

  global.FlashNews = { CONFIG, computeFlashItems, sectorOutlook, scoreItem, sentimentOf, mount, injectMock, _priceMoves: priceMoves };
})(window);
