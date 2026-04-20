# HANDOFF.md — Capital Flows V3 Architecture

This document is written for a developer or AI agent picking up the project cold. It covers every layer of the stack, all data flows, and exactly what to change to run outside Perplexity Computer.

---

## Project Purpose

Tracks macro market regime in real time using six quantitative signals. Produces a weighted composite score (0–1) that drives a dashboard showing regime state (LONG / CAUTION / RISK-OFF), historical regime timeline, backtest performance, and signal explanations.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                      Browser (React)                      │
│  Dashboard.tsx — 7 tabs, Recharts, react-query polling   │
└──────────────────────────┬───────────────────────────────┘
                           │  HTTP (same origin, proxy)
┌──────────────────────────▼───────────────────────────────┐
│              Express Server (Node.js)                     │
│  server/routes.ts — all API routes + signal logic        │
│  In-process SQLite cache (better-sqlite3)                │
└────────────┬─────────────┬────────────────────────────────┘
             │             │
    ┌────────▼──────┐  ┌───▼──────────────────────┐
    │ Finance       │  │ FRED (curl)               │
    │ Connector     │  │ curl fred.stlouisfed.org  │
    │ (Perplexity   │  │ → TOTBKCR monthly data    │
    │  internal)    │  └───────────────────────────┘
    └───────────────┘
    SPY, HYG, LQD, TLT, VIX
```

---

## Data Flow — Live Market Fetch

1. Client polls `GET /api/market` every 60 seconds (react-query `refetchInterval`)
2. Server checks in-memory cache TTL (5 minutes)
3. If cache is stale, calls `fetchMarketData()`:
   a. Calls `callFinance("get_stock_info", { symbols: [...] })` — internal Perplexity connector
   b. Calls `fetchFRED()` — `execSync curl` against FRED API (Node https blocked by FRED)
   c. Computes all 6 signal scores via `computeSignals(quotes, fredYoY)`
   d. Computes weighted composite score
   e. Writes result to SQLite `score_history` table (INSERT OR REPLACE by date)
   f. Stores serialized result in `cache` KV table
4. Response always includes `_stale: bool` and `_credentials_expired: bool`
5. Client shows credential-expiry banner if `_credentials_expired === true`

### Cache / Stale Handling

- `CACHE_TTL = 5 * 60 * 1000` (5 min) — in `server/routes.ts` top-of-file constant
- On connector 401 error: `lastFetch = now - CACHE_TTL + 30_000` (30s backoff before retry)
- `credentialsExpired` module-level flag — set on 401, cleared on success
- Client retry policy: 5 retries, exponential backoff (15s → 5min cap), `refetchOnWindowFocus: true`, `refetchIntervalInBackground: true`
- Stale banner: shown when `data.age > 10 min` AND `!_credentials_expired`
- Credentials banner: shown when `_credentials_expired === true` (takes priority)

**Location:** `server/routes.ts` lines 1–100 (constants, DB init, connector setup)

---

## API Routes

All routes are registered in `server/routes.ts` → `registerRoutes(app, server)` function.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/market` | Live composite score, prices, all signal values, FRED reading. Cached 5 min. |
| `GET` | `/api/history?days=N` | Historical `score_history` rows. `days` range: 30–9999 (use 9999 for "All"). Returns array sorted ascending by date. |
| `GET` | `/api/weights` | Static: returns `SIGNAL_WEIGHTS` object + `RISK_OFF_THRESHOLD` + `CAUTION_THRESHOLD` |
| `POST` | `/api/ask` | Ask AI — body `{ question: string, context: object }`. Proxies to internal LLM. |
| `GET` | `/api/catalysts` | Economic calendar events with bull/base/bear scenarios. Built from static `EVENT_SCHEDULE` array in routes.ts. |
| `GET` | `/api/ping` | Health check. Returns `{ ok: true, ts: number, credentials_expired: bool }` |

---

## Regime Logic

**Location:** `server/routes.ts` — `computeSignals()` function and `SIGNAL_WEIGHTS` constant.

### Signal computation (all return 0–1 stress score):

