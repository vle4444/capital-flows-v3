"""
Chart generation only — all data already computed.
"""

import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns
from scipy import stats
import warnings
warnings.filterwarnings('ignore')
import os

OUT_DIR = "/home/user/workspace/signal_backtest"

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

# ---- Hardcoded results from analysis run ----
signal_names_short = ['KS1 (HY Spread)', 'KS2 (Joint Selloff)', 'KS3 (Real Rate)', 
                       'KS4 (Bank Credit)', 'IG/HY Differential', 'VIX']
short_names_ic = ['KS1', 'KS2', 'KS3', 'KS4', 'IG/HY', 'VIX']

weights = np.array([0.202, 0.146, 0.144, 0.066, 0.074, 0.369])
adj_coefs_pos = np.array([0.282, 0.029, 0.232, 0.000, 0.000, 0.429])

# IC results
ic_20 = np.array([0.0583, 0.0484, 0.0059, 0.0617, 0.0678, 0.1464])
ic_40 = np.array([0.0536, 0.0446, 0.0012, 0.0669, 0.0665, 0.1717])
ic_60 = np.array([0.0543, 0.0455, 0.0197, 0.0787, 0.0157, 0.1921])

# 95% CI (approximate from bootstrap)
ci_lower = np.array([0.101, -0.066, 0.112, 0.0, 0.020, 0.220])  # sign-corrected
ci_upper = np.array([0.473, 0.109, 0.358, 0.156, 0.251, 0.621])

# Correlation matrix
corr_data_vals = np.array([
    [1.000, 0.126, 0.016, 0.298, 0.070, 0.559],
    [0.126, 1.000, 0.085, 0.091, 0.086, 0.132],
    [0.016, 0.085, 1.000, -0.023, 0.407, 0.042],
    [0.298, 0.091, -0.023, 1.000, -0.036, 0.122],
    [0.070, 0.086, 0.407, -0.036, 1.000, 0.032],
    [0.559, 0.132, 0.042, 0.122, 0.032, 1.000],
])
corr_labels = ['KS1\n(HY spread)', 'KS2\n(Joint selloff)', 'KS3\n(Real rate)', 
               'KS4\n(Bank credit)', 'IG/HY\nDiff', 'VIX']

# Backtest stats
backtest_labels = ['Buy &\nHold', 'Current\nSystem', 'Weighted\n(4 sig)', 'Weighted\n(6 sig)']
total_returns = [7.083, 13.223, 21.666, 76.729]
ann_returns = [12.7, 16.3, 19.5, 28.2]
sharpes = [0.64, 0.94, 1.44, 3.22]
max_dds = [-44.7, -38.2, -33.6, -5.1]
calmars = [0.28, 0.43, 0.58, 5.56]
bar_colors_bt = [COLORS['muted'], COLORS['yellow'], COLORS['cyan'], COLORS['green']]


# ============================================================
# CHART 1: Signal Weights + IC + LR Coefficients
# ============================================================
fig, axes = plt.subplots(1, 3, figsize=(20, 7), facecolor=COLORS['bg'])
fig.suptitle('Evidence-Based Signal Weight Derivation — Kill Switch System', 
             fontsize=15, color=COLORS['text'], fontweight='bold', y=1.02)

bar_colors = [COLORS['blue'], COLORS['cyan'], COLORS['yellow'], 
              COLORS['purple'], COLORS['green'], COLORS['red']]

# Subplot 1: Final weights
ax = axes[0]
ax.set_facecolor(COLORS['panel'])
bars = ax.barh(short_names_ic[::-1], weights[::-1] * 100, 
               color=bar_colors[::-1], alpha=0.85, height=0.55)
ax.set_xlabel('Weight (%)', color=COLORS['text'], fontsize=11)
ax.set_title('Evidence-Based Weights', color=COLORS['text'], fontsize=13, fontweight='bold')
ax.tick_params(colors=COLORS['text'])
for sp in ['top','right']: ax.spines[sp].set_visible(False)
for sp in ['bottom','left']: ax.spines[sp].set_color(COLORS['muted'])
for bar, w in zip(bars, weights[::-1]):
    ax.text(bar.get_width() + 0.4, bar.get_y() + bar.get_height()/2,
            f'{w:.1%}', va='center', color=COLORS['text'], fontsize=11, fontweight='bold')
