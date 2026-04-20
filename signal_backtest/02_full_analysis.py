"""
Full Signal Backtesting Analysis
- Compute 4 kill switch signals historically
- Logistic regression: signal vs SPY drawdown >15% in 20/40/60 days
- Information Coefficients at 4/8/12-week horizons
- Signal correlation matrix
- Evidence-based weights with confidence intervals
- Backtest: equal-weight binary vs weighted composite
"""

import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import seaborn as sns
from scipy import stats
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import roc_auc_score, brier_score_loss
import warnings
warnings.filterwarnings('ignore')
import os

OUT_DIR = "/home/user/workspace/signal_backtest"
os.makedirs(OUT_DIR, exist_ok=True)

# ============================================================
# 1. LOAD DATA
# ============================================================
print("=== Loading Data ===")
prices = pd.read_csv(f"{OUT_DIR}/prices_raw.csv", index_col=0, parse_dates=True)
prices.index.name = "date"
prices.columns = [c.replace('^','') for c in prices.columns]

fred_df = pd.read_csv(f"{OUT_DIR}/totbkcr_raw.csv", 
                       names=['date','TOTBKCR'], skiprows=1, parse_dates=['date'])
fred_df.set_index('date', inplace=True)
fred_df['TOTBKCR'] = pd.to_numeric(fred_df['TOTBKCR'], errors='coerce')

# Reindex FRED to daily (forward fill weekly data)
fred_daily = fred_df.reindex(prices.index, method='ffill')

print(f"Prices: {prices.shape[0]} rows, {prices.index[0].date()} → {prices.index[-1].date()}")
print(f"FRED: {fred_df.shape[0]} rows")
print(f"Columns: {list(prices.columns)}")

# ============================================================
# 2. COMPUTE SIGNALS
# ============================================================
print("\n=== Computing Signals ===")

spy = prices['SPY'].dropna()
hyg = prices['HYG'].dropna()
lqd = prices['LQD'].dropna()
vix = prices['VIX'].dropna()
tlt = prices['TLT'].dropna()

# Common index from HYG inception (April 2004)
common_start = max(hyg.index[0], lqd.index[0])
idx = spy.index[spy.index >= common_start]

spy = spy.reindex(idx)
hyg = hyg.reindex(idx)
lqd = lqd.reindex(idx)
vix = vix.reindex(idx)
tlt = tlt.reindex(idx)
totbkcr = fred_daily['TOTBKCR'].reindex(idx, method='ffill')

# Daily returns
spy_ret = spy.pct_change()
hyg_ret = hyg.pct_change()
lqd_ret = lqd.pct_change()

# ---- KS1: HYG % below rolling 52-week high ----
hyg_52wk_high = hyg.rolling(252).max()
ks1_raw = (hyg_52wk_high - hyg) / hyg_52wk_high * 100   # % below high
ks1_signal = (ks1_raw > 5).astype(float)                  # 1 = danger

# ---- KS2: Joint selloff — HYG < -1.5% AND SPY < -1.5%, 3-day rolling ----
joint_selloff = ((hyg_ret < -0.015) & (spy_ret < -0.015)).astype(float)
ks2_signal = (joint_selloff.rolling(3).sum() >= 2).astype(float)

# ---- KS3: Real rate proxy — 5Y nominal - TIPS breakeven ----
# Proxy: TLT yield proxy vs TIP returns. Use VIX-normalized real rate stress
# Better proxy: use LQD-HYG spread as real rate stress
# Actually use: TLT rolling return as nominal duration proxy, TIP rolling return as real
# Real rate stress = TLT underperformance vs TIP (nominal rate rising faster than real)
tip = prices['TIP'].reindex(idx)
# Use 60-day rolling relative performance as real rate proxy
tlt_60 = tlt.pct_change(60)
tip_60 = tip.pct_change(60)
ks3_raw = tlt_60 - tip_60   # negative = nominal rates rising faster = real rate stress
# Normalize to z-score for comparability
ks3_zscore = (ks3_raw - ks3_raw.rolling(252).mean()) / ks3_raw.rolling(252).std()
ks3_signal = (ks3_zscore < -1.5).astype(float)  # 1.5 sigma below mean = stress

# ---- KS4: TOTBKCR YoY growth ----
totbkcr_yoy = totbkcr.pct_change(365) * 100
ks4_signal = (totbkcr_yoy < 0).astype(float)

# Also compute deceleration variant (growth rate falling)
totbkcr_yoy_chg = totbkcr_yoy.diff(52)  # change in YoY over ~1 year (weekly data)
# Reindex daily
ks4_decel = (totbkcr_yoy < 3).astype(float)  # warning zone: below 3% threshold