| Signal key | Computation | Direction |
|---|---|---|
| `vix_level` | Percentile rank of VIX over rolling 252-day window | Higher VIX = higher stress |
| `ks1_hy_spread` | HYG % below 52-week high | Higher % below high = more stress |
| `ks2_joint_selloff` | 1 if SPY AND HYG both < -1.5% on same day, else 0; rolling 5-day max | Binary event |
| `ks3_real_rate` | z-score of TLT/TLT-252d-mean ratio; normalized to 0–1 | Higher z-score = more stress |
| `ig_hy_differential` | z-score of (LQD_ret - HYG_ret) spread; normalized to 0–1 | Wider IG/HY gap = stress |
| `ks4_bank_credit` | FRED TOTBKCR YoY growth; mapped 0–1 (0% growth = 0.5, negative = > 0.5) | Contraction = stress |

### Composite score:
```
composite = Σ (signal_i × weight_i)
Regime: composite ≥ 0.65 → RISK-OFF | ≥ 0.45 → CAUTION | < 0.45 → LONG
```

### `toPercentile(value, breakpoints)` helper:
Maps a raw value to 0–1 using predefined breakpoint arrays. Handles NaN/Infinity edge cases. Located in `server/routes.ts`.

---

## Connector / Data Fetching Logic

**Location:** `server/routes.ts` — top section before `registerRoutes()`

### `readEndpointConfig()`
Reads `/tmp/.tools_service_endpoint` (JSON file injected by Perplexity runtime):
```json
{ "endpoint": "https://...", "key": "...", "agent_id": "..." }
```

### `callFinance(toolName, args)`
POSTs to `{endpoint}/rest/connector-service/connectors/finance/tools/{toolName}/execute`.
Headers: `x-api-key`, `X-App-ApiClient: asi-sandbox`, `X-Agent-ID`.
On 401: sets `credentialsExpired = true`, rejects with error.
On success: resets `credentialsExpired = false`, parses JSON response.

### `fetchFRED()`
```typescript
execSync(`curl -s --max-time 20 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=TOTBKCR&cosd=${twoYearsAgo}'`, { shell: "/bin/bash" })
```
Why `execSync` instead of `https`: FRED blocks Node.js `https` module user-agent.
Parses CSV, finds row closest to 365 days ago for YoY comparison.

### To replace with standard APIs (outside Perplexity):

**Finance connector → yahoo-finance2:**
```typescript
import yahooFinance from 'yahoo-finance2';

