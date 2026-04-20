"""
Step 1: Download all historical data needed for signal backtesting.
Tickers: SPY, HYG, LQD, ^VIX, TLT, VTIP, TIP
FRED: TOTBKCR (bank credit)
Period: 2000-01-01 to 2026-04-16
"""

import yfinance as yf
import pandas as pd
import numpy as np
import requests
import os
import warnings
warnings.filterwarnings('ignore')

OUT_DIR = "/home/user/workspace/signal_backtest"
os.makedirs(OUT_DIR, exist_ok=True)

TICKERS = ["SPY", "HYG", "LQD", "^VIX", "TLT", "VTIP", "TIP", "IWM", "DXY"]
START = "2000-01-01"
END = "2026-04-16"

print("=== Downloading equity/bond/volatility data ===")
raw = yf.download(TICKERS, start=START, end=END, auto_adjust=True, progress=True)

# Extract Adj Close (with auto_adjust=True, Close IS adjusted)
if isinstance(raw.columns, pd.MultiIndex):
    prices = raw["Close"].copy()
else:
    prices = raw[["Close"]].copy()

print(f"\nPrice data shape: {prices.shape}")
print(f"Date range: {prices.index[0].date()} → {prices.index[-1].date()}")
print(f"Columns: {list(prices.columns)}")
print(f"\nNaN counts:\n{prices.isna().sum()}")

prices.to_csv(f"{OUT_DIR}/prices_raw.csv")
print(f"\nSaved to {OUT_DIR}/prices_raw.csv")

# Download TOTBKCR from FRED
print("\n=== Downloading TOTBKCR from FRED ===")
fred_url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=TOTBKCR&cosd=2000-01-01"
try:
    import subprocess
    result = subprocess.run(
        ['curl', '-s', '--max-time', '30', fred_url],
        capture_output=True, text=True
    )
    lines = result.stdout.strip().split('\n')
    fred_df = pd.read_csv(pd.io.common.StringIO(result.stdout), parse_dates=['DATE'])
    fred_df.columns = ['date', 'TOTBKCR']
    fred_df['TOTBKCR'] = pd.to_numeric(fred_df['TOTBKCR'], errors='coerce')
    fred_df = fred_df.dropna()
    fred_df.set_index('date', inplace=True)
    print(f"FRED data: {len(fred_df)} rows, {fred_df.index[0].date()} → {fred_df.index[-1].date()}")
    print(f"Latest: {fred_df['TOTBKCR'].iloc[-1]:.0f}B")
    fred_df.to_csv(f"{OUT_DIR}/totbkcr_raw.csv")
    print(f"Saved to {OUT_DIR}/totbkcr_raw.csv")
except Exception as e:
    print(f"FRED download failed: {e}")

print("\n=== Data download complete ===")