# ---- Additional signals: IG/HY spread differential, VIX level ----
# LQD-HYG return differential (negative = HY underperforming, stress signal)
lqd_hyg_spread = lqd_ret.rolling(20).mean() - hyg_ret.rolling(20).mean()
lqd_hyg_zscore = (lqd_hyg_spread - lqd_hyg_spread.rolling(252).mean()) / lqd_hyg_spread.rolling(252).std()
spread_signal = (lqd_hyg_zscore > 1.5).astype(float)  # HY underperforming IG

# VIX signal
vix_signal = (vix > 25).astype(float)
vix_extreme = (vix > 35).astype(float)

# IG/HY spread raw (continuous)
spread_raw = lqd_hyg_zscore

# Build signal dataframe
signals = pd.DataFrame({
    'KS1_raw': ks1_raw,
    'KS1': ks1_signal,
    'KS2': ks2_signal,
    'KS3_zscore': ks3_zscore,
    'KS3': ks3_signal,
    'KS4_yoy': totbkcr_yoy,
    'KS4': ks4_signal,
    'KS4_decel': ks4_decel,
    'Spread_zscore': spread_raw,
    'Spread': spread_signal,
    'VIX': vix,
    'VIX_signal': vix_signal,
    'VIX_extreme': vix_extreme,
    'SPY': spy,
    'SPY_ret': spy_ret,
}, index=idx).dropna(subset=['KS1','KS2','KS3','KS4'])

print(f"Signal data: {len(signals)} rows ({signals.index[0].date()} → {signals.index[-1].date()})")
print(f"\nSignal activation rates:")
for col in ['KS1','KS2','KS3','KS4','KS4_decel','Spread','VIX_signal']:
    rate = signals[col].mean()
    count = signals[col].sum()
    print(f"  {col}: {rate:.1%} of days ({count:.0f} days)")

# ============================================================
# 3. DEFINE TARGET VARIABLE: SPY max drawdown >15% in next N days
# ============================================================
print("\n=== Computing Target Variables ===")

def compute_max_drawdown_forward(spy_prices, horizons=[20, 40, 60]):
    """For each day, compute max drawdown in forward N trading days."""
    results = {}
    spy_arr = spy_prices.values
    n = len(spy_arr)
    for h in horizons:
        dd = np.full(n, np.nan)
        for i in range(n - h):
            fwd = spy_arr[i+1:i+h+1]
            peak = spy_arr[i]
            min_fwd = np.min(fwd)
            dd[i] = (min_fwd - peak) / peak  # negative = drawdown
        results[f'dd_{h}d'] = dd
    return pd.DataFrame(results, index=spy_prices.index)

print("Computing forward drawdowns (this takes ~30 seconds)...")
dd_df = compute_max_drawdown_forward(signals['SPY'], horizons=[20, 40, 60])

# Binary targets
for h in [20, 40, 60]:
    signals[f'target_{h}d'] = (dd_df[f'dd_{h}d'] < -0.15).astype(float)
    signals[f'dd_{h}d'] = dd_df[f'dd_{h}d']

# Forward returns (for IC calculation)
for h in [20, 40, 60]:  # ~4w, 8w, 12w
    signals[f'fwd_{h}d_ret'] = signals['SPY'].pct_change(h).shift(-h)

print(f"Target event rates:")
for h in [20, 40, 60]:
    rate = signals[f'target_{h}d'].mean()
    print(f"  >15% drawdown in {h}d: {rate:.2%}")

# ============================================================
# 4. LOGISTIC REGRESSION — Evidence-Based Weights
# ============================================================
print("\n=== Logistic Regression Analysis ===")

# Continuous signal features for logistic regression
feature_cols = {
    'KS1_pct_below_52wk': 'KS1_raw',    # continuous: % below 52-week high
    'KS2_rolling': 'KS2',                # binary cumulative
    'KS3_zscore': 'KS3_zscore',          # continuous z-score
    'KS4_yoy_growth': 'KS4_yoy',         # continuous YoY%
    'Spread_zscore': 'Spread_zscore',    # continuous IG/HY differential
    'VIX_level': 'VIX',                  # raw VIX
}

target_col = 'target_60d'   # 60-day horizon for signal stability

# Prepare dataset
analysis_df = signals[list(feature_cols.values()) + [target_col, 'target_20d', 'target_40d']].dropna()
print(f"Analysis dataset: {len(analysis_df)} rows")
print(f"Positive class rate: {analysis_df[target_col].mean():.2%}")

X_raw = analysis_df[list(feature_cols.values())].values
y = analysis_df[target_col].values

scaler = StandardScaler()
X = scaler.fit_transform(X_raw)

