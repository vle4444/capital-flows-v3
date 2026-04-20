# Capital Flows — Weighted Macro Dashboard v3

A live macro regime tracking dashboard that monitors six quantitative signals to classify market conditions as **LONG**, **CAUTION**, or **RISK-OFF**. Signal weights are empirically derived from backtesting 4,784 trading days (2007–2026).

Built and iterated inside [Perplexity Computer](https://www.perplexity.ai/computer). See `HANDOFF.md` for full architecture details.

---

## Live URL

> https://www.perplexity.ai/computer/a/capital-flows-weighted-macro-d-2YVwn5e6QYC8oegetR6Abw

*(Perplexity-hosted — requires the backend server running inside that session)*

---

## Top-Level Structure

```
capital-flows-v3/
├── client/                        # React frontend (Vite)
│   ├── index.html
│   └── src/
│       ├── pages/
│       │   └── Dashboard.tsx      # ← MAIN UI — all 7 tabs (2076 lines)
│       ├── components/
│       │   ├── CatalystCalendar.tsx  # Economic calendar component
│       │   └── ui/                # shadcn/ui primitives
│       ├── data/
│       │   └── equityCurves.ts    # 957-row backtest equity curve data
│       ├── lib/
│       │   └── queryClient.ts     # React Query + proxy URL config
│       ├── App.tsx
│       ├── main.tsx
│       └── index.css              # Dark theme
├── server/
│   ├── index.ts                   # ← EXPRESS ENTRY POINT
│   ├── routes.ts                  # ← ALL API ROUTES + signal logic (827 lines)
│   ├── static.ts                  # Static file serving
│   ├── storage.ts                 # Drizzle ORM helpers
│   └── vite.ts                    # Dev-mode Vite middleware
├── shared/
│   └── schema.ts                  # Drizzle schema (SQLite tables)
├── script/
│   └── build.ts                   # Custom build script
├── signal_backtest/               # Python backtest scripts + data
│   ├── 02_full_analysis.py        # Full backtest (reproduces weights)
│   ├── seed_v3_history.py         # Seeds SQLite DB from CSV history
│   ├── prices_raw.csv             # 6,610 rows OHLC (SPY/HYG/LQD/TLT/VIX, 2000→)
│   ├── totbkcr_raw.csv            # FRED TOTBKCR monthly (2000→)
│   ├── equity_curves.json         # Computed equity + drawdown series
│   ├── backtest_stats.csv         # 4-strategy performance comparison
│   ├── evidence_weights.csv       # IC per signal per horizon
│   └── signal_correlations.csv   # Spearman correlation matrix
├── market_cache_v3.db             # SQLite — 4,787 rows (2007-04-11 → 2026-04-20)
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
├── drizzle.config.ts
├── README.md
└── HANDOFF.md
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20 + Express + TypeScript |
| Frontend | React 18 + Vite + TypeScript |
| Styling | Tailwind CSS + shadcn/ui |
| Charts | Recharts |
| Routing | wouter (hash-based) |
| Data fetching | @tanstack/react-query v5 |
| Database | SQLite via better-sqlite3 + Drizzle ORM |
| Backtest | Python 3 (pandas, numpy, scikit-learn) |

---

## Install

```bash
cd capital-flows-v3
npm install
```

Python backtest scripts (optional):
```bash
pip install pandas numpy scikit-learn scipy
```

---

## Run (Development)

```bash
npm run dev
# → http://localhost:5000
```

---

## Run (Production)

```bash
npm run build
NODE_ENV=production node dist/index.cjs
# → http://localhost:5000
```

---

## Restart (Production)

```bash
# Kill existing process
pkill -f "dist/index.cjs"

# Restart with fresh credentials (Perplexity environment)
NODE_ENV=production node dist/index.cjs
```

> **Note:** In the Perplexity Computer environment, the server must be started with `api_credentials=["external-tools"]` injected to get a fresh `/tmp/.tools_service_endpoint` credentials file. See [Perplexity-only dependencies](#perplexity-only-dependencies) below.

---

## Entry Points

| | File |
|---|---|
| Backend entry | `server/index.ts` |
| All API routes + signal logic | `server/routes.ts` |
| Frontend entry | `client/src/main.tsx` |
| Main UI (all tabs) | `client/src/pages/Dashboard.tsx` |

---

## Database

- **File:** `market_cache_v3.db` (SQLite)
- **Rows:** 4,787 daily rows from 2007-04-11 → 2026-04-20
- **Tables:** `score_history` (daily regime scores), `cache` (live data KV store)

To re-seed from the raw CSV data:
```bash
cd signal_backtest
python3 seed_v3_history.py
```

---

## Re-run Backtest

To reproduce all signal weights from scratch:
```bash
cd signal_backtest
python3 02_full_analysis.py
```

Outputs: `backtest_stats.csv`, `evidence_weights.csv`, `signal_correlations.csv`, `equity_curves.json`

---

## Dashboard Tabs

| # | Tab | What it shows |
|---|---|---|
| 1 | Overview | Composite gauge, live prices, kill switch status, signal bars, FRED reading, Catalyst Calendar |
| 2 | Signals | Overlay chart (all 6 signals, 0–100 stress scale), toggleable, 1M–All time selector |
| 3 | Macro Regime | Regime rules, sector rotation, capital risk curve, 12 regime rules |
| 4 | History | Regime strip, overlay chart, signal stress table, 1M–All lookback |
| 5 | Weights | Methodology, weight bars, IC table, backtest performance comparison |
| 6 | Backtest | Equity curves (log scale), drawdown chart, strategy comparison, correlation matrix, model validation |
| 7 | Guide | 7 collapsible sections explaining all indicators, weights, and how to use the dashboard |

---

## Signal Weights

Evidence-based via logistic regression + IC analysis (OOS AUC: 0.568 ± 0.232):

| Signal | Weight | Source |
|---|---|---|
| VIX | 36.9% | CBOE via finance connector |
| KS1 HY Spread | 20.2% | HYG vs LQD relative performance |
| KS2 Joint Selloff | 14.6% | SPY + HYG both down simultaneously |
| KS3 Real Rate Stress | 14.4% | TLT ratio proxy |
| IG/HY Differential | 7.4% | LQD vs HYG spread z-score |
| KS4 Bank Credit | 6.6% | FRED TOTBKCR YoY growth |

Composite ≥ 0.65 → **RISK-OFF** | ≥ 0.45 → **CAUTION** | < 0.45 → **LONG**

---

## Perplexity-Only Dependencies

Two things **will not work** outside Perplexity Computer:

### 1. Finance Connector (`/tmp/.tools_service_endpoint`)
Used in `server/routes.ts` → `callFinance()` to fetch live market data (SPY, HYG, LQD, TLT, VIX prices).

**To replace:** Swap `callFinance()` with `yahoo-finance2` npm package:
```typescript
import yahooFinance from 'yahoo-finance2';
const quote = await yahooFinance.quote('SPY');
```

### 2. Ask AI (`POST /api/ask`)
Proxies to an internal Perplexity LLM endpoint.

**To replace:** Use OpenAI or Anthropic SDK directly:
```typescript
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
```

Everything else — SQLite, FRED curl fetch, all signal computation, Recharts UI — is fully portable and runs on any Node 20+ environment.

---

## Scheduled Automation (Perplexity-only)

A weekly cron runs every Friday at 20:15 UTC to fetch the Fed's H.8 bank credit release (FRED TOTBKCR), compute YoY growth, and send an in-app notification with signal status. This is a Perplexity Computer cron and has no equivalent in the repo code.