ax.set_xlim(0, 45)

# Subplot 2: IC at different horizons
ax = axes[1]
ax.set_facecolor(COLORS['panel'])
x_pos = np.arange(6)
w_bar = 0.26
ax.bar(x_pos - w_bar, ic_20, w_bar, label='20d (~4 weeks)', color=COLORS['blue'], alpha=0.8)
ax.bar(x_pos, ic_40, w_bar, label='40d (~8 weeks)', color=COLORS['cyan'], alpha=0.8)
ax.bar(x_pos + w_bar, ic_60, w_bar, label='60d (~12 weeks)', color=COLORS['green'], alpha=0.8)
ax.set_xticks(x_pos)
ax.set_xticklabels(short_names_ic, color=COLORS['text'], fontsize=10)
ax.set_ylabel('|IC| (Spearman rank correlation)', color=COLORS['text'], fontsize=10)
ax.set_title('Information Coefficients by Horizon', color=COLORS['text'], fontsize=13, fontweight='bold')
ax.legend(facecolor=COLORS['panel'], edgecolor=COLORS['muted'], 
          labelcolor=COLORS['text'], fontsize=9)
ax.tick_params(colors=COLORS['text'])
for sp in ['top','right']: ax.spines[sp].set_visible(False)
for sp in ['bottom','left']: ax.spines[sp].set_color(COLORS['muted'])
# Significance line
ax.axhline(0.05, color=COLORS['yellow'], lw=1, ls='--', alpha=0.6)
ax.text(5.5, 0.051, 'sig.', color=COLORS['yellow'], fontsize=8, va='bottom')

# Subplot 3: LR Coefficients with CI
ax = axes[2]
ax.set_facecolor(COLORS['panel'])
y_pos = np.arange(6)
ax.barh(y_pos, adj_coefs_pos, color=bar_colors, alpha=0.75, height=0.5)
# CI error bars — ensure non-negative
xerr_lo = np.maximum(adj_coefs_pos - ci_lower, 0)
xerr_hi = np.maximum(ci_upper - adj_coefs_pos, 0)
ax.errorbar(adj_coefs_pos, y_pos, 
            xerr=[xerr_lo, xerr_hi],
            fmt='none', color=COLORS['text'], capsize=5, capthick=1.5, elinewidth=1.5, alpha=0.7)
ax.set_yticks(y_pos)
ax.set_yticklabels(short_names_ic, color=COLORS['text'], fontsize=10)
ax.set_xlabel('Logistic Coefficient (sign-corrected, standardized)', color=COLORS['text'], fontsize=10)
ax.set_title('LR Coefficients + 95% CI\n(Bootstrap, N=500)', color=COLORS['text'], fontsize=13, fontweight='bold')
ax.tick_params(colors=COLORS['text'])
for sp in ['top','right']: ax.spines[sp].set_visible(False)
for sp in ['bottom','left']: ax.spines[sp].set_color(COLORS['muted'])
ax.axvline(0, color=COLORS['muted'], linestyle='--', alpha=0.5)
# Mark significant ones
for i, (lo, hi) in enumerate(zip(ci_lower, ci_upper)):
    if lo > 0 or hi < 0:
        ax.text(0.01, i + 0.22, '●', color=COLORS['green'], fontsize=10)

plt.tight_layout(pad=2.5)
plt.savefig(f"{OUT_DIR}/chart1_signal_weights.png", dpi=150, bbox_inches='tight',
            facecolor=COLORS['bg'])
plt.close()
print("Saved chart1_signal_weights.png")


# ============================================================
# CHART 2: Correlation Heatmap
# ============================================================
fig, ax = plt.subplots(1, 1, figsize=(9, 7), facecolor=COLORS['bg'])
ax.set_facecolor(COLORS['panel'])
mask = np.triu(np.ones_like(corr_data_vals, dtype=bool))
cmap = sns.diverging_palette(10, 220, as_cmap=True)
hm = sns.heatmap(corr_data_vals, mask=mask, cmap=cmap, center=0, vmin=-1, vmax=1,
            annot=True, fmt='.2f', ax=ax,
            xticklabels=corr_labels, yticklabels=corr_labels,
            annot_kws={'size': 11, 'color': 'white', 'fontweight': 'bold'},
            cbar_kws={'shrink': 0.8})