# Time-series cross-validation
tscv = TimeSeriesSplit(n_splits=8)
oos_aucs = []
oos_briefs = []
coef_matrix = []

for fold, (train_idx, test_idx) in enumerate(tscv.split(X)):
    X_train, X_test = X[train_idx], X[test_idx]
    y_train, y_test = y[train_idx], y[test_idx]
    if y_train.sum() < 5:
        continue
    lr = LogisticRegression(C=1.0, class_weight='balanced', max_iter=1000, random_state=42)
    lr.fit(X_train, y_train)
    if y_test.sum() > 0:
        proba = lr.predict_proba(X_test)[:,1]
        oos_aucs.append(roc_auc_score(y_test, proba))
        oos_briefs.append(brier_score_loss(y_test, proba))
    coef_matrix.append(lr.coef_[0])

# Full-sample fit for final coefficients
lr_full = LogisticRegression(C=1.0, class_weight='balanced', max_iter=1000, random_state=42)
lr_full.fit(X, y)
full_coefs = lr_full.coef_[0]

# Bootstrap confidence intervals for coefficients
n_boot = 500
boot_coefs = np.zeros((n_boot, X.shape[1]))
np.random.seed(42)
for b in range(n_boot):
    idx_b = np.random.choice(len(X), len(X), replace=True)
    X_b, y_b = X[idx_b], y[idx_b]
    if y_b.sum() < 5:
        boot_coefs[b] = full_coefs
        continue
    lr_b = LogisticRegression(C=1.0, class_weight='balanced', max_iter=500, random_state=b)
    lr_b.fit(X_b, y_b)
    boot_coefs[b] = lr_b.coef_[0]

ci_lower = np.percentile(boot_coefs, 2.5, axis=0)
ci_upper = np.percentile(boot_coefs, 97.5, axis=0)

feature_names = list(feature_cols.keys())
print(f"\nLogistic Regression Results (60-day horizon):")
print(f"OOS AUC: {np.mean(oos_aucs):.3f} ± {np.std(oos_aucs):.3f}")
print(f"OOS Brier: {np.mean(oos_briefs):.3f}")
print(f"\nCoefficients (standardized — larger = stronger signal):")
for i, fn in enumerate(feature_names):
    sig_flag = "**" if (ci_lower[i] > 0 or ci_upper[i] < 0) else "  "
    print(f"  {sig_flag}{fn}: {full_coefs[i]:.3f} [95% CI: {ci_lower[i]:.3f}, {ci_upper[i]:.3f}]")

# ============================================================
# 5. INFORMATION COEFFICIENTS
# ============================================================
print("\n=== Information Coefficients (signal vs forward SPY returns) ===")

ic_results = {}
continuous_signals = {
    'KS1_pct_below_52wk': 'KS1_raw',
    'KS2_joint_selloff': 'KS2',
    'KS3_real_rate_zscore': 'KS3_zscore',
    'KS4_yoy_growth': 'KS4_yoy',
    'IG_HY_spread_zscore': 'Spread_zscore',
    'VIX': 'VIX',
}

for signal_name, col in continuous_signals.items():
    ic_results[signal_name] = {}
    for h in [20, 40, 60]:
        fwd_col = f'fwd_{h}d_ret'
        merged = signals[[col, fwd_col]].dropna()
        if len(merged) < 100:
            continue
        ic, pval = stats.spearmanr(merged[col], merged[fwd_col])
        ic_results[signal_name][f'{h}d IC'] = ic
        ic_results[signal_name][f'{h}d p-val'] = pval

ic_df = pd.DataFrame(ic_results).T
print(ic_df.round(4))

# ============================================================
# 6. SIGNAL CORRELATION MATRIX
# ============================================================
print("\n=== Signal Correlation Matrix ===")

corr_cols = ['KS1_raw', 'KS2', 'KS3_zscore', 'KS4_yoy', 'Spread_zscore', 'VIX']
corr_labels = ['KS1\n(HY spread)', 'KS2\n(Joint selloff)', 'KS3\n(Real rate)', 
               'KS4\n(Bank credit)', 'IG/HY\nDifferential', 'VIX']
corr_data = signals[corr_cols].dropna()
corr_matrix = corr_data.corr(method='spearman')
print(corr_matrix.round(3))
corr_matrix.to_csv(f"{OUT_DIR}/signal_correlations.csv")

# ============================================================
# 7. DERIVE EVIDENCE-BASED WEIGHTS
# ============================================================
print("\n=== Deriving Evidence-Based Weights ===")

# Method: combine logistic regression coefficients with IC across horizons
# Weight = sign-adjusted mean across metrics, then softmax-normalize

