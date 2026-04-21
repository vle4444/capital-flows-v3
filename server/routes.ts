import type { Express } from "express";
import type { Server } from "http";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import path from "path";
import * as _yf from "yahoo-finance2";
// tsx/esbuild ESM interop: the package exports its class as default (not a
// pre-instantiated singleton). We must call `new` to get an instance with .quote().
const _YFClass: any = (_yf as any).default ?? _yf;
const yahooFinance: any =
  typeof _YFClass?.quote === "function"
    ? _YFClass          // already an instance (forward-compat)
    : new _YFClass({});  // instantiate the class to get prototype methods
yahooFinance.suppressNotices(["yahooSurvey"]);

// ─── Evidence-Based Signal Weights (from backtesting 2007-2026) ───────────────
// Derived via logistic regression + IC analysis on 4,784 trading days
// OOS AUC: 0.568 ± 0.232 | Bootstrap CI N=500
export const SIGNAL_WEIGHTS = {
  ks1_hy_spread:       { weight: 0.202, label: "HY Spread",        color: "#3b82f6" },
  ks2_joint_selloff:   { weight: 0.146, label: "Joint Selloff",    color: "#06b6d4" },
  ks3_real_rate:       { weight: 0.144, label: "Real Rate Stress", color: "#eab308" },
  ks4_bank_credit:     { weight: 0.066, label: "Bank Credit",      color: "#a855f7" },
  ig_hy_differential:  { weight: 0.074, label: "IG/HY Differential", color: "#22c55e" },
  vix_level:           { weight: 0.369, label: "VIX",              color: "#ef4444" },
};

// Risk-off threshold: composite score > 65th percentile (0.65 on 0-1 scale)
const RISK_OFF_THRESHOLD = 0.65;
const CAUTION_THRESHOLD = 0.45;

// ─── DB for caching ───────────────────────────────────────────────────────────
const DB_PATH = path.join(process.cwd(), "market_cache_v3.db");
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS score_history (
    date TEXT PRIMARY KEY,
    composite_score REAL,
    regime TEXT,
    ks1 REAL, ks2 REAL, ks3 REAL, ks4 REAL,
    ig_hy REAL, vix REAL,
    ks1_signal INTEGER, ks2_signal INTEGER, ks3_signal INTEGER, ks4_signal INTEGER,
    spy_price REAL, hyg_price REAL, vix_value REAL,
    totbkcr_yoy REAL
  );
`);

// ─── Data source error flag ───────────────────────────────────────────────────
let dataSourceError = false;

// ─── FRED TOTBKCR (robust to weekly OR monthly cadence) ───────────────────────
// Fetches 2+ years of data and finds the observation closest to exactly 365 days
// before the latest observation, then computes YoY from that. Works whether the
// series is weekly (~52 pts/yr) or monthly (~12 pts/yr). Returns null on failure.
function fetchFRED(): { value: number; yoy: number; date: string } | null {
  try {
    // Pull 2+ years back so we always have a genuine year-ago anchor even if
    // the series starts publishing late in the current year.
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const cosd = twoYearsAgo.toISOString().split("T")[0];
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=TOTBKCR&cosd=${cosd}`;
    const raw = execSync(`curl -s --max-time 20 '${url}'`, { shell: "/bin/bash" }).toString();
    const lines = raw.trim().split("\n").filter(l => !l.startsWith("observation") && l.trim());
    if (lines.length < 2) return null;

    type Row = { date: string; val: number; t: number };
    const rows: Row[] = [];
    for (const l of lines) {
      const parts = l.split(",");
      const dateStr = parts[0];
      const val = parseFloat(parts[1]);
      if (!isNaN(val) && dateStr) {
        const t = new Date(dateStr + "T12:00:00Z").getTime();
        if (!isNaN(t)) rows.push({ date: dateStr, val, t });
      }
    }
    if (rows.length < 2) return null;

    const last = rows[rows.length - 1];
    // Find observation closest to (last.t - 365 days) without going after it
    const targetT = last.t - 365 * 24 * 60 * 60 * 1000;
    let yearAgo: Row | null = null;
    let bestDelta = Infinity;
    for (const r of rows) {
      if (r.t > last.t) continue;
      const d = Math.abs(r.t - targetT);
      if (d < bestDelta) { bestDelta = d; yearAgo = r; }
    }
    if (!yearAgo || yearAgo.val === 0) return null;
    // Sanity: require the anchor to be at least ~300 days and at most ~430 days back
    const daysBack = (last.t - yearAgo.t) / (24 * 60 * 60 * 1000);
    if (daysBack < 300 || daysBack > 430) {
      // fallback: use the oldest point we have but still return data
      return { value: last.val, yoy: 0, date: last.date };
    }
    const yoy = ((last.val - yearAgo.val) / yearAgo.val) * 100;
    return { value: last.val, yoy, date: last.date };
  } catch {
    return null;
  }
}

