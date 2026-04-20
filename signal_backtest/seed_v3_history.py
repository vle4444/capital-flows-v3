"""
Seed v3 score_history table with historical computed composite scores.
Uses the same signal logic as the live server.
"""

import pandas as pd
import numpy as np
import sqlite3
import os

DB_PATH = "/home/user/workspace/capital-flows-v3/market_cache_v3.db"
OUT_DIR = "/home/user/workspace/signal_backtest"

# ─── Load data ────────────────────────────────────────────────────────────────
prices = pd.read_csv(f"{OUT_DIR}/prices_raw.csv", index_col=0, parse_dates=True)
prices.columns = [c.replace('^','') for c in prices.columns]

fred = pd.read_csv(f"{OUT_DIR}/totbkcr_raw.csv",
                   names=['date','TOTBKCR'], skiprows=1, parse_dates=['date'])
fred.set_index('date', inplace=True)
fred['TOTBKCR'] = pd.to_numeric(fred['TOTBKCR'], errors='coerce')

# ─── Align to HYG history (from 2004, but use last 3 years for seeding) ──────
spy = prices['SPY']
hyg = prices['HYG']
lqd = prices['LQD']
vix = prices['VIX']
tlt = prices['TLT']
tip = prices['TIP']

common_start = max(hyg.dropna().index[0], lqd.dropna().index[0], tlt.dropna().index[0], tip.dropna().index[0])
# Seed last 3 years only (enough for charts, not too slow)
seed_start = pd.Timestamp('2023-01-01')
idx = spy.index[(spy.index >= max(common_start, seed_start))]

spy = spy.reindex(idx).ffill()
hyg = hyg.reindex(idx).ffill()
lqd = lqd.reindex(idx).ffill()
vix = vix.reindex(idx).ffill()
tlt = tlt.reindex(idx).ffill()
tip = tip.reindex(idx).ffill()

fred_daily = fred['TOTBKCR'].reindex(idx, method='ffill')

spy_ret = spy.pct_change()
hyg_ret = hyg.pct_change()
lqd_ret = lqd.pct_change()

print(f"Seeding {len(idx)} days from {idx[0].date()} → {idx[-1].date()}")

# ─── Compute signals (same logic as routes.ts) ────────────────────────────────

# KS1: HYG % below 52w high
hyg_52wk_high = hyg.rolling(252, min_periods=20).max()
ks1_pct = (hyg_52wk_high - hyg) / hyg_52wk_high * 100

# KS2: joint selloff (3-day rolling)
joint = ((hyg_ret < -0.015) & (spy_ret < -0.015)).astype(float)
ks2_rolling = (joint.rolling(3).sum() >= 2).astype(float)

# KS3: TLT/TIP ratio z-score
tlt_tip_ratio = tlt / tip
# Use same normalization as server: (ratio - 1.02) / 0.05
ks3_zscore = (tlt_tip_ratio - 1.02) / 0.05

# KS4: TOTBKCR YoY
totbkcr_yoy = fred_daily.pct_change(365) * 100

# IG/HY differential z-score
lqd_hyg_ratio = lqd / hyg
ig_hy_zscore = (lqd_hyg_ratio - 1.52) / 0.08

# ─── Historical percentile reference breakpoints (same as server) ─────────────
REFS = {
    'ks1':   [0, 0.5, 1.2, 2.8, 5.0, 8.5, 14.0, 22.0, 35.0],
    'ks3_inv': [-2.8, -2.0, -1.5, -0.8, -0.2, 0.5, 1.2, 2.0, 2.8],  # inverted
    'ks4_inv': [-2.0, 0.0, 1.5, 3.0, 4.5, 6.0, 7.5, 9.0, 12.0],      # inverted
    'ig_hy': [-2.0, -1.0, -0.3, 0.2, 0.8, 1.5, 2.2, 3.0, 4.0],
    'vix':   [9, 12, 14, 17, 20, 25, 30, 35, 45, 65, 85],
}

WEIGHTS = {
    'ks1': 0.202,
    'ks2': 0.146,
    'ks3': 0.144,
    'ks4': 0.066,
    'ig_hy': 0.074,
    'vix': 0.369,
}