# Logistic coefs (positive = more predictive of drawdown = higher weight)
# Some signals are inverted (lower value = worse), so we need sign correction
# KS1_raw: higher = worse (positive coef expected)
# KS2: higher = worse (positive coef expected)
# KS3_zscore: lower = worse (negative coef expected → negate)
# KS4_yoy: lower = worse (negative coef expected → negate)
# Spread_zscore: higher = worse (positive coef expected)
# VIX: higher = worse (positive coef expected)

sign_correction = np.array([1, 1, -1, -1, 1, 1])
adj_coefs = full_coefs * sign_correction

# IC: invert sign for KS3, KS4 (because lower value → worse returns, IC will be positive)
ic_vals = np.array([
    abs(ic_results['KS1_pct_below_52wk'].get('60d IC', 0)),
    abs(ic_results['KS2_joint_selloff'].get('60d IC', 0)),
    abs(ic_results['KS3_real_rate_zscore'].get('60d IC', 0)),
    abs(ic_results['KS4_yoy_growth'].get('60d IC', 0)),
    abs(ic_results['IG_HY_spread_zscore'].get('60d IC', 0)),
    abs(ic_results['VIX'].get('60d IC', 0)),
])

# Stability: std of OOS coefs across folds
coef_arr = np.array(coef_matrix)
coef_stability = 1 / (coef_arr.std(axis=0) + 1e-6)
coef_stability_norm = coef_stability / coef_stability.sum()

# Combined score: geometric mean of logistic weight + IC weight
adj_coefs_pos = np.clip(adj_coefs, 0, None)
adj_coefs_norm = adj_coefs_pos / (adj_coefs_pos.sum() + 1e-10)
ic_norm = ic_vals / (ic_vals.sum() + 1e-10)

# Combined weight = 50% logistic + 30% IC + 20% stability
combined = 0.5 * adj_coefs_norm + 0.3 * ic_norm + 0.2 * coef_stability_norm

# Normalize to sum to 1
weights = combined / combined.sum()

signal_names_short = ['KS1 (HY Spread)', 'KS2 (Joint Selloff)', 'KS3 (Real Rate)', 
                       'KS4 (Bank Credit)', 'IG/HY Differential', 'VIX']

print("\nEvidence-Based Signal Weights:")
print(f"{'Signal':<25} {'LR Coef':>8} {'IC(60d)':>8} {'Stability':>10} {'WEIGHT':>8}")
print("-" * 65)
for i, name in enumerate(signal_names_short):
    print(f"{name:<25} {adj_coefs_pos[i]:>8.3f} {ic_vals[i]:>8.4f} {coef_stability_norm[i]:>10.3f} {weights[i]:>8.1%}")

weights_dict = dict(zip(signal_names_short, weights))

# Save weights
weights_df = pd.DataFrame({
    'Signal': signal_names_short,
    'LR_coef_adj': adj_coefs_pos,
    'IC_60d': ic_vals,
    'Stability': coef_stability_norm,
    'Final_Weight': weights,
    'CI_lower': ci_lower * sign_correction,
    'CI_upper': ci_upper * sign_correction,
})
weights_df.to_csv(f"{OUT_DIR}/evidence_weights.csv", index=False)

# ============================================================
# 8. BACKTEST: Equal-Weight Binary vs Weighted Composite
# ============================================================
print("\n=== Backtesting: Equal-Weight vs Weighted Composite ===")

# Build composite scores
bt = signals[['KS1_raw', 'KS2', 'KS3_zscore', 'KS4_yoy', 'Spread_zscore', 'VIX',
              'KS1', 'KS3', 'KS4', 'Spread', 'VIX_signal',
              'SPY', 'SPY_ret', 'target_60d']].dropna()

# Current system: binary 0/1 signals, equal weight
# Regime: 0 active = LONG, 1 = CAUTIOUS, 2+ = RISK-OFF
current_score = bt['KS1'] + bt['KS2'] + bt['KS3'] + bt['KS4']
current_regime_cautious = (current_score >= 1).astype(float)
current_regime_risk_off = (current_score >= 2).astype(float)

# Normalize continuous signals to [0,1] range using percentile ranks
def pct_rank_signal(s, direction=1):
    """Rank signal to [0,1]. direction=1: higher=worse, direction=-1: lower=worse."""
    ranked = s.rank(pct=True)
    if direction == -1:
        return 1 - ranked
    return ranked

ks1_norm = pct_rank_signal(bt['KS1_raw'], direction=1)
ks2_norm = bt['KS2'].copy()  # already binary
ks3_norm = pct_rank_signal(bt['KS3_zscore'], direction=-1)  # lower zscore = worse
ks4_norm = pct_rank_signal(bt['KS4_yoy'], direction=-1)   # lower growth = worse
spread_norm = pct_rank_signal(bt['Spread_zscore'], direction=1)
vix_norm = pct_rank_signal(bt['VIX'], direction=1)