# Set text colors for diagonal  
ax.set_title('Signal Correlation Matrix (Spearman)\nLow correlation = each signal adds independent information', 
             color=COLORS['text'], fontsize=13, fontweight='bold', pad=15)
ax.tick_params(colors=COLORS['text'], labelsize=10)
ax.figure.axes[-1].tick_params(colors=COLORS['text'])
plt.setp(ax.get_xticklabels(), rotation=0, color=COLORS['text'])
plt.setp(ax.get_yticklabels(), rotation=0, color=COLORS['text'])

# Highlight high correlations
# KS1-VIX: 0.559 (high) and KS3-Spread: 0.407 (moderate)
ax.add_patch(plt.Rectangle((0, 0), 1, 6, fill=False, edgecolor='none'))

plt.tight_layout()
plt.savefig(f"{OUT_DIR}/chart2_correlations.png", dpi=150, bbox_inches='tight',
            facecolor=COLORS['bg'])
plt.close()
print("Saved chart2_correlations.png")


# ============================================================
# CHART 3: Backtest Performance Comparison (bar charts)
# ============================================================
fig, axes = plt.subplots(2, 2, figsize=(16, 12), facecolor=COLORS['bg'])
fig.suptitle('Backtest Performance: Equal-Weight Binary vs Weighted Composite', 
             fontsize=15, color=COLORS['text'], fontweight='bold', y=1.01)

metrics = [
    ('Annualized Return (%)', ann_returns, axes[0,0]),
    ('Sharpe Ratio', sharpes, axes[0,1]),
    ('Max Drawdown (%)', [abs(x) for x in max_dds], axes[1,0]),
    ('Calmar Ratio', calmars, axes[1,1]),
]

for label, vals, ax in metrics:
    ax.set_facecolor(COLORS['panel'])
    bars = ax.bar(backtest_labels, vals, color=bar_colors_bt, alpha=0.85, width=0.55,
                  edgecolor='none')
    ax.set_title(label, color=COLORS['text'], fontsize=13, fontweight='bold')
    ax.tick_params(colors=COLORS['text'], labelsize=10)
    for sp in ['top','right']: ax.spines[sp].set_visible(False)
    for sp in ['bottom','left']: ax.spines[sp].set_color(COLORS['muted'])
    for bar, v in zip(bars, vals):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + max(vals)*0.02,
                f'{v:.2f}' if v < 10 else f'{v:.1f}', 
                ha='center', va='bottom', color=COLORS['text'], fontsize=11, fontweight='bold')
    # Highlight best
    best_idx = np.argmax(vals)
    bars[best_idx].set_edgecolor(COLORS['text'])
    bars[best_idx].set_linewidth(2)

# Add note on Max DD: lower is better
axes[1,0].set_title('Max Drawdown (%) — lower is better', color=COLORS['text'], 
                     fontsize=13, fontweight='bold')

plt.tight_layout(pad=2.5)
plt.savefig(f"{OUT_DIR}/chart3_backtest_bars.png", dpi=150, bbox_inches='tight',
            facecolor=COLORS['bg'])
plt.close()
print("Saved chart3_backtest_bars.png")


# ============================================================
# CHART 4: Signal Activation Rates + Concordance
# ============================================================
fig, axes = plt.subplots(1, 2, figsize=(16, 7), facecolor=COLORS['bg'])
fig.suptitle('Signal Diagnostics', fontsize=15, color=COLORS['text'], 
             fontweight='bold', y=1.01)

# Subplot 1: Activation rates
ax = axes[0]
ax.set_facecolor(COLORS['panel'])
signal_names_diag = ['KS1\n(HY Spread)', 'KS2\n(Joint Sell)', 'KS3\n(Real Rate)', 
                     'KS4\n(Bank Credit)', 'IG/HY\nDiff', 'VIX\n>25']
rates = [16.3, 0.6, 7.4, 5.1, 7.0, 18.4]
colors_diag = bar_colors