async function fetchPrices(symbols: string[]) {
  const quotes = await Promise.all(
    symbols.map(s => yahooFinance.quote(s))
  );
  return quotes;
}
```

**Ask AI → OpenAI:**
```typescript
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/ask", async (req, res) => {
  const { question, context } = req.body;
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a macro analyst..." },
      { role: "user", content: question }
    ]
  });
  res.json({ answer: completion.choices[0].message.content });
});
```

---

## Caching & Stale Data Handling

| Location | What it does |
|---|---|
| `server/routes.ts` — `CACHE_TTL` constant | 5-min TTL for live market data |
| `server/routes.ts` — `HISTORY_TTL_MS` | 30-min TTL for history queries |
| `server/routes.ts` — `lastFetch` / `cachedData` | Module-level cache state |
| `server/routes.ts` — `credentialsExpired` | Module-level 401 flag |
| `server/routes.ts` — stale backoff logic | On error: `lastFetch = now - TTL + 30_000` → retries in 30s |
| `client/src/lib/queryClient.ts` | Sets `__PORT_5000__` proxy token (replaced at deploy time) |
| `client/src/pages/Dashboard.tsx` — `useQuery` hooks | `refetchInterval: 60_000`, `retry: 5`, exponential backoff |
| `client/src/pages/Dashboard.tsx` — stale/cred banners | Reads `_stale` and `_credentials_expired` from API response |

---

## UI Tabs & Components

All UI lives in `client/src/pages/Dashboard.tsx` (2076 lines, one file).

| Tab component | Lines (approx) | Content |
|---|---|---|
| `OverviewTab` | ~200 | Gauge, prices grid, kill switches, signal bars, FRED card, CatalystCalendar |
| `SignalsTab` | ~300 | Overlay chart (6 signals, 0–100), toggle pills, time selector, accordion cards |
| `MacroRegimeTab` | ~250 | Regime rules, sector rotation table, capital risk curve, 12 regime conditions |
| `HistoryTab` | ~350 | Regime distribution strip, overlay chart, lookback selector, signal stress table |
| `WeightsTab` | ~200 | Weight methodology, bar chart, IC table, backtest comparison |
| `BacktestTab` | ~400 | Equity curves, drawdown, grouped bar chart, CI weights, correlation matrix, stats table |
| `GuideTab` | ~300 | 7 collapsible Accordion sections explaining all signals and methodology |

External component: `client/src/components/CatalystCalendar.tsx` — economic calendar with bull/base/bear scenarios. Event data is static in the component (no API call).

---

## SQLite Database

**File:** `market_cache_v3.db`

### Tables

**`score_history`** — one row per trading day:
```sql
CREATE TABLE score_history (
  date TEXT PRIMARY KEY,        -- 'YYYY-MM-DD'
  composite_score REAL,
  regime TEXT,                  -- 'LONG' | 'CAUTION' | 'RISK-OFF'
  ks1 REAL, ks2 REAL, ks3 REAL, ks4 REAL, ig_hy REAL, vix REAL,  -- signal stress 0-1
  ks1_signal INTEGER, ks2_signal INTEGER, ks3_signal INTEGER, ks4_signal INTEGER,  -- binary kill switches
  spy_price REAL, hyg_price REAL, vix_value REAL,
  totbkcr_yoy REAL
);
```

**`cache`** — KV store for live data:
```sql
CREATE TABLE cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,           -- JSON blob
  updated_at INTEGER NOT NULL    -- Unix ms
);
```

### Re-seeding
```bash
cd signal_backtest
python3 seed_v3_history.py
# Reads prices_raw.csv + totbkcr_raw.csv, computes all signals, inserts rows
```

---

## Backtest System

**Location:** `signal_backtest/`

| File | Purpose |
|---|---|
| `02_full_analysis.py` | Full backtest pipeline: loads CSVs, computes signals, runs logistic regression, derives IC weights, generates equity curves and all output CSVs |
| `seed_v3_history.py` | Reads raw CSV data, computes signals using same logic as server, seeds SQLite DB |
| `prices_raw.csv` | 6,610 rows daily OHLC for SPY, HYG, LQD, TLT, GLD, VIX — 2000 to 2026 |
| `totbkcr_raw.csv` | 1,370 rows FRED TOTBKCR monthly — 2000 to 2026 |
| `equity_curves.json` | 957 sampled data points (every 5 trading days) — embedded in `client/src/data/equityCurves.ts` |

Weight derivation methodology:
1. Compute each signal's stress score for every day 2007–2026
2. Calculate Spearman IC (information coefficient) vs forward 20/40/60-day SPY returns
3. Run logistic regression with forward drawdown as target
4. Bootstrap (N=500) for 95% CI on coefficients
5. Normalize absolute coefficients to sum = 1.0 → final weights

---

## `__PORT_5000__` Token

In `client/src/lib/queryClient.ts`, API base URL contains the literal string `__PORT_5000__`. This is a Perplexity deployment artifact — it gets replaced by the hosting proxy path at deploy time.

**For local development:** Replace with `http://localhost:5000` (or just use an empty string since Vite proxies API calls in dev mode via `vite.config.ts`).

**For production outside Perplexity:** Set `VITE_API_BASE_URL` env var and update `queryClient.ts` to use `import.meta.env.VITE_API_BASE_URL`.

---

## Environment & Secrets

| Variable / File | Purpose | Required outside Perplexity? |
|---|---|---|
| `/tmp/.tools_service_endpoint` | Finance connector credentials (auto-injected by Perplexity) | No — replace with yahoo-finance2 |
| `OPENAI_API_KEY` env var | For Ask AI if replacing Perplexity LLM | Yes, if you want Ask AI |
| No `.env` file exists | All config is either hardcoded or runtime-injected | N/A |

---

## Quick-Start Checklist for a New Developer

1. `npm install`
2. `npm run dev` → opens on port 5000
3. Live market data will fail (connector not available) but DB history will load fine
4. To get live data: replace `callFinance()` in `server/routes.ts` with `yahoo-finance2`
5. To get Ask AI working: add OpenAI key + update `/api/ask` route
6. SQLite DB ships with 4,787 rows of history — History and Backtest tabs work immediately
7. Backtest tab reads from `client/src/data/equityCurves.ts` (static, no API needed)