signals_matrix = np.column_stack([ks1_norm, ks2_norm, ks3_norm, ks4_norm, spread_norm, vix_norm])

# Weighted composite (only original 4 KS signals for fair comparison)
w4 = weights[:4] / weights[:4].sum()  # renormalize 4-signal weights
s4_matrix = np.column_stack([ks1_norm, ks2_norm, ks3_norm, ks4_norm])
weighted_score_4 = s4_matrix @ w4

# Full 6-signal composite
weighted_score_6 = signals_matrix @ weights

# Define risk-off threshold: above 65th percentile of score distribution
thresh_4 = np.percentile(weighted_score_4, 65)
thresh_6 = np.percentile(weighted_score_6, 65)

weighted_regime_4 = (weighted_score_4 > thresh_4).astype(float)
weighted_regime_6 = (weighted_score_6 > thresh_6).astype(float)

# Strategy returns: when in risk-off, hold cash (0% return); otherwise hold SPY
spy_ret = bt['SPY_ret'].fillna(0)

strat_current = np.where(current_regime_risk_off > 0, 0, spy_ret)
strat_w4 = np.where(weighted_regime_4 > 0, 0, spy_ret)
strat_w6 = np.where(weighted_regime_6 > 0, 0, spy_ret)
buyhold = spy_ret.values

def compute_stats(returns, label):
    cum = (1 + pd.Series(returns)).cumprod()
    total_ret = cum.iloc[-1] - 1
    ann_ret = (1 + total_ret) ** (252/len(returns)) - 1
    ann_vol = pd.Series(returns).std() * np.sqrt(252)
    sharpe = ann_ret / ann_vol if ann_vol > 0 else 0
    rolling_max = cum.cummax()
    dd = (cum - rolling_max) / rolling_max
    max_dd = dd.min()
    calmar = ann_ret / abs(max_dd) if max_dd != 0 else 0
    return {'Label': label, 'Total Return': f"{total_ret:.1%}", 
            'Ann. Return': f"{ann_ret:.1%}", 'Ann. Vol': f"{ann_vol:.1%}",
            'Sharpe': f"{sharpe:.2f}", 'Max Drawdown': f"{max_dd:.1%}",
            'Calmar': f"{calmar:.2f}"}

stats_list = [
    compute_stats(buyhold, 'Buy & Hold SPY'),
    compute_stats(strat_current, 'Current System (Equal-Weight Binary)'),
    compute_stats(strat_w4, 'Weighted Composite (4 signals)'),
    compute_stats(strat_w6, 'Weighted Composite (6 signals)'),
]

stats_df = pd.DataFrame(stats_list)
print(stats_df.to_string(index=False))
stats_df.to_csv(f"{OUT_DIR}/backtest_stats.csv", index=False)

# ============================================================
# 9. VISUALIZATIONS
# ============================================================
print("\n=== Generating Charts ===")

plt.style.use('dark_background')
COLORS = {
    'bg': '#0a0f1e',
    'panel': '#111827',
    'blue': '#3b82f6',
    'green': '#22c55e',
    'red': '#ef4444',
    'yellow': '#eab308',
    'purple': '#a855f7',
    'cyan': '#06b6d4',
    'text': '#e5e7eb',
    'muted': '#6b7280',
}

# --- CHART 1: Signal Weights Comparison ---
fig, axes = plt.subplots(1, 3, figsize=(18, 6), facecolor=COLORS['bg'])
fig.suptitle('Evidence-Based Signal Weight Derivation', 
             fontsize=16, color=COLORS['text'], fontweight='bold', y=1.02)

# Subplot 1: Final weights
ax = axes[0]
ax.set_facecolor(COLORS['panel'])
short_names = ['KS1\nHY Spread', 'KS2\nJoint Sell', 'KS3\nReal Rate', 
               'KS4\nBank Credit', 'IG/HY\nDiff', 'VIX']
bar_colors = [COLORS['blue'], COLORS['cyan'], COLORS['yellow'], 
              COLORS['purple'], COLORS['green'], COLORS['red']]
bars = ax.barh(short_names, weights * 100, color=bar_colors, alpha=0.85, height=0.6)
ax.set_xlabel('Weight (%)', color=COLORS['text'])
ax.set_title('Evidence-Based Weights', color=COLORS['text'], fontsize=12)
ax.tick_params(colors=COLORS['text'])
ax.spines['bottom'].set_color(COLORS['muted'])
ax.spines['left'].set_color(COLORS['muted'])
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
for bar, w in zip(bars, weights):
    ax.text(bar.get_width() + 0.3, bar.get_y() + bar.get_height()/2,
            f'{w:.1%}', va='center', color=COLORS['text'], fontsize=10)