bars = ax.bar(signal_names_diag, rates, color=colors_diag, alpha=0.85, width=0.6)
ax.set_ylabel('% of Trading Days Active', color=COLORS['text'], fontsize=11)
ax.set_title('Signal Activation Rates\n(2007–2026, ~4,800 days)', 
             color=COLORS['text'], fontsize=13, fontweight='bold')
ax.tick_params(colors=COLORS['text'])
for sp in ['top','right']: ax.spines[sp].set_visible(False)
for sp in ['bottom','left']: ax.spines[sp].set_color(COLORS['muted'])
for bar, v in zip(bars, rates):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.2,
            f'{v:.1f}%', ha='center', va='bottom', color=COLORS['text'], fontsize=11)

# Subplot 2: Weight comparison — current vs evidence-based
ax = axes[1]
ax.set_facecolor(COLORS['panel'])
current_weights = [25.0, 25.0, 25.0, 25.0, 0.0, 0.0]
evidence_weights = weights * 100

x_pos = np.arange(6)
w_bar = 0.35
bars1 = ax.bar(x_pos - w_bar/2, current_weights, w_bar, 
               label='Current (equal-weight)', color=COLORS['yellow'], alpha=0.7)
bars2 = ax.bar(x_pos + w_bar/2, evidence_weights, w_bar, 
               label='Evidence-Based', color=COLORS['green'], alpha=0.85)

ax.set_xticks(x_pos)
ax.set_xticklabels(short_names_ic, color=COLORS['text'], fontsize=10)
ax.set_ylabel('Weight (%)', color=COLORS['text'], fontsize=11)
ax.set_title('Current vs Evidence-Based Weights', 
             color=COLORS['text'], fontsize=13, fontweight='bold')
ax.legend(facecolor=COLORS['panel'], edgecolor=COLORS['muted'], 
          labelcolor=COLORS['text'], fontsize=10)
ax.tick_params(colors=COLORS['text'])
for sp in ['top','right']: ax.spines[sp].set_visible(False)
for sp in ['bottom','left']: ax.spines[sp].set_color(COLORS['muted'])

plt.tight_layout(pad=2.5)
plt.savefig(f"{OUT_DIR}/chart4_diagnostics.png", dpi=150, bbox_inches='tight',
            facecolor=COLORS['bg'])
plt.close()
print("Saved chart4_diagnostics.png")


# ============================================================
# CHART 5: Equity Curves from saved price data
# ============================================================
prices = pd.read_csv(f"{OUT_DIR}/prices_raw.csv", index_col=0, parse_dates=True)
prices.columns = [c.replace('^','') for c in prices.columns]
fred_df = pd.read_csv(f"{OUT_DIR}/totbkcr_raw.csv", 
                       names=['date','TOTBKCR'], skiprows=1, parse_dates=['date'])
fred_df.set_index('date', inplace=True)

spy = prices['SPY'].dropna()
hyg = prices['HYG'].dropna()
lqd = prices['LQD'].dropna()
vix = prices['VIX'].dropna()
tip = prices['TIP'].dropna()
totbkcr = fred_df['TOTBKCR'].reindex(prices.index, method='ffill')

common_start = hyg.index[0]
idx = spy.index[spy.index >= common_start]
spy = spy.reindex(idx)
hyg = hyg.reindex(idx)
lqd = lqd.reindex(idx)
vix = vix.reindex(idx)
tip = tip.reindex(idx)
totbkcr = totbkcr.reindex(idx, method='ffill')

spy_ret = spy.pct_change()
hyg_ret = hyg.pct_change()
lqd_ret = lqd.pct_change()