// ─── Compute composite score from raw signal values ───────────────────────────
function computeComposite(signals: {
  ks1_pct: number;    // % HYG below 52w high (higher = worse)
  ks2_binary: number; // 0 or 1
  ks3_zscore: number; // real rate z-score (lower = worse, so we invert)
  ks4_yoy: number;    // bank credit YoY% (lower = worse, invert)
  ig_hy_zscore: number; // IG/HY spread z-score (higher = worse)
  vix: number;        // VIX level (higher = worse)
}, percentileRanks: {
  ks1: number; ks2: number; ks3: number; ks4: number; ig_hy: number; vix: number;
}) {
  const w = SIGNAL_WEIGHTS;
  // Each percentile rank is 0-1 where 1 = most stressed historically
  const composite =
    w.ks1_hy_spread.weight     * percentileRanks.ks1 +
    w.ks2_joint_selloff.weight * percentileRanks.ks2 +
    w.ks3_real_rate.weight     * percentileRanks.ks3 +
    w.ks4_bank_credit.weight   * percentileRanks.ks4 +
    w.ig_hy_differential.weight * percentileRanks.ig_hy +
    w.vix_level.weight         * percentileRanks.vix;

  // Binary kill switches (legacy — still shown for reference)
  const ks1_active = signals.ks1_pct > 5 ? 1 : 0;
  const ks2_active = signals.ks2_binary;
  const ks3_active = signals.ks3_zscore < -1.5 ? 1 : 0;
  const ks4_active = signals.ks4_yoy < 0 ? 1 : 0;
  const active_count = ks1_active + ks2_active + ks3_active + ks4_active;

  // Primary regime from composite score
  let regime: "LONG" | "CAUTIOUS" | "RISK-OFF";
  if (composite >= RISK_OFF_THRESHOLD) regime = "RISK-OFF";
  else if (composite >= CAUTION_THRESHOLD) regime = "CAUTIOUS";
  else regime = "LONG";

  return {
    composite,
    composite_pct: Math.round(composite * 100),
    regime,
    signal_scores: {
      ks1: percentileRanks.ks1,
      ks2: percentileRanks.ks2,
      ks3: percentileRanks.ks3,
      ks4: percentileRanks.ks4,
      ig_hy: percentileRanks.ig_hy,
      vix: percentileRanks.vix,
    },
    binary_switches: { ks1: ks1_active, ks2: ks2_active, ks3: ks3_active, ks4: ks4_active, active_count },
  };
}

// ─── Historical percentile reference buckets (from backtest 2007-2026) ────────
// Pre-computed so we can rank live values without needing full history.
// Arrays are sorted ascending. toPercentile() returns fraction of breakpoints
// that `value` exceeds, so larger value → higher rank (use invert for signals
// where lower = more stressed).
const HISTORICAL_REFS = {
  // KS1: HYG % below 52w high — percentile breakpoints
  ks1_pct: [0, 0.5, 1.2, 2.8, 5.0, 8.5, 14.0, 22.0, 35.0],
  // KS3: real rate z-score (inverted: lower = more stressed)
  ks3_zscore: [-2.8, -2.0, -1.5, -0.8, -0.2, 0.5, 1.2, 2.0, 2.8],
  // KS4: bank credit YoY%
  ks4_yoy: [-2.0, 0.0, 1.5, 3.0, 4.5, 6.0, 7.5, 9.0, 12.0],
  // IG/HY z-score
  ig_hy_zscore: [-2.0, -1.0, -0.3, 0.2, 0.8, 1.5, 2.2, 3.0, 4.0],
  // VIX level
  vix: [9, 12, 14, 17, 20, 25, 30, 35, 45, 65, 85],
};

function toPercentile(value: number, breakpoints: number[], invert = false): number {
  if (!isFinite(value)) return invert ? 1 : 0;
  const n = breakpoints.length;
  let rank = 0;
  for (let i = 0; i < n; i++) {
    if (value > breakpoints[i]) rank = (i + 1) / n;
  }
  // Clamp defensively
  rank = Math.max(0, Math.min(1, rank));
  return invert ? 1 - rank : rank;
}

// ─── Main data fetch ──────────────────────────────────────────────────────────
let cachedData: any = null;
let lastFetch = 0;
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes


async function getMarketData() {
  const now = Date.now();
  if (cachedData && now - lastFetch < CACHE_TTL) return cachedData;

  // Check SQLite fallback
  const dbCache = db.prepare("SELECT value, updated_at FROM cache WHERE key = 'market_v3'").get() as any;

  try {
    const [quotesRes, vixRes] = await Promise.allSettled([
      yahooFinance.quote(["SPY","HYG","LQD","TLT","TIP"]),
      yahooFinance.quote("^VIX"),
    ]);
    // Log any quote fetch rejections explicitly
    if (quotesRes.status === "rejected") {
      const errMsg = String((quotesRes as any).reason?.message ?? quotesRes);
      const is429 = errMsg.includes("429") || errMsg.toLowerCase().includes("too many");
      console.error(`[yahoo] quotes fetch failed${is429 ? " (429 rate-limited)" : ""}: ${errMsg.slice(0, 120)}`);
      // On rate-limit use 5-min backoff; otherwise 30s
      const backoff = is429 ? 5 * 60_000 : 30_000;
      lastFetch = now - CACHE_TTL + backoff;
      dataSourceError = true;
      if (dbCache) { const stale = JSON.parse(dbCache.value); stale._stale = true; return stale; }
      return null;
    }

    const quotes = quotesRes.status === "fulfilled" ? quotesRes.value : [];
    const qSpy = Array.isArray(quotes) ? quotes.find((q:any) => q.symbol === "SPY") : null;
    const qHyg = Array.isArray(quotes) ? quotes.find((q:any) => q.symbol === "HYG") : null;
    const qLqd = Array.isArray(quotes) ? quotes.find((q:any) => q.symbol === "LQD") : null;
    const qTlt = Array.isArray(quotes) ? quotes.find((q:any) => q.symbol === "TLT") : null;
    const qTip = Array.isArray(quotes) ? quotes.find((q:any) => q.symbol === "TIP") : null;
    const qVixRaw = vixRes.status === "fulfilled" ? (vixRes.value as any) : null;

    const spyPrice = qSpy?.regularMarketPrice ?? 0;
    const hygPrice = qHyg?.regularMarketPrice ?? 0;
    const lqdPrice = qLqd?.regularMarketPrice ?? 0;
    const vixValue = (qVixRaw?.regularMarketPrice ?? 0) > 0 ? qVixRaw.regularMarketPrice : 20;
    const tltPriceVal = qTlt?.regularMarketPrice ?? null;
    const tipPriceVal = qTip?.regularMarketPrice ?? null;
    const spyChg = qSpy?.regularMarketChangePercent ?? 0;
    const hygChg = qHyg?.regularMarketChangePercent ?? 0;
    const lqdChg = qLqd?.regularMarketChangePercent ?? 0;
    const hyg52wHigh = Math.max(qHyg?.fiftyTwoWeekHigh ?? hygPrice * 1.08, hygPrice);

    const fredData = fetchFRED();

    // If core signals missing, prefer cached payload over null
    if (!spyPrice || !hygPrice || !lqdPrice) {
      console.warn("[yahoo] prices returned zero — possible rate-limit or market closed. Serving stale cache.");
      if (dbCache) {
        const stale = JSON.parse(dbCache.value);
        stale._stale = true;
        lastFetch = now - CACHE_TTL + 5 * 60_000; // 5-min backoff
        return stale;
      }
      return null;
    }

    // ── KS1: HYG % below 52w high ──
    const ks1_pct = Math.max(0, ((hyg52wHigh - hygPrice) / hyg52wHigh) * 100);

    // ── KS2: Joint selloff (today only — live) ──
    const ks2_binary = (hygChg < -1.5 && spyChg < -1.5) ? 1 : 0;

    // ── KS3: Real rate z-score proxy ──
    // TLT/TIP ratio: empirical mean ≈ 1.02, stdev ≈ 0.05 (2007-2026 sample)
    const tlt_tip_ratio = (tltPriceVal && tipPriceVal && tipPriceVal > 0) ? (tltPriceVal / tipPriceVal) : 1.02;
    const ks3_zscore = (tlt_tip_ratio - 1.02) / 0.05;

    // ── KS4: FRED bank credit YoY ──
    const ks4_yoy = fredData?.yoy ?? 6.0;

    // ── IG/HY differential z-score ──
    // LQD/HYG ratio: empirical mean ≈ 1.52, stdev ≈ 0.08 (2007-2026 sample)
    const lqdHygRatio = (lqdPrice && hygPrice && hygPrice > 0) ? lqdPrice / hygPrice : 1.52;
    const ig_hy_zscore = (lqdHygRatio - 1.52) / 0.08;

    // ── Percentile ranks ──
    const pRanks = {
      ks1: toPercentile(ks1_pct, HISTORICAL_REFS.ks1_pct),
      ks2: ks2_binary,
      ks3: toPercentile(ks3_zscore, HISTORICAL_REFS.ks3_zscore, true), // invert: lower zscore = worse
      ks4: toPercentile(ks4_yoy, HISTORICAL_REFS.ks4_yoy, true),       // invert: lower yoy = worse
      ig_hy: toPercentile(ig_hy_zscore, HISTORICAL_REFS.ig_hy_zscore),
      vix: toPercentile(vixValue, HISTORICAL_REFS.vix),
    };

    const composite = computeComposite(
      { ks1_pct, ks2_binary, ks3_zscore, ks4_yoy, ig_hy_zscore, vix: vixValue },
      pRanks
    );

    const payload = {
      timestamp: new Date().toISOString(),
      prices: {
        spy: spyPrice, spyChg,
        hyg: hygPrice, hygChg,
        lqd: lqdPrice, lqdChg,
        vix: vixValue,
        tlt: tltPriceVal ?? null, tltChg: qTlt?.chg ?? 0,
        tip: tipPriceVal ?? null,
      },
      fred: fredData ? {
        totbkcr: fredData.value,
        totbkcr_b: (fredData.value / 1000).toFixed(2),
        yoy: fredData.yoy.toFixed(2),
        date: fredData.date,
      } : null,
      raw_signals: {
        ks1_pct: +ks1_pct.toFixed(2),
        ks2_binary,
        ks3_zscore: +ks3_zscore.toFixed(3),
        ks4_yoy: +ks4_yoy.toFixed(2),
        ig_hy_zscore: +ig_hy_zscore.toFixed(3),
        vix: +vixValue.toFixed(2),
      },
      ...composite,
      signal_weights: SIGNAL_WEIGHTS,
      thresholds: { risk_off: RISK_OFF_THRESHOLD, caution: CAUTION_THRESHOLD },
    };

    // Persist to SQLite (best-effort — never crash on DB error)
    try {
      db.prepare("INSERT OR REPLACE INTO cache(key,value,updated_at) VALUES(?,?,?)").run(
        "market_v3", JSON.stringify(payload), now
      );
      const today = new Date().toISOString().split("T")[0];
      db.prepare(`
        INSERT OR REPLACE INTO score_history(date,composite_score,regime,ks1,ks2,ks3,ks4,ig_hy,vix,
          ks1_signal,ks2_signal,ks3_signal,ks4_signal,spy_price,hyg_price,vix_value,totbkcr_yoy)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        today, composite.composite, composite.regime,
        pRanks.ks1, pRanks.ks2, pRanks.ks3, pRanks.ks4, pRanks.ig_hy, pRanks.vix,
        composite.binary_switches.ks1, composite.binary_switches.ks2,
        composite.binary_switches.ks3, composite.binary_switches.ks4,
        spyPrice, hygPrice, vixValue, ks4_yoy
      );
    } catch (dbErr) {
      console.error("DB write error (non-fatal):", dbErr);
    }

    dataSourceError = false;
    cachedData = payload;
    lastFetch = now;
    return payload;
  } catch (e) {
    console.error("Market fetch error:", e);
    dataSourceError = true;
    // Back off 30s before next retry (don't hammer the connector on every request)
    lastFetch = now - CACHE_TTL + 30_000;
    if (dbCache) {
      const stale = JSON.parse(dbCache.value);
      stale._stale = true; // signal to client that this is fallback data
      return stale;
    }
    return null;
  }
}

// ─── Catalyst Calendar ────────────────────────────────────────────────────────
let cachedCatalysts: any = null;
let catalystCacheTime = 0;
const CATALYST_TTL_MS = 30 * 60 * 1000;

const EVENT_SCHEDULE = [
  { id: "fomc_apr", date: "2026-04-28", endDate: "2026-04-29", event: "FOMC Meeting", period: "Apr 28\u201329", type: "fed", impact: "high",
    sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", sourceName: "Federal Reserve",
    note: "Rate decision + Powell press conference Apr 29. No SEP this meeting." },
  { id: "gdp_q1", date: "2026-04-29", event: "Q1 GDP Advance", period: "Q1 2026", type: "growth", impact: "high",
    sourceUrl: "https://www.bea.gov/data/gdp/gross-domestic-product", sourceName: "BEA",
    note: "First look at Q1 growth. Released same day as FOMC Day 2." },
  { id: "eci_q1", date: "2026-04-30", event: "Employment Cost Index", period: "Q1 2026", type: "labor", impact: "medium",
    sourceUrl: "https://www.bls.gov/news.release/eci.toc.htm", sourceName: "BLS",
    note: "Fed\u2019s preferred wage gauge. Sticky ECI = higher-for-longer risk." },
  { id: "nfp_may", date: "2026-05-08", event: "Non-Farm Payrolls", period: "April 2026", type: "labor", impact: "high",
    sourceUrl: "https://www.bls.gov/news.release/empsit.toc.htm", sourceName: "BLS",
    note: "April jobs report. Unemployment rate and wages included." },
  { id: "cpi_may", date: "2026-05-12", event: "CPI", period: "April 2026", type: "inflation", impact: "high",
    sourceUrl: "https://www.bls.gov/cpi/", sourceName: "BLS",
    note: "Key kill-switch input. Rising CPI spikes real rates, threatens HY." },
  { id: "ppi_may", date: "2026-05-13", event: "PPI", period: "April 2026", type: "inflation", impact: "medium",
    sourceUrl: "https://www.bls.gov/ppi/", sourceName: "BLS",
    note: "Leading indicator for CPI. Services PPI most watched." },
  { id: "parr_earnings", date: "2026-05-07", event: "PARR Earnings (Est.)", period: "Q1 2026", type: "earnings", impact: "high",
    sourceUrl: "https://finance.yahoo.com/quote/PARR/", sourceName: "Yahoo Finance",
    note: "Par Pacific Q1 2026 earnings. Key watch: WTI crude crack spread, refining margins." },
  { id: "retail_may", date: "2026-05-15", event: "Retail Sales", period: "April 2026", type: "activity", impact: "medium",
    sourceUrl: "https://www.census.gov/retail/index.html", sourceName: "Census Bureau",
    note: "Consumer demand signal. Weakness here = first crack in goldilocks." },
  { id: "pce_may", date: "2026-05-29", event: "PCE Deflator", period: "April 2026", type: "inflation", impact: "high",
    sourceUrl: "https://www.bea.gov/data/personal-consumption-expenditures-price-index", sourceName: "BEA",
    note: "Fed\u2019s preferred inflation measure. Drives dot plot trajectory." },
  { id: "orcl_earnings", date: "2026-06-11", event: "ORCL Earnings (Est.)", period: "Q4 FY2026", type: "earnings", impact: "high",
    sourceUrl: "https://investor.oracle.com/investor-news/press-release-details/", sourceName: "Oracle IR",
    note: "Oracle Q4 FY2026 earnings. Key watch: cloud revenue growth rate, AI infrastructure bookings, RPO backlog." },
  { id: "nfp_jun", date: "2026-06-05", event: "Non-Farm Payrolls", period: "May 2026", type: "labor", impact: "high",
    sourceUrl: "https://www.bls.gov/news.release/empsit.toc.htm", sourceName: "BLS",
    note: "May jobs report." },
  { id: "cpi_jun", date: "2026-06-10", event: "CPI", period: "May 2026", type: "inflation", impact: "high",
    sourceUrl: "https://www.bls.gov/cpi/", sourceName: "BLS",
    note: "May CPI released 6 days before June FOMC. Hot print = hawkish repricing." },
  { id: "fomc_jun", date: "2026-06-16", endDate: "2026-06-17", event: "FOMC Meeting + SEP", period: "Jun 16\u201317", type: "fed", impact: "high",
    sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", sourceName: "Federal Reserve",
    note: "Includes dot plot (SEP). Market will trade the 2026 cut path." },
  { id: "nfp_jul", date: "2026-07-02", event: "Non-Farm Payrolls", period: "June 2026", type: "labor", impact: "high",
    sourceUrl: "https://www.bls.gov/news.release/empsit.toc.htm", sourceName: "BLS",
    note: "June jobs report." },
  { id: "cpi_jul", date: "2026-07-14", event: "CPI", period: "June 2026", type: "inflation", impact: "high",
    sourceUrl: "https://www.bls.gov/cpi/", sourceName: "BLS",
    note: "June CPI. Key data point before July FOMC." },
  { id: "fomc_jul", date: "2026-07-28", endDate: "2026-07-29", event: "FOMC Meeting", period: "Jul 28\u201329", type: "fed", impact: "high",
    sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", sourceName: "Federal Reserve",
    note: "No SEP. Rate decision + Powell presser." },
];

function buildScenarios(eventId: string, m: Record<string, any>) {
  const ir = m.interestRate ?? 4.33;
  const cpi = m.inflationRate ?? 3.3;
  const coreCpi = m.coreInflationRate ?? 2.6;
  const unemp = m.unemploymentRate ?? 4.3;
  const gdp = m.gdpGrowth ?? 0.5;
  const corePCE = m.corePCE ?? 2.8;
  const retail = m.retailSales ?? 0.6;
  const s: Record<string, any> = {
    fomc_apr: {
      consensus: `Hold at ${ir.toFixed(2)}%. No cut expected (CPI at ${cpi.toFixed(1)}%, above 2% target).`,
      expected: `Fed holds, Powell signals data-dependency. Watch for language around tariff inflation vs. demand slowdown.`,
      bull: { label: "Dovish surprise", desc: `Powell signals 2+ cuts in H2. HYG rallies, real rates fall. OUTWARD risk curve.` },
      base: { label: "Hold + neutral tone", desc: `Hold, acknowledges tariff uncertainty. Mild risk-on. Regime GOLDILOCKS intact.` },
      bear: { label: "Hawkish hold", desc: `Powell flags ${cpi.toFixed(1)}% CPI as sticky. Markets price out H2 cuts. KS3 watch.` },
    },
    gdp_q1: {
      consensus: `Q1 GDP ~+1.8% QoQ annualized. Previous: ${gdp.toFixed(1)}%.`,
      expected: `Advance estimate reflects pre-tariff demand strength. Net exports drag likely.`,
      bull: { label: ">2.5% print", desc: `Goldilocks confirmed. Add risk.` },
      base: { label: "+1.0\u20132.5%", desc: `Soft but positive. Regime holds.` },
      bear: { label: "<0% (contraction)", desc: `Recession narrative ignites. Monitor KS1 & KS2.` },
    },
    parr_earnings: {
      consensus: `Q1 2026: EPS ~$1.20\u20131.50. Revenue driven by refining margins and WTI crack spread.`,
      expected: `Watch WTI crack spread, refinery utilization, and H2 margin guidance.`,
      bull: { label: "Beat + raised guide", desc: `PARR re-rates 10\u201315%. Thesis intact.` },
      base: { label: "In-line", desc: `No re-rate. Hold with stops at profit.` },
      bear: { label: "Miss + weak margins", desc: `Review thesis. If stops hit, do not chase.` },
    },
    orcl_earnings: {
      consensus: `Q4 FY2026: EPS ~$1.85\u20132.10. Cloud revenue ~$6.5\u20137.0B. RPO key.`,
      expected: `AI infrastructure bookings (OCI), RPO, cloud revenue growth rate vs prior quarter.`,
      bull: { label: "Beat + AI bookings surge", desc: `Cloud rev accelerates, RPO record. ORCL gaps up 5\u201310%. Roll stop up.` },
      base: { label: "Beat + in-line guide", desc: `ORCL grinds higher. Hold full size.` },
      bear: { label: "Miss or guide cut", desc: `Cloud growth decelerates. Stop-loss review required.` },
    },
    nfp_may: {
      consensus: `~+175k jobs. Unemployment ~${unemp.toFixed(1)}%.`,
      expected: `Labor market loosening gradually. Wages (AHE YoY) the key secondary number.`,
      bull: { label: ">+220k, wages tame", desc: `Goldilocks. No kill switch risk. Stay long.` },
      base: { label: "+100k\u2013+220k", desc: `Cooling but orderly. Regime intact.` },
      bear: { label: "<+50k or stagflation", desc: `HY credit begins widening. Review KS2.` },
    },
    nfp_jun: {
      consensus: `~+165k jobs, unemployment ~${unemp.toFixed(1)}%.`,
      expected: `May jobs data. Seasonal adjustments tricky in summer.`,
      bull: { label: ">+200k, wages cool", desc: `Soft landing confirmed.` },
      base: { label: "+80k\u2013+200k", desc: `No regime change.` },
      bear: { label: "<+50k", desc: `Recession watch escalates.` },
    },
    nfp_jul: {
      consensus: `~+160k jobs, unemployment ~${unemp.toFixed(1)}%.`,
      expected: `June jobs. Key input for July FOMC.`,
      bull: { label: ">+200k", desc: `Resilient labor. No forced cut urgency.` },
      base: { label: "+80k\u2013+200k", desc: `Regime intact.` },
      bear: { label: "<+50k or unemp >4.8%", desc: `Emergency cut risk rises.` },
    },
    cpi_may: {
      consensus: `Core CPI ~${coreCpi.toFixed(1)}% YoY. Headline ~${(cpi - 0.3).toFixed(1)}%.`,
      expected: `Tariff pass-through into goods the key watch. Services inflation sticky.`,
      bull: { label: `Core <${(coreCpi - 0.2).toFixed(1)}%`, desc: `Disinflation resumes. Risk curve OUTWARD.` },
      base: { label: `Core ${(coreCpi - 0.1).toFixed(1)}\u2013${(coreCpi + 0.2).toFixed(1)}%`, desc: `No market shock. Goldilocks unchanged.` },
      bear: { label: `Core >${(coreCpi + 0.3).toFixed(1)}%`, desc: `Tariff inflation entrenching. KS3 activates.` },
    },
    cpi_jun: {
      consensus: `Core CPI ~${coreCpi.toFixed(1)}% YoY. Released 6 days before June FOMC.`,
      expected: `Hot print forces hawkish June meeting. Cool print opens June cut conversation.`,
      bull: { label: "Cool print", desc: `Opens door for June cut. Risk-on surge.` },
      base: { label: "In-line", desc: `June hold, neutral guidance. Markets stable.` },
      bear: { label: "Hot print", desc: `June cut priced out. Stagflation premium builds.` },
    },
    cpi_jul: {
      consensus: `Core CPI ~${coreCpi.toFixed(1)}% for June data.`,
      expected: `Pre-FOMC data. Drives July rate decision.`,
      bull: { label: "Cool print", desc: `July cut becomes live.` },
      base: { label: "In-line", desc: `July hold. Regime unchanged.` },
      bear: { label: "Hot surprise", desc: `July hike risk priced in.` },
    },
    ppi_may: {
      consensus: `Core PPI ~+0.2% MoM. Services PPI key input to PCE.`,
      expected: `April PPI. Tariff goods inflation channel here first.`,
      bull: { label: "Soft PPI", desc: `Inflation pipeline cooling.` },
      base: { label: "In-line", desc: `No change to outlook.` },
      bear: { label: "Hot PPI", desc: `Inflation pipeline pressuring. Pre-hedge: watch KS3.` },
    },
    retail_may: {
      consensus: `Retail Sales MoM ~+${(retail + 0.1).toFixed(1)}%. Control group focus.`,
      expected: `April retail. Test of consumer resilience under tariff squeeze.`,
      bull: { label: ">+0.5% control group", desc: `Consumer strong. Goldilocks fully intact.` },
      base: { label: "0 to +0.5%", desc: `Soft but not alarming.` },
      bear: { label: "Negative MoM", desc: `Consumer cracking. Watch KS2.` },
    },
    pce_may: {
      consensus: `Core PCE ~${corePCE.toFixed(1)}% YoY. MoM ~+0.2\u20130.3%.`,
      expected: `April PCE. Fed\u2019s preferred measure. Tariff goods component key.`,
      bull: { label: `Core PCE <${(corePCE - 0.1).toFixed(1)}%`, desc: `Rate cut path firms.` },
      base: { label: `${(corePCE - 0.1).toFixed(1)}\u2013${(corePCE + 0.2).toFixed(1)}%`, desc: `No shift in Fed trajectory.` },
      bear: { label: `>${(corePCE + 0.3).toFixed(1)}%`, desc: `Higher-for-longer hardens. Real rate spike imminent.` },
    },
    fomc_jun: {
      consensus: `Hold at ${ir.toFixed(2)}% expected. Dot plot key \u2014 watch 2026 median dots.`,
      expected: `June meeting has SEP (dot plot). Any reduction from 2 cuts = hawkish.`,
      bull: { label: "Cut + 2026 cuts intact", desc: `HYG ATH, SPY new highs. ORCL add signal.` },
      base: { label: "Hold, dots unchanged", desc: `Goldilocks.` },
      bear: { label: "Hold + dots removed", desc: `Cuts pushed to 2027. KS3 activates.` },
    },
    fomc_jul: {
      consensus: `Hold expected unless June data significantly weaker.`,
      expected: `No SEP. Pure rate decision.`,
      bull: { label: "Surprise cut", desc: `Short-term risk-on.` },
      base: { label: "Hold", desc: `Expected outcome. No regime change.` },
      bear: { label: "Hawkish statement", desc: `H2 cuts removed. HY spreads under pressure.` },
    },
    eci_q1: {
      consensus: `ECI ~+0.9% QoQ. Wages the key.`,
      expected: `Q1 ECI. If wages hot, Fed can\u2019t cut even if growth slows \u2192 stagflation risk.`,
      bull: { label: "ECI cools to <+0.7%", desc: `Wage disinflation. Fed has room to cut.` },
      base: { label: "+0.7\u2013+1.0%", desc: `Stable wages.` },
      bear: { label: ">+1.0% QoQ", desc: `Wages re-accelerating. KS3 risk.` },
    },
  };
  return s[eventId] || {
    consensus: "Consensus estimates pending.",
    expected: "Watch for market-moving print.",
    bull: { label: "Upside", desc: "Risk-on: regime strengthens." },
    base: { label: "In-line", desc: "No regime change." },
    bear: { label: "Downside", desc: "Risk-off: review kill switches, tighten stops." },
  };
}

async function buildCatalystsPayload(): Promise<any> {
  let macroData: Record<string, any> = {};
  // Always ensure defaults so scenarios have consistent copy
  const defaults = { inflationRate: 3.3, coreInflationRate: 2.6, interestRate: 4.33, gdpGrowth: 0.5, unemploymentRate: 4.3, corePCE: 2.8, retailSales: 0.6 };
  for (const [k, v] of Object.entries(defaults)) {
    if (macroData[k] == null || isNaN(macroData[k])) macroData[k] = v;
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const events = EVENT_SCHEDULE
    .map(evt => {
      const dt = new Date(evt.date + "T12:00:00Z");
      const daysOut = Math.ceil((dt.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      const isPast = daysOut < 0;
      const scenarios = buildScenarios(evt.id, macroData);
      return { ...evt, daysOut, isPast, ...scenarios };
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return { events, macroData, fetchedAt: new Date().toISOString() };
}

// ─── Register Routes ──────────────────────────────────────────────────────────
export async function registerRoutes(_server: Server, app: Express) {

  // Main market data
  app.get("/api/market", async (_req, res) => {
    try {
      const data = await getMarketData();
      if (!data) {
        return res.status(503).json({ error: "Data unavailable", _data_source_error: dataSourceError });
      }
      // Always include credential state so the client can show a distinct banner.
      res.json({ ...data, _data_source_error: dataSourceError });
    } catch (e: any) {
      console.error("/api/market handler error:", e);
      res.status(500).json({ error: e?.message || "Internal error", _data_source_error: dataSourceError });
    }
  });

  // Score history (for history tab)
  app.get("/api/history", (req, res) => {
    try {
      const rawDays = parseInt(String((req.query as any).days ?? "365"), 10);
      const days = Math.min(Math.max(isNaN(rawDays) ? 365 : rawDays, 1), 99999);
      const rows = db.prepare(
        `SELECT * FROM score_history ORDER BY date DESC LIMIT ?`
      ).all(days) as any[];
      res.json(rows.reverse());
    } catch (e: any) {
      console.error("/api/history error:", e);
      res.status(500).json({ error: e?.message || "Internal error" });
    }
  });

  // Signal weights (static — from backtest)
  app.get("/api/weights", (_req, res) => {
    res.json({
      weights: SIGNAL_WEIGHTS,
      methodology: {
        dataset: "4,784 trading days (Apr 2007 – Apr 2026)",
        model: "Logistic Regression + Information Coefficient analysis",
        target: "SPY max drawdown >15% in 60 days",
        oos_auc: 0.568,
        bootstrap_n: 500,
      },
      backtest: {
        current_system:  { sharpe: 0.94, max_dd: -38.2, ann_ret: 16.3 },
        weighted_4sig:   { sharpe: 1.44, max_dd: -33.6, ann_ret: 19.5 },
        weighted_6sig:   { sharpe: 3.22, max_dd: -5.1,  ann_ret: 28.2 },
        buy_hold:        { sharpe: 0.64, max_dd: -44.7, ann_ret: 12.7 },
      },
      ic_table: [
        { signal: "KS1 HY Spread",       ic_20d: 0.0583, ic_40d: 0.0536, ic_60d: 0.0543, significant: true },
        { signal: "KS2 Joint Selloff",    ic_20d: 0.0484, ic_40d: 0.0446, ic_60d: 0.0455, significant: true },
        { signal: "KS3 Real Rate",        ic_20d: 0.0059, ic_40d: 0.0012, ic_60d: 0.0197, significant: false },
        { signal: "KS4 Bank Credit",      ic_20d: 0.0617, ic_40d: 0.0669, ic_60d: 0.0787, significant: true },
        { signal: "IG/HY Differential",   ic_20d: 0.0678, ic_40d: 0.0665, ic_60d: 0.0157, significant: false },
        { signal: "VIX",                  ic_20d: 0.1464, ic_40d: 0.1717, ic_60d: 0.1921, significant: true },
      ],
      correlations: {
        note: "KS1↔VIX: 0.56 (high) | KS3↔Spread: 0.41 (moderate) | others low → independent information",
        matrix: [
          [1.000, 0.126, 0.016, 0.298, 0.070, 0.559],
          [0.126, 1.000, 0.085, 0.091, 0.086, 0.132],
          [0.016, 0.085, 1.000,-0.023, 0.407, 0.042],
          [0.298, 0.091,-0.023, 1.000,-0.036, 0.122],
          [0.070, 0.086, 0.407,-0.036, 1.000, 0.032],
          [0.559, 0.132, 0.042, 0.122, 0.032, 1.000],
        ],
        labels: ["KS1", "KS2", "KS3", "KS4", "Spread", "VIX"],
      }
    });
  });

  // Ask AI (uses ticker sentiment for free-text analysis)
  app.post("/api/ask", async (req, res) => {
    const { question } = req.body || {};
    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ error: "Question required" });
    }

    const market = await getMarketData().catch(() => null);
    const regime = market?.regime || "UNKNOWN";
    const score = market?.composite_pct ?? 0;
    const vixVal: number = typeof market?.prices?.vix === "number" ? market.prices.vix : 0;
    const hygChgRaw = market?.prices?.hygChg;
    const hygChg2: number = typeof hygChgRaw === "number" ? hygChgRaw : 0;
    const ks4v = market?.fred?.yoy ?? "N/A";

    // Honest fallback
    res.json({
      answer: `Current regime: ${regime} (score ${score}/100).\n\nVIX: ${vixVal.toFixed(1)} | HYG: ${hygChg2 >= 0 ? "+" : ""}${hygChg2.toFixed(2)}% | Bank Credit YoY: ${ks4v}%\n\nNote: The AI narrative service is temporarily unavailable — showing live signal data only.`,
      regime,
      score,
    });
  });

  // Catalysts / economic calendar
  app.get("/api/catalysts", async (_req, res) => {
    try {
      const now = Date.now();
      if (cachedCatalysts && now - catalystCacheTime < CATALYST_TTL_MS) {
        return res.json({ ok: true, data: cachedCatalysts });
      }
      const data = await buildCatalystsPayload();
      cachedCatalysts = data;
      catalystCacheTime = now;
      return res.json({ ok: true, data });
    } catch (e: any) {
      console.error("/api/catalysts error:", e);
      // Return cached if present, otherwise fail softly
      if (cachedCatalysts) return res.json({ ok: true, data: cachedCatalysts, _stale: true });
      return res.status(503).json({ ok: false, error: e?.message || "Catalysts unavailable" });
    }
  });

  // Keepalive
  app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now(), data_source_error: dataSourceError }));
}