# Subplot 2: IC at different horizons
ax = axes[1]
ax.set_facecolor(COLORS['panel'])
ic_20 = [abs(ic_results[k].get('20d IC', 0)) for k in ic_results.keys()]
ic_40 = [abs(ic_results[k].get('40d IC', 0)) for k in ic_results.keys()]
ic_60 = [abs(ic_results[k].get('60d IC', 0)) for k in ic_results.keys()]
x_pos = np.arange(len(ic_results))
w_bar = 0.25
ax.bar(x_pos - w_bar, ic_20, w_bar, label='20d', color=COLORS['blue'], alpha=0.8)
ax.bar(x_pos, ic_40, w_bar, label='40d', color=COLORS['cyan'], alpha=0.8)
ax.bar(x_pos + w_bar, ic_60, w_bar, label='60d', color=COLORS['green'], alpha=0.8)
short_names_ic = ['KS1', 'KS2', 'KS3', 'KS4', 'Spread', 'VIX']
ax.set_xticks(x_pos)
ax.set_xticklabels(short_names_ic, color=COLORS['text'])
ax.set_ylabel('|IC| (Spearman)', color=COLORS['text'])
ax.set_title('Information Coefficients by Horizon', color=COLORS['text'], fontsize=12)
ax.legend(facecolor=COLORS['panel'], edgecolor=COLORS['muted'], labelcolor=COLORS['text'])
ax.tick_params(colors=COLORS['text'])
ax.spines['bottom'].set_color(COLORS['muted'])
ax.spines['left'].set_color(COLORS['muted'])
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
ax.set_facecolor(COLORS['panel'])

# Subplot 3: LR Coefficients with CI
ax = axes[2]
ax.set_facecolor(COLORS['panel'])
y_pos = np.arange(len(feature_names))
ax.barh(y_pos, adj_coefs_pos, color=bar_colors, alpha=0.7, height=0.5)
# CI bars (using absolute value since we sign-corrected)
ci_lo_adj = np.clip(ci_lower * sign_correction, 0, None)
ci_hi_adj = np.abs(ci_upper * sign_correction)
ax.errorbar(adj_coefs_pos, y_pos, 
            xerr=[adj_coefs_pos - ci_lo_adj, ci_hi_adj - adj_coefs_pos],
            fmt='none', color=COLORS['text'], capsize=4, alpha=0.6)
ax.set_yticks(y_pos)
ax.set_yticklabels(short_names_ic, color=COLORS['text'])
ax.set_xlabel('Logistic Coefficient (sign-corrected)', color=COLORS['text'])
ax.set_title('LR Coefficients + 95% CI', color=COLORS['text'], fontsize=12)
ax.tick_params(colors=COLORS['text'])
ax.spines['bottom'].set_color(COLORS['muted'])
ax.spines['left'].set_color(COLORS['muted'])
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
ax.axvline(0, color=COLORS['muted'], linestyle='--', alpha=0.5)

plt.tight_layout(pad=2.0)
plt.savefig(f"{OUT_DIR}/chart1_signal_weights.png", dpi=150, bbox_inches='tight',
            facecolor=COLORS['bg'])
plt.close()
print("Saved chart1_signal_weights.png")

# --- CHART 2: Signal Correlation Heatmap ---
fig, ax = plt.subplots(1, 1, figsize=(9, 7), facecolor=COLORS['bg'])
ax.set_facecolor(COLORS['panel'])
mask = np.zeros_like(corr_matrix.values, dtype=bool)
mask[np.triu_indices_from(mask)] = True
cmap = sns.diverging_palette(10, 220, as_cmap=True)
sns.heatmap(corr_matrix.values, mask=mask, cmap=cmap, center=0, vmin=-1, vmax=1,
            annot=True, fmt='.2f', ax=ax,
            xticklabels=corr_labels, yticklabels=corr_labels,
            annot_kws={'size': 10, 'color': COLORS['text']},
            cbar_kws={'shrink': 0.8})
ax.set_title('Signal Correlation Matrix (Spearman)', color=COLORS['text'], 
             fontsize=14, fontweight='bold', pad=15)
ax.tick_params(colors=COLORS['text'], labelsize=9)
plt.setp(ax.get_xticklabels(), rotation=0)
plt.setp(ax.get_yticklabels(), rotation=0)
plt.tight_layout()
plt.savefig(f"{OUT_DIR}/chart2_correlations.png", dpi=150, bbox_inches='tight',
            facecolor=COLORS['bg'])
