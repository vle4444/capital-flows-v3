# Capital Flows v3 — Weighted Macro Regime Dashboard

A self-hosted, zero-API-key market regime dashboard. Pulls live prices via **yahoo-finance2** and bank credit data from **FRED**, computes a weighted composite stress score across 6 signals, and classifies the market into LONG / CAUTIOUS / RISK-OFF regimes.

---

## Data Sources

| Signal | Source | Endpoint | Auth |
|---|---|---|---|
| SPY, HYG, LQD, TLT, TIP prices | Yahoo Finance | `yahoo-finance2` npm package (public) | None |
| VIX (`^VIX`) | Yahoo Finance | `yahoo-finance2` npm package (public) | None |
| TOTBKCR — Total Bank Credit YoY | St. Louis FRED | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=TOTBKCR` | None (public CSV) |

No API keys. No Perplexity connector dependencies remain.

---

## Signals & Weights

Derived via logistic regression + IC analysis on 4,784 trading days (Apr 2007 – Apr 2026). OOS AUC: 0.568 ± 0.232 (Bootstrap N=500).

| Signal | Weight | Description |
|---|---|---|
| KS1 — HY Spread | 20.2% | HYG % below 52-week high |
| KS2 — Joint Selloff | 14.6% | SPY and HYG both down >1.5% same day |
| KS3 — Real Rate Stress | 14.4% | TLT/TIP ratio z-score |
| KS4 — Bank Credit | 6.6% | FRED TOTBKCR YoY% |
| IG/HY Differential | 7.4% | LQD/HYG ratio z-score |
| VIX Level | 36.9% | Raw VIX level percentile |

**Regime thresholds:** RISK-OFF ≥ 0.65 · CAUTIOUS ≥ 0.45 · LONG < 0.45

---

## Quick Start

**Requirements:** Node.js 18+ (tested on v24), Git, Windows/macOS/Linux

```bash
git clone https://github.com/vle4444/capital-flows-v3.git
cd capital-flows-v3
npm install
npm run dev
```

Open **http://localhost:5000**

### Scripts

| Command | Description |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build |
| `npm start` | Run production build |
| `npm run check` | TypeScript type check |

---

## Architecture

```
server/
  index.ts       — Express server, Vite dev middleware
  routes.ts      — All API routes + data fetching logic

client/src/
  pages/Dashboard.tsx   — Main dashboard UI
  components/           — CatalystCalendar, charts, etc.

market_cache_v3.db      — SQLite: live cache + 4,787-row score history (2007–2026)
```

### API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/market` | Live composite score, regime, all signal values |
| `GET /api/catalysts` | Economic calendar with bull/base/bear scenarios |
| `GET /api/history?days=365` | Score history from SQLite |
| `GET /api/weights` | Signal weights + backtest stats |
| `GET /api/ping` | Health check |

### Caching

- **In-memory:** 3-minute TTL for market data
- **SQLite:** Persistent fallback + daily score history rows
- On fetch failure: serves last SQLite-cached payload with `_stale: true`

---

## Connector Dependencies

**None.** The `local-runnable2` migration removed all Perplexity connector dependencies:

| Removed | Replaced with |
|---|---|
| `callFinance("finance_quotes", ...)` | `yahooFinance.quote()` |
| `callFinance("finance_macro_snapshot", ...)` | Hardcoded macro defaults |
| `callFinance("finance_ticker_sentiment", ...)` | Honest fallback text |
| `readEndpointConfig()` | Deleted |

---

## Environment

No `.env` file needed. See `.env.example` for documentation.

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