# Recompute signals
hyg_52wk_high = hyg.rolling(252).max()
ks1_raw = (hyg_52wk_high - hyg) / hyg_52wk_high * 100
ks1_signal = (ks1_raw > 5).astype(float)
joint_selloff = ((hyg_ret < -0.015) & (spy_ret < -0.015)).astype(float)
ks2_signal = (joint_selloff.rolling(3).sum() >= 2).astype(float)
tlt_60 = prices['TLT'].reindex(idx).pct_change(60)
tip_60 = tip.pct_change(60)
ks3_raw_diff = tlt_60 - tip_60
ks3_zscore = (ks3_raw_diff - ks3_raw_diff.rolling(252).mean()) / ks3_raw_diff.rolling(252).std()
ks3_signal = (ks3_zscore < -1.5).astype(float)
totbkcr_yoy = totbkcr.pct_change(365) * 100
ks4_signal = (totbkcr_yoy < 0).astype(float)
lqd_hyg_spread = lqd_ret.rolling(20).mean() - hyg_ret.rolling(20).mean()
lqd_hyg_zscore = (lqd_hyg_spread - lqd_hyg_spread.rolling(252).mean()) / lqd_hyg_spread.rolling(252).std()

sigs = pd.DataFrame({
    'KS1_raw': ks1_raw, 'KS1': ks1_signal, 'KS2': ks2_signal,
    'KS3_zscore': ks3_zscore, 'KS3': ks3_signal,
    'KS4_yoy': totbkcr_yoy, 'KS4': ks4_signal,
    'Spread_zscore': lqd_hyg_zscore,
    'VIX': vix, 'SPY': spy, 'SPY_ret': spy_ret
}, index=idx).dropna()

# Normalize signals to [0,1] percentile rank
def pct_rank(s, direction=1):
    r = s.rank(pct=True)
    return r if direction == 1 else 1 - r

ks1_norm = pct_rank(sigs['KS1_raw'], 1)
ks2_norm = sigs['KS2'].copy()
ks3_norm = pct_rank(sigs['KS3_zscore'], -1)
ks4_norm = pct_rank(sigs['KS4_yoy'], -1)
spread_norm = pct_rank(sigs['Spread_zscore'], 1)
vix_norm = pct_rank(sigs['VIX'], 1)

w4 = weights[:4] / weights[:4].sum()
w6 = weights
s4_matrix = np.column_stack([ks1_norm, ks2_norm, ks3_norm, ks4_norm])
s6_matrix = np.column_stack([ks1_norm, ks2_norm, ks3_norm, ks4_norm, spread_norm, vix_norm])

weighted_score_4 = s4_matrix @ w4
weighted_score_6 = s6_matrix @ w6
current_score = sigs['KS1'] + sigs['KS2'] + sigs['KS3'] + sigs['KS4']
current_risk_off = (current_score >= 2).astype(float)

thresh_4 = np.percentile(weighted_score_4, 65)
thresh_6 = np.percentile(weighted_score_6, 65)
weighted_regime_4 = (weighted_score_4 > thresh_4).astype(float)
weighted_regime_6 = (weighted_score_6 > thresh_6).astype(float)

spy_ret_s = sigs['SPY_ret'].fillna(0)
strat_bh = spy_ret_s.values
strat_curr = np.where(current_risk_off > 0, 0, spy_ret_s)
strat_w4 = np.where(weighted_regime_4 > 0, 0, spy_ret_s)
strat_w6 = np.where(weighted_regime_6 > 0, 0, spy_ret_s)

cum_bh = (1 + pd.Series(strat_bh, index=sigs.index)).cumprod()
cum_curr = (1 + pd.Series(strat_curr, index=sigs.index)).cumprod()
cum_w4 = (1 + pd.Series(strat_w4, index=sigs.index)).cumprod()
cum_w6 = (1 + pd.Series(strat_w6, index=sigs.index)).cumprod()

fig, axes = plt.subplots(3, 1, figsize=(18, 14), facecolor=COLORS['bg'],
                          gridspec_kw={'height_ratios': [3, 2, 1]})

# Equity curves
ax = axes[0]
ax.set_facecolor(COLORS['panel'])
ax.plot(cum_bh.index, cum_bh.values, color=COLORS['muted'], lw=1.5, 
        label='Buy & Hold SPY', alpha=0.8)
ax.plot(cum_curr.index, cum_curr.values, color=COLORS['yellow'], lw=1.8, 
        label=f'Current System  [Sharpe 0.94]', alpha=0.9)
ax.plot(cum_w4.index, cum_w4.values, color=COLORS['cyan'], lw=1.8, 
        label=f'Weighted Composite (4 sig)  [Sharpe 1.44]')