plt.close()
print("Saved chart2_correlations.png")

# --- CHART 3: Backtest Equity Curves ---
fig, axes = plt.subplots(2, 1, figsize=(16, 12), facecolor=COLORS['bg'])

# Equity curves
ax = axes[0]
ax.set_facecolor(COLORS['panel'])
base_date = bt.index

cum_bh = (1 + pd.Series(buyhold, index=base_date)).cumprod()
cum_curr = (1 + pd.Series(strat_current, index=base_date)).cumprod()
cum_w4 = (1 + pd.Series(strat_w4, index=base_date)).cumprod()
cum_w6 = (1 + pd.Series(strat_w6, index=base_date)).cumprod()

ax.plot(cum_bh.index, cum_bh.values, color=COLORS['muted'], lw=1.5, label='Buy & Hold SPY', alpha=0.7)
ax.plot(cum_curr.index, cum_curr.values, color=COLORS['yellow'], lw=1.5, label='Current System (Equal-Weight Binary)', alpha=0.85)
ax.plot(cum_w4.index, cum_w4.values, color=COLORS['cyan'], lw=1.5, label='Weighted Composite (4 signals)')
ax.plot(cum_w6.index, cum_w6.values, color=COLORS['green'], lw=2, label='Weighted Composite (6 signals)')

# Shade major drawdown periods (KS threshold periods)
risk_off_periods = pd.Series(current_regime_risk_off.values, index=base_date)
prev = 0
for i in range(len(risk_off_periods)):
    curr_val = risk_off_periods.iloc[i]
    if curr_val == 1 and prev == 0:
        start = risk_off_periods.index[i]
    elif curr_val == 0 and prev == 1:
        end = risk_off_periods.index[i-1]
        ax.axvspan(start, end, alpha=0.1, color=COLORS['red'])
    prev = curr_val

ax.set_title('Backtest Equity Curves: Kill Switch Systems Compared', 
             color=COLORS['text'], fontsize=14, fontweight='bold')
ax.set_ylabel('Portfolio Value (start = 1.0)', color=COLORS['text'])
ax.legend(facecolor=COLORS['panel'], edgecolor=COLORS['muted'], 
          labelcolor=COLORS['text'], fontsize=10)
ax.tick_params(colors=COLORS['text'])
ax.spines['bottom'].set_color(COLORS['muted'])
ax.spines['left'].set_color(COLORS['muted'])
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
ax.set_yscale('log')

# Drawdown chart
ax2 = axes[1]
ax2.set_facecolor(COLORS['panel'])

def rolling_drawdown(returns):
    cum = (1 + pd.Series(returns)).cumprod()
    peak = cum.cummax()
    return (cum - peak) / peak

dd_bh = rolling_drawdown(buyhold)
dd_curr = rolling_drawdown(strat_current)
dd_w4 = rolling_drawdown(strat_w4)
dd_w6 = rolling_drawdown(strat_w6)

ax2.plot(base_date, dd_bh.values * 100, color=COLORS['muted'], lw=1, alpha=0.7, label='Buy & Hold')
ax2.plot(base_date, dd_curr.values * 100, color=COLORS['yellow'], lw=1.2, label='Current System', alpha=0.85)
ax2.plot(base_date, dd_w4.values * 100, color=COLORS['cyan'], lw=1.2, label='Weighted (4 sig)')
ax2.plot(base_date, dd_w6.values * 100, color=COLORS['green'], lw=1.5, label='Weighted (6 sig)')
ax2.fill_between(base_date, dd_bh.values * 100, 0, alpha=0.1, color=COLORS['muted'])
ax2.set_title('Rolling Drawdown (%)', color=COLORS['text'], fontsize=13, fontweight='bold')
ax2.set_ylabel('Drawdown (%)', color=COLORS['text'])
ax2.legend(facecolor=COLORS['panel'], edgecolor=COLORS['muted'],
           labelcolor=COLORS['text'], fontsize=10)
ax2.tick_params(colors=COLORS['text'])
ax2.spines['bottom'].set_color(COLORS['muted'])
ax2.spines['left'].set_color(COLORS['muted'])
ax2.spines['top'].set_visible(False)
ax2.spines['right'].set_visible(False)
ax2.axhline(0, color=COLORS['muted'], lw=0.5, alpha=0.5)

plt.tight_layout(pad=2.0)
plt.savefig(f"{OUT_DIR}/chart3_backtest.png", dpi=150, bbox_inches='tight',
            facecolor=COLORS['bg'])
plt.close()
print("Saved chart3_backtest.png")

