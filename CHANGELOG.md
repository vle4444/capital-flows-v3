# Changelog

## [local-runnable2] — 2026-04-20

Complete migration from Perplexity connector dependencies to fully self-hosted, zero-API-key operation.

### Changed Files

| File | Change |
|---|---|
| `server/routes.ts` | Core migration: replaced all connector calls with yahoo-finance2 |
| `server/index.ts` | Windows compatibility: `127.0.0.1` bind + removed `reusePort` |
| `client/src/pages/Dashboard.tsx` | Renamed `_credentials_expired` → `_data_source_error`; updated banner text |
| `package.json` | Added `yahoo-finance2 ^2.13.0`, `cross-env ^7.0.3`; bumped `better-sqlite3 ^12.1.0` |
| `.env.example` | New file documenting no-key-required setup |
| `README.md` | Full rewrite documenting data sources, architecture, API |
| `CHANGELOG.md` | This file |

### Added
- `yahoo-finance2` — fetches SPY, HYG, LQD, TLT, TIP, ^VIX from public Yahoo Finance endpoints
- `cross-env` — Windows-compatible `NODE_ENV` variable in npm scripts
- `.env.example` — documents zero-config setup
- `README.md` — full data source documentation, architecture overview, run instructions

### Removed
- `callFinance()` — internal Perplexity connector HTTP function
- `readEndpointConfig()` — reads `/tmp/.tools_service_endpoint` (Perplexity-only)
- `extractQuote()` — markdown table parser for connector response format
- `credentialsExpired` flag — replaced with `dataSourceError`
- All `finance_quotes`, `finance_macro_snapshot`, `finance_ticker_sentiment` connector calls

### Fixed
- `ENOTSUP` error on Windows: server now binds to `127.0.0.1` and skips `reusePort` on win32
- `better-sqlite3` install failure on Node 24: bumped to v12.1.0 which ships Node 24 prebuilt Windows binaries (no Visual Studio / node-gyp required)
- `yahoo-finance2` ESM interop under tsx: package exports its class as default under esbuild transform; fixed by detecting and instantiating with `new _YFClass({})` when `.quote` is not present on the default export directly

### Renamed
- `_credentials_expired` → `_data_source_error` in `/api/market` and `/api/ping` responses
- Dashboard banner text updated: "Live data unavailable — retrying. Showing last cached values."

### Data Sources (post-migration)
- **Prices (SPY, HYG, LQD, TLT, TIP, VIX):** Yahoo Finance via `yahoo-finance2` — no key required
- **Bank Credit (TOTBKCR):** St. Louis FRED public CSV endpoint — no key required
- **Catalyst calendar:** Hardcoded `EVENT_SCHEDULE` in `server/routes.ts`
- **Macro defaults:** Hardcoded fallbacks in `buildCatalystsPayload()`

### Connector Dependencies Remaining
**None.**