ax.plot(cum_w6.index, cum_w6.values, color=COLORS['green'], lw=2.2, 
        label=f'Weighted Composite (6 sig)  [Sharpe 3.22]')

# Shade risk-off periods
prev = 0
start = None
for i, v in enumerate(current_risk_off):
    if v == 1 and prev == 0:
        start = current_risk_off.index[i]
    elif v == 0 and prev == 1 and start is not None:
        ax.axvspan(start, current_risk_off.index[i-1], alpha=0.08, color=COLORS['red'])
    prev = v

ax.set_title('Kill Switch System: Equity Curves (Log Scale)\n2007–2026, Cash = 0% during risk-off', 
             color=COLORS['text'], fontsize=14, fontweight='bold')
ax.set_ylabel('Portfolio Value (1.0 = start)', color=COLORS['text'], fontsize=11)
ax.legend(facecolor=COLORS['panel'], edgecolor=COLORS['muted'], 
          labelcolor=COLORS['text'], fontsize=11)
ax.tick_params(colors=COLORS['text'])
for sp in ['top','right']: ax.spines[sp].set_visible(False)
for sp in ['bottom','left']: ax.spines[sp].set_color(COLORS['muted'])
ax.set_yscale('log')
ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x:.0f}x'))

# Drawdown
ax2 = axes[1]
ax2.set_facecolor(COLORS['panel'])
def dd_series(returns):
    cum = (1 + pd.Series(returns)).cumprod()
    peak = cum.cummax()
    return (cum - peak) / peak * 100

ax2.plot(sigs.index, dd_series(strat_bh).values, color=COLORS['muted'], lw=1.2, alpha=0.7, label='Buy & Hold')
ax2.plot(sigs.index, dd_series(strat_curr).values, color=COLORS['yellow'], lw=1.5, label='Current System', alpha=0.9)
ax2.plot(sigs.index, dd_series(strat_w4).values, color=COLORS['cyan'], lw=1.5, label='Weighted (4 sig)')
ax2.plot(sigs.index, dd_series(strat_w6).values, color=COLORS['green'], lw=2, label='Weighted (6 sig)')
ax2.fill_between(sigs.index, dd_series(strat_bh).values, 0, alpha=0.08, color=COLORS['muted'])
ax2.set_title('Rolling Drawdown (%)', color=COLORS['text'], fontsize=13, fontweight='bold')
ax2.set_ylabel('Drawdown (%)', color=COLORS['text'], fontsize=11)
ax2.legend(facecolor=COLORS['panel'], edgecolor=COLORS['muted'], labelcolor=COLORS['text'], fontsize=10)
ax2.tick_params(colors=COLORS['text'])
for sp in ['top','right']: ax2.spines[sp].set_visible(False)
for sp in ['bottom','left']: ax2.spines[sp].set_color(COLORS['muted'])
ax2.axhline(0, color=COLORS['muted'], lw=0.5, alpha=0.5)

# Composite score
ax3 = axes[2]
ax3.set_facecolor(COLORS['panel'])
ax3.fill_between(sigs.index, weighted_score_6, alpha=0.6, color=COLORS['purple'])
ax3.plot(sigs.index, weighted_score_6, color=COLORS['purple'], lw=0.8)
ax3.axhline(thresh_6, color=COLORS['red'], lw=1.5, ls='--', alpha=0.8, label='Risk-off threshold')
ax3.set_title('Weighted Composite Score (6 signals)', color=COLORS['text'], fontsize=12, fontweight='bold')
ax3.set_ylabel('Score', color=COLORS['text'], fontsize=10)
ax3.legend(facecolor=COLORS['panel'], edgecolor=COLORS['muted'], labelcolor=COLORS['text'], fontsize=9)
ax3.tick_params(colors=COLORS['text'])
for sp in ['top','right']: ax3.spines[sp].set_visible(False)
for sp in ['bottom','left']: ax3.spines[sp].set_color(COLORS['muted'])

plt.tight_layout(pad=2.0)
plt.savefig(f"{OUT_DIR}/chart5_equity_curves.png", dpi=150, bbox_inches='tight',
            facecolor=COLORS['bg'])
plt.close()
print("Saved chart5_equity_curves.png")

print("\nAll charts generated successfully.")