# --- CHART 4: Signal vs Forward Drawdown (scatter/violin) ---
fig, axes = plt.subplots(2, 3, figsize=(18, 10), facecolor=COLORS['bg'])
axes = axes.flatten()

signal_pairs = [
    ('KS1_raw', 'HY Spread (% below 52w high)', COLORS['blue']),
    ('KS3_zscore', 'Real Rate Z-Score', COLORS['yellow']),
    ('KS4_yoy', 'Bank Credit YoY%', COLORS['purple']),
    ('Spread_zscore', 'IG/HY Diff Z-Score', COLORS['green']),
    ('VIX', 'VIX Level', COLORS['red']),
    ('KS2', 'Joint Selloff (rolling)', COLORS['cyan']),
]

for ax, (col, label, color) in zip(axes, signal_pairs):
    ax.set_facecolor(COLORS['panel'])
    merged = signals[[col, 'dd_60d']].dropna()
    if len(merged) < 50:
        continue
    # Bin the signal into quintiles
    try:
        signal_quintile = pd.qcut(merged[col], q=5, labels=False, duplicates='drop')
        grouped_dd = merged.groupby(signal_quintile)['dd_60d'].mean() * 100
        ax.bar(grouped_dd.index, grouped_dd.values, color=color, alpha=0.7, width=0.6)
        ax.axhline(merged['dd_60d'].mean() * 100, color=COLORS['text'], 
                   lw=1, ls='--', alpha=0.6, label='Avg')
    except Exception:
        ax.scatter(merged[col], merged['dd_60d'] * 100, alpha=0.15, s=5, color=color)
    
    ax.set_title(label, color=COLORS['text'], fontsize=11)
    ax.set_xlabel('Signal Quintile / Value', color=COLORS['text'], fontsize=9)
    ax.set_ylabel('Avg 60d Max Drawdown (%)', color=COLORS['text'], fontsize=9)
    ax.tick_params(colors=COLORS['text'])
    ax.spines['bottom'].set_color(COLORS['muted'])
    ax.spines['left'].set_color(COLORS['muted'])
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)

fig.suptitle('Signal Quintile vs Forward SPY Max Drawdown (60 days)', 
             fontsize=15, color=COLORS['text'], fontweight='bold', y=1.01)
plt.tight_layout(pad=2.0)
plt.savefig(f"{OUT_DIR}/chart4_signal_vs_drawdown.png", dpi=150, bbox_inches='tight',
            facecolor=COLORS['bg'])
plt.close()
print("Saved chart4_signal_vs_drawdown.png")

# ============================================================
# 10. SAVE SUMMARY REPORT
# ============================================================
print("\n=== Saving Summary ===")

summary = f"""
SIGNAL BACKTESTING RESULTS
===========================
Data: {len(bt)} trading days ({bt.index[0].date()} → {bt.index[-1].date()})
OOS AUC (60d horizon): {np.mean(oos_aucs):.3f} ± {np.std(oos_aucs):.3f}
OOS Brier Score: {np.mean(oos_briefs):.3f}

EVIDENCE-BASED WEIGHTS
======================
Signal               LR Coef    IC(60d)   Final Weight
{'─'*55}"""

for i, name in enumerate(signal_names_short):
    summary += f"\n{name:<22} {adj_coefs_pos[i]:.3f}      {ic_vals[i]:.4f}    {weights[i]:.1%}"

summary += f"""

CORRELATION INSIGHTS
====================
{corr_matrix.round(2).to_string()}

BACKTEST PERFORMANCE
====================
{stats_df.to_string(index=False)}

CURRENT WEIGHTS VS EVIDENCE-BASED
===================================
Signal          Current    Evidence-Based  Delta
{'─'*55}
KS1 (HY Spread)     25%     {weights[0]:.1%}           {weights[0]-0.25:+.1%}
KS2 (Joint Sell)    25%     {weights[1]:.1%}           {weights[1]-0.25:+.1%}
KS3 (Real Rate)     25%     {weights[2]:.1%}           {weights[2]-0.25:+.1%}
KS4 (Bank Credit)   25%     {weights[3]:.1%}           {weights[3]-0.25:+.1%}
"""

with open(f"{OUT_DIR}/backtest_summary.txt", 'w') as f:
    f.write(summary)

print(summary)
print(f"\nAll outputs saved to {OUT_DIR}/")
print("Files: prices_raw.csv, totbkcr_raw.csv, evidence_weights.csv,")
print("       backtest_stats.csv, signal_correlations.csv, backtest_summary.txt")
print("       chart1_signal_weights.png, chart2_correlations.png,")
print("       chart3_backtest.png, chart4_signal_vs_drawdown.png")