def to_pctile(value, breakpoints, invert=False):
    n = len(breakpoints)
    rank = 0.0
    for bp in breakpoints:
        if value > bp:
            rank += 1.0 / n
    return (1 - rank) if invert else rank

RISK_OFF = 0.65
CAUTION = 0.45

# ─── Build rows ───────────────────────────────────────────────────────────────
rows = []
for date in idx:
    try:
        k1 = float(ks1_pct[date]) if not pd.isna(ks1_pct[date]) else 1.2
        k2 = float(ks2_rolling[date]) if not pd.isna(ks2_rolling[date]) else 0.0
        k3 = float(ks3_zscore[date]) if not pd.isna(ks3_zscore[date]) else 0.0
        k4 = float(totbkcr_yoy[date]) if not pd.isna(totbkcr_yoy[date]) else 6.0
        igh = float(ig_hy_zscore[date]) if not pd.isna(ig_hy_zscore[date]) else 0.0
        vx  = float(vix[date]) if not pd.isna(vix[date]) else 20.0
        spy_p = float(spy[date]) if not pd.isna(spy[date]) else None
        hyg_p = float(hyg[date]) if not pd.isna(hyg[date]) else None

        p_ks1  = to_pctile(k1, REFS['ks1'])
        p_ks2  = k2  # already 0/1
        p_ks3  = to_pctile(k3, REFS['ks3_inv'], invert=True)
        p_ks4  = to_pctile(k4, REFS['ks4_inv'], invert=True)
        p_igh  = to_pctile(igh, REFS['ig_hy'])
        p_vix  = to_pctile(vx, REFS['vix'])

        composite = (
            WEIGHTS['ks1']  * p_ks1 +
            WEIGHTS['ks2']  * p_ks2 +
            WEIGHTS['ks3']  * p_ks3 +
            WEIGHTS['ks4']  * p_ks4 +
            WEIGHTS['ig_hy']* p_igh +
            WEIGHTS['vix']  * p_vix
        )

        regime = "RISK-OFF" if composite >= RISK_OFF else "CAUTIOUS" if composite >= CAUTION else "LONG"

        ks1_sig = 1 if k1 > 5 else 0
        ks2_sig = int(k2)
        ks3_sig = 1 if k3 < -1.5 else 0
        ks4_sig = 1 if k4 < 0 else 0

        rows.append((
            date.strftime('%Y-%m-%d'),
            composite, regime,
            p_ks1, p_ks2, p_ks3, p_ks4, p_igh, p_vix,
            ks1_sig, ks2_sig, ks3_sig, ks4_sig,
            spy_p, hyg_p, vx, k4
        ))
    except Exception as e:
        pass

print(f"Computed {len(rows)} rows")

# ─── Write to SQLite (skip today's live row) ─────────────────────────────────
conn = sqlite3.connect(DB_PATH)
today = pd.Timestamp.now().strftime('%Y-%m-%d')

inserted = 0
for row in rows:
    if row[0] == today:
        continue  # don't overwrite live data
    conn.execute("""
        INSERT OR IGNORE INTO score_history(
            date, composite_score, regime,
            ks1, ks2, ks3, ks4, ig_hy, vix,
            ks1_signal, ks2_signal, ks3_signal, ks4_signal,
            spy_price, hyg_price, vix_value, totbkcr_yoy
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, row)
    inserted += 1

conn.commit()
conn.close()

print(f"Inserted {inserted} historical rows into v3 database")

# Verify
conn = sqlite3.connect(DB_PATH)
count = conn.execute("SELECT COUNT(*) FROM score_history").fetchone()[0]
first = conn.execute("SELECT date FROM score_history ORDER BY date ASC LIMIT 1").fetchone()[0]
last  = conn.execute("SELECT date FROM score_history ORDER BY date DESC LIMIT 1").fetchone()[0]
conn.close()
print(f"Total rows in DB: {count} | {first} → {last}")

# Print regime distribution
conn = sqlite3.connect(DB_PATH)
regimes = conn.execute("SELECT regime, COUNT(*) FROM score_history GROUP BY regime").fetchall()
conn.close()
print("Regime distribution:", dict(regimes))
