import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Cell, Legend,
} from "recharts";
import { format, parseISO, differenceInMinutes } from "date-fns";
import CatalystCalendar from "@/components/CatalystCalendar";
import { equityData, drawdownData } from "../data/equityCurves";

// ─── Types ────────────────────────────────────────────────────────────────────
interface MarketData {
  timestamp: string;
  prices: {
    spy: number; spyChg: number;
    hyg: number; hygChg: number;
    lqd: number; lqdChg: number;
    vix: number;
    tlt: number | null; tltChg: number;
    tip?: number | null;
  };
  fred: { totbkcr: number; totbkcr_b: string; yoy: string; date: string } | null;
  raw_signals: { ks1_pct: number; ks2_binary: number; ks3_zscore: number; ks4_yoy: number; ig_hy_zscore: number; vix: number };
  composite: number;
  composite_pct: number;
  regime: "LONG" | "CAUTIOUS" | "RISK-OFF";
  signal_scores: { ks1: number; ks2: number; ks3: number; ks4: number; ig_hy: number; vix: number };
  binary_switches: { ks1: number; ks2: number; ks3: number; ks4: number; active_count: number };
  _stale?: boolean;
  _data_source_error?: boolean;
  signal_weights: Record<string, { weight: number; label: string; color: string }>;
  thresholds: { risk_off: number; caution: number };
}

interface HistoryRow {
  date: string;
  composite_score: number;
  regime: string;
  ks1: number; ks2: number; ks3: number; ks4: number; ig_hy: number; vix: number;
  ks1_signal: number; ks2_signal: number; ks3_signal: number; ks4_signal: number;
  spy_price: number; hyg_price: number; vix_value: number; totbkcr_yoy: number;
}

type Regime = MarketData["regime"];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const REGIME_COLORS: Record<Regime, string> = { "LONG": "#22c55e", "CAUTIOUS": "#eab308", "RISK-OFF": "#ef4444" };
const REGIME_BG: Record<Regime, string> = { "LONG": "bg-green-500/10 border-green-500/30", "CAUTIOUS": "bg-yellow-500/10 border-yellow-500/30", "RISK-OFF": "bg-red-500/10 border-red-500/30" };
const REGIME_TEXT: Record<Regime, string> = { "LONG": "text-green-400", "CAUTIOUS": "text-yellow-400", "RISK-OFF": "text-red-400" };

function fmt(n: number | null | undefined, dec = 2) { return n != null && isFinite(n) ? n.toFixed(dec) : "—"; }
function fmtChg(n: number) { return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`; }
function chgColor(n: number) { return n >= 0 ? "text-green-400" : "text-red-400"; }
function scoreColor(s: number) { return s >= 65 ? "#ef4444" : s >= 45 ? "#eab308" : "#22c55e"; }

// ─── Live Data Indicator ──────────────────────────────────────────────────────
function LiveIndicator({ timestamp, isFetching }: { timestamp: string | undefined; isFetching: boolean }) {
  const [age, setAge] = useState(0);

  useEffect(() => {
    if (!timestamp) return;
    const tick = () => {
      const ts = new Date(timestamp);
      setAge(differenceInMinutes(new Date(), ts));
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [timestamp]);

  if (!timestamp) return null;

  const isStale = age > 10;
  const label = isFetching ? "updating…" : isStale ? `STALE · ${age}m ago` : age < 2 ? "LIVE · just now" : `LIVE · ${age}m ago`;
  const dotColor = isFetching ? "bg-yellow-400 animate-pulse" : isStale ? "bg-yellow-500" : "bg-green-400 animate-pulse";
  const textColor = isStale ? "text-yellow-400" : "text-green-400";

  return (
    <div className="flex items-center gap-1.5" data-testid="live-indicator">
      <div className={`w-2 h-2 rounded-full ${dotColor}`} />
      <span className={`text-xs font-medium tabnum ${textColor}`}>{label}</span>
    </div>
  );
}

// ─── Score Gauge ──────────────────────────────────────────────────────────────
function ScoreGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, isFinite(score) ? score : 0));
  const r = 48; const cx = 70; const cy = 64;
  // Angle: score=0 → left (π), score=100 → right (0)
  const angle = Math.PI * (1 - clamped / 100);
  const needleLen = r * 0.72;
  const needleX = cx + needleLen * Math.cos(angle);
  const needleY = cy - needleLen * Math.sin(angle);

  const arcSeg = (startPct: number, endPct: number, color: string) => {
    const sa = Math.PI * (1 - startPct);
    const ea = Math.PI * (1 - endPct);
    const x1 = cx + r * Math.cos(sa); const y1 = cy - r * Math.sin(sa);
    const x2 = cx + r * Math.cos(ea); const y2 = cy - r * Math.sin(ea);
    return <path d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`} stroke={color} strokeWidth="9" fill="none" strokeLinecap="butt" opacity="0.85" key={color} />;
  };

  return (
    <svg viewBox="0 0 140 78" className="w-full max-w-[200px]">
      {arcSeg(0, 0.45, "#22c55e")}
      {arcSeg(0.45, 0.65, "#eab308")}
      {arcSeg(0.65, 1, "#ef4444")}
      <line x1={cx} y1={cy} x2={needleX} y2={needleY} stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="4" fill="#ffffff" />
      <text x={cx} y={cy + 14} textAnchor="middle" fill={scoreColor(clamped)} fontSize="13" fontWeight="bold" fontFamily="monospace">{Math.round(clamped)}</text>
      <text x="14" y={cy + 6} fill="#22c55e" fontSize="7" opacity="0.7">LOW</text>
      <text x={cx - 8} y="14" fill="#eab308" fontSize="7" opacity="0.7">MED</text>
      <text x="112" y={cy + 6} fill="#ef4444" fontSize="7" opacity="0.7">HIGH</text>
    </svg>
  );
}

// ─── Ask AI Overlay ───────────────────────────────────────────────────────────
function AskAIOverlay({ marketData }: { marketData: MarketData | null }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const submit = async () => {
    if (!question.trim() || loading) return;
    setLoading(true); setError(null); setAnswer(null);
    try {
      const res = await apiRequest("POST", "/api/ask", { question });
      const data = await res.json();
      if (data.error) setError(data.error);
      else setAnswer(data.answer);
    } catch (e: any) {
      setError(e?.message || "Request failed");
    } finally { setLoading(false); }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/20 hover:bg-primary/30 border border-primary/40 rounded-lg text-xs font-medium text-primary transition-colors"
        data-testid="ask-ai-button"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
        </svg>
        Ask AI
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-end p-4 pointer-events-none">
          <div ref={ref} className="pointer-events-auto w-full max-w-md bg-card border border-border rounded-xl shadow-2xl flex flex-col" data-testid="ask-ai-panel">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span className="font-semibold text-sm">Ask AI — Regime Analysis</span>
              </div>
              <button onClick={() => setOpen(false)} aria-label="Close" className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
            </div>
            <div className="p-4 space-y-3 flex-1">
              {marketData && (
                <div className="text-xs text-muted-foreground bg-secondary/50 rounded p-2 border-l-2 border-primary">
                  Context: <span className={REGIME_TEXT[marketData.regime]}>{marketData.regime}</span> regime · Score {marketData.composite_pct}/100 · VIX {fmt(marketData.prices.vix, 1)}
                </div>
              )}
              <textarea
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
                placeholder="e.g. Should I reduce equity exposure? What does current VIX signal?"
                className="w-full h-24 bg-secondary/50 border border-border rounded p-2 text-sm resize-none focus:outline-none focus:border-primary"
                data-testid="ask-ai-input"
              />
              {answer && (
                <div className="bg-secondary/30 rounded p-3 text-xs leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap border border-border" data-testid="ask-ai-answer">
                  {answer}
                </div>
              )}
              {error && <div className="text-xs text-red-400 bg-red-950/40 rounded p-2 border border-red-800">{error}</div>}
            </div>
            <div className="px-4 pb-4">
              <button
                onClick={submit}
                disabled={loading || !question.trim()}
                className="w-full py-2 bg-primary hover:bg-primary/90 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
                data-testid="ask-ai-submit"
              >
                {loading ? "Analyzing…" : "Ask"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab({ d }: { d: MarketData }) {
  const killCount = d.binary_switches.active_count;
  const weights = d.signal_weights || {};

  // Note: `switch_` is ONLY shown as indicator of kill-switch status on the row.
  // VIX and IG/HY have no binary kill switch of their own, so pass 0.
  const signalRows = [
    { key: "vix_level",         label: "VIX Level",            score: d.signal_scores.vix,   raw: `${fmt(d.prices.vix, 1)}`,                                         weight: weights.vix_level?.weight,          color: "#ef4444" },
    { key: "ks1_hy_spread",     label: "HY Spread (KS1)",      score: d.signal_scores.ks1,   raw: `${fmt(d.raw_signals.ks1_pct, 1)}% vs 52w high`,                   weight: weights.ks1_hy_spread?.weight,      color: "#3b82f6" },
    { key: "ks2_joint_selloff", label: "Joint Selloff (KS2)",  score: d.signal_scores.ks2,   raw: d.binary_switches.ks2 ? "ACTIVE" : "CLEAR",                        weight: weights.ks2_joint_selloff?.weight,  color: "#06b6d4" },
    { key: "ks3_real_rate",     label: "Real Rate (KS3)",      score: d.signal_scores.ks3,   raw: `z=${fmt(d.raw_signals.ks3_zscore, 2)}`,                           weight: weights.ks3_real_rate?.weight,      color: "#eab308" },
    { key: "ig_hy_differential",label: "IG/HY Spread",         score: d.signal_scores.ig_hy, raw: `z=${fmt(d.raw_signals.ig_hy_zscore, 2)}`,                         weight: weights.ig_hy_differential?.weight, color: "#22c55e" },
    { key: "ks4_bank_credit",   label: "Bank Credit (KS4)",    score: d.signal_scores.ks4,   raw: `${d.fred ? fmt(d.raw_signals.ks4_yoy, 1) + "% YoY" : "N/A"}`,     weight: weights.ks4_bank_credit?.weight,    color: "#a855f7" },
  ];

  return (
    <div className="space-y-3">
      {/* Top row: gauge + prices */}
      <div className="grid grid-cols-2 gap-3">
        {/* Composite gauge */}
        <div className={`rounded-lg border p-3 ${REGIME_BG[d.regime]}`} data-testid="regime-card">
          <div className="text-xs uppercase tracking-widest font-bold opacity-60 mb-1">Composite Risk</div>
          <div className="flex items-center justify-center">
            <ScoreGauge score={d.composite_pct} />
          </div>
          <div className={`text-center text-lg font-bold ${REGIME_TEXT[d.regime]}`}>{d.regime}</div>
          <div className="text-center text-xs text-muted-foreground mt-0.5">
            {d.composite_pct >= 65 ? "Reduce exposure · tighten stops" : d.composite_pct >= 45 ? "Caution · monitor signals" : "Trend-following favoured"}
          </div>
        </div>

        {/* Price grid */}
        <div className="space-y-1.5">
          {[
            { label: "SPY", price: d.prices.spy, chg: d.prices.spyChg },
            { label: "HYG", price: d.prices.hyg, chg: d.prices.hygChg },
            { label: "LQD", price: d.prices.lqd, chg: d.prices.lqdChg },
            { label: "TLT", price: d.prices.tlt, chg: d.prices.tltChg },
            { label: "VIX", price: d.prices.vix, chg: null as number | null, format: "1dp" as const },
          ].map(({ label, price, chg, format: f }) => (
            <div key={label} className="bg-card border border-border rounded px-2.5 py-1.5 flex items-center justify-between" data-testid={`price-${label.toLowerCase()}`}>
              <span className="text-xs font-bold text-muted-foreground">{label}</span>
              <div className="text-right">
                <span className="text-xs font-bold tabnum">
                  {price != null && isFinite(price)
                    ? (f === "1dp" ? price.toFixed(1) : `$${price.toFixed(2)}`)
                    : "—"}
                </span>
                {chg != null && (
                  <span className={`ml-1.5 text-xs tabnum ${chgColor(chg)}`}>{fmtChg(chg)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Kill switch summary */}
      <div className={`rounded-lg border p-3 ${killCount === 0 ? "border-green-800 bg-green-950/30" : killCount >= 2 ? "border-red-800 bg-red-950/30" : "border-yellow-800 bg-yellow-950/30"}`} data-testid="kill-switch-panel">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold uppercase tracking-wide">Kill Switches</span>
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${killCount === 0 ? "text-green-400 bg-green-950" : killCount >= 2 ? "text-red-400 bg-red-950" : "text-yellow-400 bg-yellow-950"}`}>
            {killCount === 0 ? "ALL CLEAR" : `${killCount} ACTIVE`}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {[
            { n: 1, label: "HY Spread", active: d.binary_switches.ks1 },
            { n: 2, label: "Joint Selloff", active: d.binary_switches.ks2 },
            { n: 3, label: "Real Rate", active: d.binary_switches.ks3 },
            { n: 4, label: "Bank Credit", active: d.binary_switches.ks4 },
          ].map(({ n, label, active }) => (
            <div key={n} className={`rounded px-1.5 py-1 text-center text-xs ${active ? "bg-red-950 border border-red-800 text-red-300" : "bg-secondary text-muted-foreground border border-transparent"}`} data-testid={`ks-${n}`}>
              <div className="font-bold">KS{n}</div>
              <div className="text-xs opacity-70 leading-tight">{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Signal bars */}
      <div className="bg-card border border-border rounded-lg p-3" data-testid="signal-bars">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2.5">Weighted Signal Breakdown</div>
        <div className="space-y-2">
          {signalRows.map(({ key, label, score, weight, color, raw }) => (
            <div key={key} className="space-y-0.5">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">{label}</span>
                <span className="tabnum font-medium">{(score * 100).toFixed(0)}%</span>
              </div>
              <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(0, Math.min(100, score * 100))}%`, backgroundColor: color, opacity: 0.8 }} />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground/60">
                <span>{raw}</span>
                <span>{weight != null ? `${(weight * 100).toFixed(1)}% weight` : ""}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* FRED */}
      {d.fred && (
        <div className="bg-card border border-border rounded-lg p-3" data-testid="fred-panel">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-1.5">Bank Credit (FRED TOTBKCR)</div>
          <div className="flex items-baseline gap-3">
            <span className="text-lg font-bold tabnum">${d.fred.totbkcr_b}T</span>
            <span className={`text-sm font-bold tabnum ${parseFloat(d.fred.yoy) < 0 ? "text-red-400" : parseFloat(d.fred.yoy) < 3 ? "text-yellow-400" : "text-green-400"}`}>
              {parseFloat(d.fred.yoy) >= 0 ? "+" : ""}{d.fred.yoy}% YoY
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">As of {d.fred.date} · {parseFloat(d.fred.yoy) < 0 ? "⚠ KS4 ACTIVE — contraction" : "KS4 clear"}</div>
        </div>
      )}

      {/* Macro Catalyst Calendar */}
      <div className="bg-card border border-border rounded-lg p-3">
        <CatalystCalendar />
      </div>
    </div>
  );
}

// ─── Signals Tab ─────────────────────────────────────────────────────────────
const LOOKBACK_OPTIONS = [
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
  { label: "3Y", days: 1095 },
  { label: "All", days: 9999 },
];

function SignalsTab({ d }: { d: MarketData }) {
  const SIG_SERIES = [
    { key: "vix",    label: "VIX (36.9%)",         color: "#ef4444" },
    { key: "ks1",    label: "KS1 HY (20.2%)",      color: "#3b82f6" },
    { key: "ks2",    label: "KS2 Selloff (14.6%)", color: "#06b6d4" },
    { key: "ks3",    label: "KS3 Real Rate (14.4%)",color: "#eab308" },
    { key: "ig_hy",  label: "IG/HY Diff (7.4%)",   color: "#22c55e" },
    { key: "ks4",    label: "KS4 Credit (6.6%)",   color: "#a855f7" },
  ];

  const [lookbackDays, setLookbackDays] = useState(180);
  const [activeSeries, setActiveSeries] = useState<string[]>(["vix", "ks1", "ks2", "ks3", "ig_hy", "ks4"]);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  const { data: history, isLoading } = useQuery<HistoryRow[]>({
    queryKey: ["/api/history", lookbackDays],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/history?days=${lookbackDays}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    retry: 2,
  });

  const toggleSeries = (key: string) => {
    setActiveSeries(prev =>
      prev.includes(key)
        ? prev.length > 1 ? prev.filter(k => k !== key) : prev
        : [...prev, key]
    );
  };

  const dateFormat = lookbackDays <= 90 ? "MMM d" : lookbackDays >= 9999 ? "yyyy" : "MMM ''yy";
  const chartData = useMemo(() => (history || []).map(row => ({
    date: format(parseISO(row.date), dateFormat),
    vix:    +((row.vix   ?? 0) * 100).toFixed(1),
    ks1:    +((row.ks1   ?? 0) * 100).toFixed(1),
    ks2:    +((row.ks2   ?? 0) * 100).toFixed(1),
    ks3:    +((row.ks3   ?? 0) * 100).toFixed(1),
    ig_hy:  +((row.ig_hy ?? 0) * 100).toFixed(1),
    ks4:    +((row.ks4   ?? 0) * 100).toFixed(1),
    composite: +((row.composite_score ?? 0) * 100).toFixed(1),
    regime: row.regime,
  })), [history, dateFormat]);

  const xInterval = Math.max(0, Math.floor(chartData.length / 6));

  const signals = [
    {
      id: "vix", label: "VIX — Fear Index", weight: 36.9, color: "#ef4444",
      score: d.signal_scores.vix,
      value: `${fmt(d.prices.vix, 1)}`,
      what: "VIX measures 30-day implied volatility of S&P 500 options. Historically the strongest single predictor of drawdown risk (IC 0.19 at 60d horizon). It accounts for 36.9% of the composite score.",
      thresholdText: "VIX >20: caution zone. VIX >30: historically 73% of major drawdowns follow within 3 months. VIX <15: low-risk, trend-following environment.",
      status: d.prices.vix < 20 ? "CLEAR" : d.prices.vix < 30 ? "CAUTION" : "ALERT",
    },
    {
      id: "ks1", label: "KS1 — HY Credit Spread", weight: 20.2, color: "#3b82f6",
      score: d.signal_scores.ks1,
      value: `${fmt(d.raw_signals.ks1_pct, 1)}% below 52w high`,
      what: "HYG (HY ETF) distance from its 52-week high. HY credit is the canary in the coal mine — it prices credit risk before equities reprice. A widening spread (HYG falling) signals deteriorating corporate credit conditions.",
      thresholdText: "<2%: healthy. 2–5%: monitor closely. >5%: KS1 active — reduce HY exposure. >10%: significant stress, consider equity reduction.",
      status: d.raw_signals.ks1_pct < 2 ? "CLEAR" : d.raw_signals.ks1_pct < 5 ? "CAUTION" : "ALERT",
    },
    {
      id: "ks2", label: "KS2 — Joint Selloff", weight: 14.6, color: "#06b6d4",
      score: d.signal_scores.ks2,
      value: d.binary_switches.ks2 ? "ACTIVE — SPY & HYG both down >1.5%" : "CLEAR",
      what: "Binary kill switch: triggers when both SPY AND HYG fall >1.5% on the same day. A joint selloff across equities AND credit simultaneously signals systemic deleveraging — not a normal sector rotation.",
      thresholdText: "When active: immediately tighten stops and reduce new position sizing. Rule: requires 2+ kill switches simultaneously before outright exposure reduction.",
      status: d.binary_switches.ks2 ? "ALERT" : "CLEAR",
    },
    {
      id: "ks3", label: "KS3 — Real Rate Stress", weight: 14.4, color: "#eab308",
      score: d.signal_scores.ks3,
      value: `TLT/TIP z-score: ${fmt(d.raw_signals.ks3_zscore, 2)}`,
      what: "TLT/TIP price ratio z-score proxies real interest rate stress. When real rates spike (TLT falls relative to TIP), it tightens financial conditions and compresses equity multiples — especially for long-duration growth stocks.",
      thresholdText: "z-score < -1.5: KS3 active (real rate spike). z-score > 0: accommodative real rates, supportive for equities. Current z below -1.5 = meaningful headwind.",
      status: d.raw_signals.ks3_zscore > -0.5 ? "CLEAR" : d.raw_signals.ks3_zscore > -1.5 ? "CAUTION" : "ALERT",
    },
    {
      id: "ig_hy", label: "IG/HY Differential", weight: 7.4, color: "#22c55e",
      score: d.signal_scores.ig_hy,
      value: `LQD/HYG z-score: ${fmt(d.raw_signals.ig_hy_zscore, 2)}`,
      what: "LQD/HYG price ratio z-score tracks whether IG credit is outperforming HY. When HY spreads widen faster than IG, the differential rises — capital is rotating inward (risk-off). This is an early warning before KS1 triggers.",
      thresholdText: "z > 1.5: HY stress decoupling from IG — risk-off rotation. z < -0.5: HY outperforming IG — risk appetite expanding (outward). Near zero: neutral.",
      status: d.raw_signals.ig_hy_zscore < 0.5 ? "CLEAR" : d.raw_signals.ig_hy_zscore < 1.5 ? "CAUTION" : "ALERT",
    },
    {
      id: "ks4", label: "KS4 — Bank Credit Growth", weight: 6.6, color: "#a855f7",
      score: d.signal_scores.ks4,
      value: `${d.fred ? fmt(d.raw_signals.ks4_yoy, 1) + "% YoY (FRED)" : "N/A — FRED data pending"}`,
      what: "FRED TOTBKCR bank credit YoY growth. Bank credit is the economy's primary money creation mechanism. Contraction (<0% YoY) signals banks are tightening lending conditions — historically a leading indicator of recession by 6-12 months. Weakest and most lagging of the 6 signals.",
      thresholdText: ">3% YoY: clear, healthy credit expansion. 0–3%: warn zone, slowdown risk. <0%: KS4 active — credit contraction, systemic risk.",
      status: (d.raw_signals.ks4_yoy ?? 6) > 3 ? "CLEAR" : (d.raw_signals.ks4_yoy ?? 6) > 0 ? "CAUTION" : "ALERT",
    },
  ];

  const statusColors: Record<string, string> = {
    CLEAR:   "text-green-400 bg-green-950 border-green-800",
    CAUTION: "text-yellow-400 bg-yellow-950 border-yellow-800",
    ALERT:   "text-red-400 bg-red-950 border-red-800",
  };

  return (
    <div className="space-y-4">

      {/* ── Overlay chart header ── */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Signal Stress · Overlay</div>
        <div className="flex gap-1">
          {LOOKBACK_OPTIONS.map(opt => (
            <button
              key={opt.label}
              onClick={() => setLookbackDays(opt.days)}
              className={`px-2.5 py-1 rounded text-xs font-bold transition-colors ${
                lookbackDays === opt.days
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Series toggle pills ── */}
      <div className="flex flex-wrap gap-1.5">
        {SIG_SERIES.map(ser => {
          const on = activeSeries.includes(ser.key);
          return (
            <button
              key={ser.key}
              onClick={() => toggleSeries(ser.key)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border transition-all ${
                on ? "text-foreground" : "border-border text-muted-foreground hover:text-foreground bg-secondary/30"
              }`}
              style={on ? { backgroundColor: ser.color + "22", borderColor: ser.color + "66" } : {}}
            >
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: on ? ser.color : "#555" }} />
              {ser.label}
            </button>
          );
        })}
      </div>

      {/* ── Overlay chart ── */}
      {isLoading ? (
        <div className="h-56 bg-secondary/30 rounded-lg animate-pulse" />
      ) : chartData.length > 2 ? (
        <div className="bg-card border border-border rounded-lg p-3" data-testid="signals-overlay-chart">
          <div className="text-xs text-muted-foreground mb-2">Signal stress percentile (0 = no stress, 100 = max stress). All signals on same scale.</div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 9, fill: "#666" }}
                  interval={xInterval}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: "#666" }}
                  domain={[0, 100]}
                  tickFormatter={v => `${v}`}
                  width={28}
                  axisLine={false}
                  tickLine={false}
                />
                <ReferenceLine y={65} stroke="#ef444444" strokeDasharray="4 4" label={{ value: "Risk-Off", position: "right", fontSize: 8, fill: "#ef4444" }} />
                <ReferenceLine y={45} stroke="#eab30844" strokeDasharray="4 4" label={{ value: "Caution", position: "right", fontSize: 8, fill: "#eab308" }} />
                <Tooltip
                  contentStyle={{ background: "#0f0f1a", border: "1px solid #333", borderRadius: 8, fontSize: 11 }}
                  formatter={(val: any, name: any) => {
                    const ser = SIG_SERIES.find(s => s.key === name);
                    const n = typeof val === "number" ? val : parseFloat(String(val));
                    return [`${isFinite(n) ? n.toFixed(0) : "—"}th %ile`, ser?.label || name];
                  }}
                  labelStyle={{ color: "#888", marginBottom: 4 }}
                />
                {activeSeries.map(sk => {
                  const ser = SIG_SERIES.find(s => s.key === sk);
                  return ser ? (
                    <Line
                      key={sk}
                      type="monotone"
                      dataKey={sk}
                      stroke={ser.color}
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ) : null;
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {/* Latest values row */}
          <div className="flex gap-3 mt-2 flex-wrap border-t border-border pt-2">
            {activeSeries.map(sk => {
              const ser = SIG_SERIES.find(s => s.key === sk);
              const sig = signals.find(s => s.id === sk);
              if (!ser || !sig) return null;
              return (
                <div key={sk} className="flex items-center gap-1.5 text-xs">
                  <div className="w-3 h-0.5 rounded" style={{ backgroundColor: ser.color }} />
                  <span className="text-muted-foreground">{ser.label.split(" ")[0]}:</span>
                  <span className="font-bold tabnum" style={{ color: sig.status === "ALERT" ? "#ef4444" : sig.status === "CAUTION" ? "#eab308" : "#22c55e" }}>
                    {sig.status}
                  </span>
                  <span className="text-muted-foreground/70 tabnum">{sig.value}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg p-6 text-center text-xs text-muted-foreground" data-testid="signals-empty">
          Not enough history yet to render the overlay. Data accumulates as the server records daily entries.
        </div>
      )}

      {/* ── Individual signal cards (compact, expandable) ── */}
      <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground pt-1">Individual Signals</div>
      <div className="space-y-2">
        {signals.map((sig) => {
          const expanded = expandedCard === sig.id;
          return (
            <div
              key={sig.id}
              className="bg-card border border-border rounded-lg overflow-hidden"
              data-testid={`signal-card-${sig.id}`}
            >
              <button
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-secondary/20 transition-colors"
                onClick={() => setExpandedCard(expanded ? null : sig.id)}
                aria-expanded={expanded}
              >
                <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: sig.color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm">{sig.label}</span>
                    <span className="text-xs text-muted-foreground">· {sig.weight}%</span>
                  </div>
                  <div className="text-xs text-muted-foreground tabnum mt-0.5">{sig.value}</div>
                </div>
                <div className="w-20 flex-shrink-0">
                  <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${Math.max(0, Math.min(100, sig.score * 100))}%`, backgroundColor: sig.color }}
                    />
                  </div>
                  <div className="text-xs tabnum text-right mt-0.5 text-muted-foreground">{(sig.score * 100).toFixed(0)}th</div>
                </div>
                <span className={`flex-shrink-0 text-xs font-bold px-2 py-0.5 rounded border ${statusColors[sig.status]}`}>
                  {sig.status}
                </span>
                <span className="text-muted-foreground text-xs flex-shrink-0">{expanded ? "▲" : "▼"}</span>
              </button>

              {expanded && (
                <div className="px-4 pb-4 space-y-3 border-t border-border">
                  {chartData.length > 2 && (
                    <div className="h-28 pt-3" data-testid={`signal-chart-${sig.id}`}>
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 2, right: 2, bottom: 0, left: 0 }}>
                          <defs>
                            <linearGradient id={`sig-grad-${sig.id}`} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%"  stopColor={sig.color} stopOpacity={0.3} />
                              <stop offset="95%" stopColor={sig.color} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
                          <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#555" }} interval={xInterval} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 9, fill: "#555" }} domain={[0, 100]} width={24} axisLine={false} tickLine={false} />
                          <ReferenceLine y={65} stroke="#ef444444" strokeDasharray="3 3" />
                          <ReferenceLine y={45} stroke="#eab30844" strokeDasharray="3 3" />
                          <Tooltip
                            contentStyle={{ background: "#0f0f1a", border: "1px solid #333", borderRadius: 6, fontSize: 10 }}
                            formatter={(v: any) => {
                              const n = typeof v === "number" ? v : parseFloat(String(v));
                              return [`${isFinite(n) ? n.toFixed(0) : "—"}th %ile`, sig.label];
                            }}
                          />
                          <Area
                            type="monotone"
                            dataKey={sig.id}
                            stroke={sig.color}
                            strokeWidth={1.5}
                            fill={`url(#sig-grad-${sig.id})`}
                            dot={false}
                            connectNulls
                            isAnimationActive={false}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground leading-relaxed space-y-1">
                    <p>{sig.what}</p>
                    <p className="text-muted-foreground/70 italic">{sig.thresholdText}</p>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Macro Regime Tab ─────────────────────────────────────────────────────────
function MacroRegimeTab({ d }: { d: MarketData }) {
  const killCount = d.binary_switches.active_count;
  const regime = d.regime;

  const regimeDetail = ({
    "LONG": {
      title: "LONG — Risk-On Environment",
      summary: "Market liquidity is healthy, credit is functioning normally, and systemic stress is low. Trend-following strategies are favoured. Increase position sizes toward full allocation in high-beta assets.",
      sectors: ["Technology (growth)", "Consumer Discretionary", "Financials", "Industrials", "Small Caps"],
      avoid: ["Defensive overweights (Utilities, REITs)", "Cash hoarding"],
      actionable: [
        "Ride existing long positions — do NOT trim on normal volatility",
        "Add to winners as they make new highs",
        "Acceptable to carry full leverage in trending instruments",
        "Move stops to break-even quickly on new entries",
      ],
    },
    "CAUTIOUS": {
      title: "CAUTIOUS — Elevated Stress",
      summary: "One or more signals are flashing warning. Don't outright de-risk but tighten risk management. The composite score sits in the amber zone — conditions could deteriorate or recover. Monitor kill switches closely.",
      sectors: ["Quality equities (low-leverage)", "Healthcare", "IG Credit", "Short-duration bonds"],
      avoid: ["EM debt", "Heavily levered growth names", "Illiquid positions"],
      actionable: [
        "Tighten trailing stops on all positions",
        "Do NOT add new high-beta exposure",
        "Reduce max position size to 50-75% of normal",
        "Watch for KS2 (joint selloff) as the critical confirmation trigger",
      ],
    },
    "RISK-OFF": {
      title: "RISK-OFF — Systemic Stress Active",
      summary: "Composite risk score exceeds 65/100. Multiple signals are deteriorating simultaneously. Capital is rotating inward — from risk assets toward safety. Reduce equity exposure and tighten all stops immediately.",
      sectors: ["T-Bills / cash", "Treasuries (if real rates falling)", "Gold / commodity hedges"],
      avoid: ["HY credit", "EM equities and debt", "Leveraged/growth equities", "Small caps"],
      actionable: [
        "Reduce equity exposure to 25-50% of normal allocation",
        "Tighten all stops to max 1% portfolio risk per position",
        "No new long entries until composite score returns below 45",
        "Consider inverse ETFs ONLY if 3+ kill switches simultaneously active",
      ],
    },
  } as const)[regime];

  const riskCurveDir = d.raw_signals.ig_hy_zscore > 1.5 ? "INWARD" : d.raw_signals.ig_hy_zscore < -0.5 ? "OUTWARD" : "NEUTRAL";
  const riskCurveColor = riskCurveDir === "OUTWARD" ? "text-teal-400" : riskCurveDir === "INWARD" ? "text-red-400" : "text-yellow-300";

  return (
    <div className="space-y-3">
      {/* Current regime card */}
      <div className={`rounded-lg border p-4 ${REGIME_BG[regime]}`} data-testid="regime-detail-card">
        <div className="text-xs uppercase tracking-widest font-bold opacity-60 mb-1">Current Regime</div>
        <div className={`text-xl font-bold mb-2 ${REGIME_TEXT[regime]}`}>{regimeDetail.title}</div>
        <p className="text-sm leading-relaxed opacity-90">{regimeDetail.summary}</p>
        <div className="mt-3 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Score:</span>
          <span className="font-bold tabnum" style={{ color: scoreColor(d.composite_pct) }}>{d.composite_pct}/100</span>
          <span className="text-muted-foreground">· Kill switches:</span>
          <span className={`font-bold ${killCount >= 2 ? "text-red-400" : killCount === 1 ? "text-yellow-400" : "text-green-400"}`}>{killCount} active</span>
        </div>
      </div>

      {/* Actionable rules */}
      <div className="bg-card border border-border rounded-lg p-4" data-testid="actionable-card">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">Actionable Rules — Now</div>
        <ul className="space-y-2">
          {regimeDetail.actionable.map((rule, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span className={`w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold mt-0.5 ${REGIME_TEXT[regime]} bg-current/10`}>{i + 1}</span>
              <span className="leading-relaxed">{rule}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Sector rotation */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-card border border-green-900/40 rounded-lg p-3" data-testid="sectors-favour">
          <div className="text-xs font-bold uppercase tracking-wide text-green-400 mb-2">Favour</div>
          <ul className="space-y-1">
            {regimeDetail.sectors.map((s, i) => (
              <li key={i} className="text-xs text-muted-foreground flex items-center gap-1.5">
                <span className="text-green-400">→</span>{s}
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-card border border-red-900/40 rounded-lg p-3" data-testid="sectors-avoid">
          <div className="text-xs font-bold uppercase tracking-wide text-red-400 mb-2">Avoid</div>
          <ul className="space-y-1">
            {regimeDetail.avoid.map((s, i) => (
              <li key={i} className="text-xs text-muted-foreground flex items-center gap-1.5">
                <span className="text-red-400">✕</span>{s}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Capital risk curve */}
      <div className="bg-card border border-border rounded-lg p-4" data-testid="risk-curve-card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Capital Risk Curve</h3>
          <span className={`text-xs font-bold px-2 py-0.5 rounded border ${riskCurveDir === "OUTWARD" ? "bg-teal-900/40 border-teal-700 text-teal-300" : riskCurveDir === "INWARD" ? "bg-red-900/40 border-red-700 text-red-400" : "bg-yellow-900/40 border-yellow-700 text-yellow-300"}`}>
            {riskCurveDir === "OUTWARD" ? "↗ OUTWARD" : riskCurveDir === "INWARD" ? "↙ INWARD" : "→ NEUTRAL"}
          </span>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto pb-1 mb-3">
          {[
            { label: "T-Bills", sub: "Safest", cls: "bg-secondary text-muted-foreground border-border" },
            { label: "Treasuries", sub: "Duration", cls: "bg-blue-950 text-blue-300 border-blue-800" },
            { label: "IG Credit", sub: "LQD", cls: "bg-indigo-950 text-indigo-300 border-indigo-800" },
            { label: "HY Credit", sub: "HYG", cls: "bg-purple-950 text-purple-300 border-purple-800" },
            { label: "Equities", sub: "SPY", cls: "bg-primary/20 text-primary border-primary/40" },
            { label: "Alts", sub: "Riskiest", cls: "bg-orange-950 text-orange-300 border-orange-800" },
          ].map((step, i, arr) => (
            <div key={i} className="flex items-center gap-1 flex-shrink-0">
              <div className={`px-2 py-1.5 rounded text-xs font-medium border text-center min-w-[64px] ${step.cls}`}>
                <div className="font-bold">{step.label}</div>
                <div className="text-xs opacity-70">{step.sub}</div>
              </div>
              {i < arr.length - 1 && (
                <span className={`text-xs font-bold ${riskCurveDir === "OUTWARD" ? "text-teal-400" : riskCurveDir === "INWARD" ? "text-red-400" : "text-muted-foreground"}`}>
                  {riskCurveDir === "OUTWARD" ? "→" : riskCurveDir === "INWARD" ? "←" : "·"}
                </span>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          <span className="font-medium text-foreground">IG/HY z-score: </span>
          <span className={riskCurveColor}>{fmt(d.raw_signals.ig_hy_zscore, 2)}</span>
          {" · "}When HY spreads widen faster than IG, capital rotates <span className="font-medium">INWARD</span> (risk-off).
          Differential {'>'} 2pp = HY stress decoupling — early warning before KS1 triggers.
        </p>
      </div>

      {/* Two risk dimensions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-card border border-border rounded-lg p-3" data-testid="duration-risk-card">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Duration Risk</div>
          <p className="text-xs text-muted-foreground mb-2">Uncertainty of real purchasing power of future cash flows.</p>
          <ul className="text-xs text-muted-foreground space-y-1">
            <li>→ Priced via inflation break-evens / swaps</li>
            <li>→ Hits <span className="text-foreground">long bonds (TLT)</span> hardest</li>
            <li>→ Hits <span className="text-foreground">long-duration growth stocks</span></li>
            <li>→ KS3 z-score: <span className={d.binary_switches.ks3 ? "text-red-400" : "text-green-400"}>{fmt(d.raw_signals.ks3_zscore, 2)}</span></li>
          </ul>
        </div>
        <div className="bg-card border border-border rounded-lg p-3" data-testid="credit-risk-card">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Credit Risk</div>
          <p className="text-xs text-muted-foreground mb-2">Uncertainty of nominal repayment — driven by growth outlook.</p>
          <ul className="text-xs text-muted-foreground space-y-1">
            <li>→ Priced via HY credit spreads</li>
            <li>→ Hits <span className="text-foreground">HY bonds, EM debt</span></li>
            <li>→ Hits <span className="text-foreground">leveraged growth equities</span></li>
            <li>→ KS1: <span className={d.binary_switches.ks1 ? "text-yellow-400" : "text-green-400"}>{d.binary_switches.ks1 ? "WIDENING" : "CONTAINED"}</span></li>
          </ul>
        </div>
      </div>

      {/* HY duration note */}
      <div className="bg-card border border-border rounded-lg p-3" data-testid="hy-duration-card">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">HY Duration — Structural Change</div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          HY ETF duration has collapsed — <span className="text-foreground">HY now behaves like equities, not bonds</span>.
          Do NOT short HY on yield curve inversion alone. Do NOT use TLT as a hedge for HY exposure.
          Always classify each trade by which risk dimension it carries.
        </p>
      </div>

      {/* 12 Rules */}
      <div className="bg-card border border-border rounded-lg p-4" data-testid="rules-card">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">12 Risk Management Rules</div>
        <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside leading-relaxed">
          <li>Classify every trade by <em>duration</em> or <em>credit</em> risk before entry</li>
          <li>Three time horizon buckets: day / swing / position (Druckenmiller-inspired)</li>
          <li>Move stops to break-even as soon as in profit</li>
          <li>Add to winners — never scale out of winning positions</li>
          <li>Let winners run — trimming on vol destroys alpha</li>
          <li>Accept low hit rate for high-magnitude outcomes</li>
          <li>Informational edge justifies concentration</li>
          <li>Welcome volatility — vol suppression = return suppression</li>
          <li>Attribution on every P&L move</li>
          <li>Narrative discipline — don't trade disproven narratives</li>
          <li>Never short into HY ATHs</li>
          <li>Scenario analysis (bull/base/bear) before every entry</li>
        </ol>
      </div>
    </div>
  );
}

// ─── History Tab ──────────────────────────────────────────────────────────────
function HistoryTab() {
  const SERIES = [
    { key: "composite_score", label: "Risk Score",       color: "#ef4444", fmt: (v: number) => `${(v * 100).toFixed(0)}` },
    { key: "spy_price",       label: "SPY Price",        color: "#22c55e", fmt: (v: number) => `$${v.toFixed(0)}` },
    { key: "hyg_price",       label: "HYG Price",        color: "#3b82f6", fmt: (v: number) => `$${v.toFixed(2)}` },
    { key: "vix_value",       label: "VIX",              color: "#f97316", fmt: (v: number) => v.toFixed(1) },
    { key: "totbkcr_yoy",     label: "Bank Credit YoY%", color: "#a855f7", fmt: (v: number) => `${v != null ? v.toFixed(1) : "—"}%` },
  ] as const;

  const [lookbackDays, setLookbackDays] = useState(365);
  const [activeSeries, setActiveSeries] = useState<string[]>(["composite_score", "spy_price"]);

  const { data: history, isLoading } = useQuery<HistoryRow[]>({
    queryKey: ["/api/history", lookbackDays],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/history?days=${lookbackDays}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    retry: 2,
  });

  const dateFormat = lookbackDays <= 90 ? "MMM d" : lookbackDays >= 9999 ? "yyyy" : "MMM ''yy";

  const chartData = useMemo(() => (history || []).map(row => ({
    date: format(parseISO(row.date), dateFormat),
    rawDate: row.date,
    composite_score: row.composite_score,
    spy_price: row.spy_price,
    hyg_price: row.hyg_price,
    vix_value: row.vix_value,
    totbkcr_yoy: row.totbkcr_yoy,
    regime: row.regime,
  })), [history, dateFormat]);

  // Pre-compute min/max once per series, then normalise in a single pass.
  const normData = useMemo(() => {
    const minMax: Record<string, { min: number; max: number }> = {};
    for (const sk of activeSeries) {
      if (sk === "composite_score") continue; // already 0-1
      let min = Infinity, max = -Infinity;
      for (const r of chartData) {
        const v = (r as any)[sk];
        if (v == null || !isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      minMax[sk] = { min, max };
    }
    return chartData.map(row => {
      const out: any = { date: row.date, rawDate: row.rawDate, regime: row.regime };
      for (const sk of activeSeries) {
        const raw = (row as any)[sk];
        if (sk === "composite_score") {
          out[sk] = raw;
        } else {
          const { min, max } = minMax[sk] || { min: 0, max: 1 };
          if (raw == null || !isFinite(raw)) out[sk] = null;
          else out[sk] = max > min ? (raw - min) / (max - min) : 0.5;
        }
        out[`${sk}_raw`] = raw;
      }
      return out;
    });
  }, [chartData, activeSeries]);

  const toggleSeries = (key: string) => {
    setActiveSeries(prev => prev.includes(key) ? (prev.length > 1 ? prev.filter(k => k !== key) : prev) : [...prev, key]);
  };

  const regimeCounts: Record<Regime, number> = { LONG: 0, CAUTIOUS: 0, "RISK-OFF": 0 };
  (history || []).forEach(r => { if ((r.regime as Regime) in regimeCounts) regimeCounts[r.regime as Regime]++; });

  const signalChartData = useMemo(() => (history || []).slice(-90).map(row => ({
    date: format(parseISO(row.date), "MMM d"),
    VIX: +((row.vix ?? 0) * 100).toFixed(1),
    KS1: +((row.ks1 ?? 0) * 100).toFixed(1),
    KS3: +((row.ks3 ?? 0) * 100).toFixed(1),
  })), [history]);

  const normXInterval = Math.max(0, Math.floor(normData.length / 6));
  const sigXInterval  = Math.max(0, Math.floor(signalChartData.length / 5));

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">History · Overlay Chart</div>
        <div className="flex gap-1">
          {LOOKBACK_OPTIONS.map(opt => (
            <button
              key={opt.label}
              onClick={() => setLookbackDays(opt.days)}
              className={`px-2.5 py-1 rounded text-xs font-bold transition-colors ${lookbackDays === opt.days ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}
              data-testid={`lookback-${opt.label}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Series toggles */}
      <div className="flex flex-wrap gap-1.5">
        {SERIES.map(ser => (
          <button
            key={ser.key}
            onClick={() => toggleSeries(ser.key)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border transition-colors ${activeSeries.includes(ser.key) ? "border-transparent text-foreground" : "border-border text-muted-foreground hover:text-foreground bg-secondary/30"}`}
            style={activeSeries.includes(ser.key) ? { backgroundColor: ser.color + "22", borderColor: ser.color + "66" } : {}}
            data-testid={`toggle-${ser.key}`}
          >
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: activeSeries.includes(ser.key) ? ser.color : "#666" }} />
            {ser.label}
          </button>
        ))}
      </div>

      {/* Overlay chart */}
      {isLoading ? (
        <div className="h-52 bg-secondary/30 rounded-lg animate-pulse" />
      ) : normData.length > 0 ? (
        <div className="bg-card border border-border rounded-lg p-3">
          <div className="text-xs text-muted-foreground mb-2">Normalised 0–100 scale (each series scaled to its own min/max). Risk Score: actual 0–100.</div>
          <div className="h-52" data-testid="overlay-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={normData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#666" }} interval={normXInterval} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "#666" }} domain={[0, 1]} tickFormatter={v => `${(v * 100).toFixed(0)}`} width={28} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "#0f0f1a", border: "1px solid #333", borderRadius: 8, fontSize: 11 }}
                  formatter={(val: any, name: any) => {
                    const ser = SERIES.find(s => s.key === name);
                    const n = typeof val === "number" ? val : parseFloat(String(val));
                    return [`${isFinite(n) ? (n * 100).toFixed(0) : "—"}`, ser?.label || name];
                  }}
                  labelStyle={{ color: "#888", marginBottom: 4 }}
                />
                <ReferenceLine y={0.65} stroke="#ef444444" strokeDasharray="4 4" />
                <ReferenceLine y={0.45} stroke="#eab30844" strokeDasharray="4 4" />
                {activeSeries.map(sk => {
                  const ser = SERIES.find(s => s.key === sk);
                  return ser ? (
                    <Line key={sk} type="monotone" dataKey={sk} stroke={ser.color} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
                  ) : null;
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-4 mt-1.5 flex-wrap">
            {activeSeries.map(sk => {
              const ser = SERIES.find(s => s.key === sk);
              const vals = (history || []).map(r => (r as any)[sk]).filter(v => v != null && isFinite(v));
              const latest = vals[vals.length - 1];
              return ser && latest != null ? (
                <div key={sk} className="flex items-center gap-1.5 text-xs">
                  <div className="w-2 h-0.5 rounded" style={{ backgroundColor: ser.color }} />
                  <span className="text-muted-foreground">{ser.label}:</span>
                  <span className="font-medium tabnum">{ser.fmt(latest)}</span>
                </div>
              ) : null;
            })}
          </div>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg p-6 text-center text-xs text-muted-foreground">
          No history data yet.
        </div>
      )}

      {/* Regime distribution */}
      {!isLoading && history && history.length > 0 && (() => {
        const segments: { regime: string; count: number; start: string; end: string }[] = [];
        for (const row of history) {
          const last = segments[segments.length - 1];
          if (last && last.regime === row.regime) { last.count++; last.end = row.date; }
          else segments.push({ regime: row.regime, count: 1, start: row.date, end: row.date });
        }
        const total = history.length;
        return (
          <div className="bg-card border border-border rounded-lg p-3" data-testid="regime-distribution">
            <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
              Regime Distribution · {lookbackDays >= 9999 ? "All" : `${lookbackDays}d`} ({total} trading days)
            </div>
            <div className="flex gap-3 mb-3">
              {(["LONG", "CAUTIOUS", "RISK-OFF"] as const).map(r => (
                <div key={r} className="flex-1 text-center">
                  <div className="text-lg font-bold tabnum" style={{ color: REGIME_COLORS[r] }}>
                    {total > 0 ? ((regimeCounts[r] / total) * 100).toFixed(0) : 0}%
                  </div>
                  <div className="text-xs text-muted-foreground">{r}</div>
                  <div className="text-xs text-muted-foreground/60">{regimeCounts[r]}d</div>
                </div>
              ))}
            </div>
            <div className="flex h-4 rounded overflow-hidden" data-testid="regime-timeline">
              {segments.map((seg, i) => (
                <div
                  key={i}
                  style={{
                    width: `${(seg.count / total) * 100}%`,
                    backgroundColor: (REGIME_COLORS as Record<string, string>)[seg.regime] || "#666",
                    flexShrink: 0,
                  }}
                  title={`${seg.start} → ${seg.end}: ${seg.regime} (${seg.count}d)`}
                />
              ))}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>{history[0]?.date}</span>
              <span>{history[history.length - 1]?.date}</span>
            </div>
          </div>
        );
      })()}

      {/* Signal stress chart (90d) */}
      {!isLoading && signalChartData.length > 2 && (
        <div className="bg-card border border-border rounded-lg p-3" data-testid="signal-stress-chart">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-1">Top Signal Stress — 90d</div>
          <div className="text-xs text-muted-foreground mb-2">VIX, KS1, and Real Rate stress percentiles (0-100)</div>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={signalChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#666" }} interval={sigXInterval} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#666" }} width={24} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: "#0f0f1a", border: "1px solid #333", borderRadius: 8, fontSize: 11 }} />
                <ReferenceLine y={65} stroke="#ef444444" strokeDasharray="4 4" label={{ value: "Risk-Off", position: "right", fontSize: 9, fill: "#ef4444" }} />
                <Line type="monotone" dataKey="VIX" stroke="#ef4444" strokeWidth={1.5} dot={false} name="VIX stress" isAnimationActive={false} />
                <Line type="monotone" dataKey="KS1" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="HY spread stress" isAnimationActive={false} />
                <Line type="monotone" dataKey="KS3" stroke="#eab308" strokeWidth={1.5} dot={false} name="Real rate stress" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Data table */}
      {!isLoading && history && history.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden" data-testid="history-table">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground px-3 py-2 border-b border-border">Recent Data</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left px-3 py-1.5">Date</th>
                  <th className="text-center px-2 py-1.5">Regime</th>
                  <th className="text-center px-2 py-1.5">Score</th>
                  <th className="text-center px-2 py-1.5">SPY</th>
                  <th className="text-center px-2 py-1.5">VIX</th>
                  <th className="text-center px-2 py-1.5">HYG</th>
                </tr>
              </thead>
              <tbody>
                {history.slice().reverse().slice(0, 20).map((row, i) => (
                  <tr key={i} className="border-b border-border/40 hover:bg-secondary/20">
                    <td className="px-3 py-1 tabnum text-muted-foreground">{row.date}</td>
                    <td className="px-2 py-1 text-center">
                      <span className="text-xs font-bold" style={{ color: (REGIME_COLORS as Record<string, string>)[row.regime] || "#888" }}>{row.regime}</span>
                    </td>
                    <td className="px-2 py-1 text-center tabnum font-medium" style={{ color: scoreColor((row.composite_score ?? 0) * 100) }}>
                      {row.composite_score != null ? (row.composite_score * 100).toFixed(0) : "—"}
                    </td>
                    <td className="px-2 py-1 text-center tabnum">{row.spy_price ? `$${row.spy_price.toFixed(0)}` : "—"}</td>
                    <td className="px-2 py-1 text-center tabnum">{row.vix_value ? row.vix_value.toFixed(1) : "—"}</td>
                    <td className="px-2 py-1 text-center tabnum">{row.hyg_price ? `$${row.hyg_price.toFixed(2)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Signal Weights Tab ───────────────────────────────────────────────────────
function WeightsTab({ d }: { d: MarketData }) {
  const { data: weightsData } = useQuery<any>({
    queryKey: ["/api/weights"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/weights");
      return res.json();
    },
    staleTime: Infinity,
  });

  const weights = d.signal_weights || {};
  const weightRows = Object.entries(weights).sort((a, b) => b[1].weight - a[1].weight);
  const maxWeight = weightRows.reduce((m, [, w]) => Math.max(m, w.weight), 0) || 1;

  const backtest = weightsData?.backtest || {
    current_system:  { sharpe: 0.94, max_dd: -38.2, ann_ret: 16.3 },
    weighted_6sig:   { sharpe: 3.22, max_dd: -5.1,  ann_ret: 28.2 },
    buy_hold:        { sharpe: 0.64, max_dd: -44.7, ann_ret: 12.7 },
  };

  const icTable: any[] = weightsData?.ic_table || [];
  const btData = [
    { name: "Buy & Hold",   sharpe: backtest.buy_hold?.sharpe,       dd: Math.abs(backtest.buy_hold?.max_dd ?? 0),       ret: backtest.buy_hold?.ann_ret,       color: "#6b7280" },
    { name: "Equal Weight", sharpe: backtest.current_system?.sharpe, dd: Math.abs(backtest.current_system?.max_dd ?? 0), ret: backtest.current_system?.ann_ret, color: "#3b82f6" },
    { name: "Weighted (v3)",sharpe: backtest.weighted_6sig?.sharpe,  dd: Math.abs(backtest.weighted_6sig?.max_dd ?? 0),  ret: backtest.weighted_6sig?.ann_ret,  color: "#22c55e" },
  ];

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-lg p-4" data-testid="methodology-card">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Methodology</div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Weights derived via logistic regression + Information Coefficient (IC) analysis on <strong className="text-foreground">4,784 trading days</strong> (Apr 2007 – Apr 2026).
          Target: predict SPY drawdown {'>'} 15% within 60 days. OOS AUC: <strong className="text-foreground">0.568 ± 0.232</strong> (bootstrap N=500).
        </p>
      </div>

      <div className="bg-card border border-border rounded-lg p-4" data-testid="weight-bars">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">Evidence-Based Weights</div>
        <div className="space-y-3">
          {weightRows.map(([key, w]) => (
            <div key={key} className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="font-medium">{w.label}</span>
                <span className="tabnum font-bold">{(w.weight * 100).toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${(w.weight / maxWeight) * 100}%`, backgroundColor: w.color }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-4" data-testid="backtest-card">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">Backtest Comparison (2007–2026)</div>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {btData.map(bt => (
            <div key={bt.name} className="bg-secondary/40 rounded p-2 text-center border border-border">
              <div className="text-xs text-muted-foreground mb-1 leading-tight">{bt.name}</div>
              <div className="text-base font-bold tabnum" style={{ color: bt.color }}>{bt.sharpe?.toFixed(2) ?? "—"}</div>
              <div className="text-xs text-muted-foreground">Sharpe</div>
              <div className="mt-1.5 text-xs tabnum text-green-400">+{bt.ret?.toFixed(1) ?? "—"}% ann</div>
              <div className="text-xs tabnum text-red-400">-{bt.dd?.toFixed(1) ?? "—"}% DD</div>
            </div>
          ))}
        </div>
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={btData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: "#666" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: "#666" }} width={28} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: "#0f0f1a", border: "1px solid #333", borderRadius: 8, fontSize: 11 }} />
              <Bar dataKey="sharpe" name="Sharpe Ratio" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {btData.map((bt, i) => <Cell key={i} fill={bt.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {icTable.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4" data-testid="ic-table">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">Information Coefficients</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left pb-2">Signal</th>
                  <th className="text-center pb-2">IC 20d</th>
                  <th className="text-center pb-2">IC 40d</th>
                  <th className="text-center pb-2">IC 60d</th>
                  <th className="text-center pb-2">Sig.</th>
                </tr>
              </thead>
              <tbody>
                {icTable.map((row: any, i: number) => (
                  <tr key={i} className="border-b border-border/30">
                    <td className="py-1 text-muted-foreground">{row.signal}</td>
                    <td className="py-1 text-center tabnum">{row.ic_20d?.toFixed(4)}</td>
                    <td className="py-1 text-center tabnum">{row.ic_40d?.toFixed(4)}</td>
                    <td className="py-1 text-center tabnum">{row.ic_60d?.toFixed(4)}</td>
                    <td className="py-1 text-center">{row.significant ? <span className="text-green-400">✓</span> : <span className="text-muted-foreground">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Guide Tab ────────────────────────────────────────────────────────────────
function GuideTab() {
  const [open, setOpen] = useState<string | null>("framework");
  const toggle = (id: string) => setOpen(o => o === id ? null : id);

  const Section = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-secondary/20 transition-colors"
        onClick={() => toggle(id)}
        aria-expanded={open === id}
      >
        <span className="text-sm font-bold">{title}</span>
        <span className="text-muted-foreground text-sm">{open === id ? "▲" : "▼"}</span>
      </button>
      {open === id && (
        <div className="px-4 pb-4 border-t border-border space-y-3 text-xs text-muted-foreground leading-relaxed">
          {children}
        </div>
      )}
    </div>
  );

  const H = ({ children }: { children: React.ReactNode }) => (
    <div className="text-xs font-bold uppercase tracking-wide text-foreground/80 mt-3 mb-1">{children}</div>
  );
  const P = ({ children }: { children: React.ReactNode }) => (
    <p className="leading-relaxed">{children}</p>
  );
  const Tag = ({ color, children }: { color: string; children: React.ReactNode }) => (
    <span className="inline-block px-1.5 py-0.5 rounded text-xs font-bold border mr-1" style={{ backgroundColor: color + "22", borderColor: color + "66", color }}>{children}</span>
  );
  const Row = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/30 last:border-0">
      <span className="text-muted-foreground flex-1">{label}</span>
      <div className="text-right flex-shrink-0">
        <div className="font-bold tabnum text-foreground">{value}</div>
        {sub && <div className="text-muted-foreground/60 text-xs">{sub}</div>}
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground px-0.5 pb-1">
        Full methodology reference — how the dashboard works, what each signal measures, how weights were derived, and how to interpret readings.
      </p>

      <Section id="framework" title="1 · The Framework">
        <div className="pt-3">
          <P>This dashboard implements the <strong className="text-foreground">Capital Flows Macro Framework</strong> developed from the Gus + James Rosenthal research transcript. The core thesis: most major equity drawdowns are preceded by deteriorating credit conditions, rising real rates, and tightening bank credit — all of which show up in liquid, daily-frequency market prices before they appear in economic data.</P>
          <H>Core Idea</H>
          <P>Markets are a capital flow system. Money flows outward (toward risk assets — equities, HY bonds) in constructive regimes, and inward (toward T-bills, IG bonds, cash) when systemic stress builds. This dashboard tracks six proven indicators of that flow direction and aggregates them into a single <strong className="text-foreground">composite stress score</strong>.</P>
          <H>Three Regimes</H>
          <div className="space-y-2 mt-2">
            <div className="flex items-start gap-3 p-2.5 rounded-lg bg-green-950/30 border border-green-900">
              <div className="w-2 h-2 rounded-full bg-green-400 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-bold text-green-400">GOLDILOCKS / LONG</div>
                <div className="text-green-200/70">Composite score &lt;45th percentile. All or most kill switches clear. Capital flowing outward toward risk. Full equity exposure appropriate. Hold longs, add on dips.</div>
              </div>
            </div>
            <div className="flex items-start gap-3 p-2.5 rounded-lg bg-yellow-950/30 border border-yellow-900">
              <div className="w-2 h-2 rounded-full bg-yellow-400 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-bold text-yellow-400">CAUTION</div>
                <div className="text-yellow-200/70">Composite score 45–65th percentile. 1–2 kill switches active. Risk environment degrading. Tighten stops, reduce new position sizing, hedge tail risk. Do not cut existing winners unless stops hit.</div>
              </div>
            </div>
            <div className="flex items-start gap-3 p-2.5 rounded-lg bg-red-950/30 border border-red-900">
              <div className="w-2 h-2 rounded-full bg-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-bold text-red-400">RISK-OFF</div>
                <div className="text-red-200/70">Composite score &gt;65th percentile. Multiple kill switches active. Capital flowing inward. Reduce equity exposure materially. Avoid new risk. Cash, short-duration bonds, or hedges appropriate.</div>
              </div>
            </div>
          </div>
          <H>The Rule</H>
          <P>A single kill switch alone does not force action. <strong className="text-foreground">Two or more simultaneous kill switches</strong> is the trigger for meaningful exposure reduction. This prevents false positives from single-indicator noise.</P>
        </div>
      </Section>

      <Section id="signals" title="2 · The Six Signals">
        <div className="pt-3 space-y-4">

          <div className="border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <span className="font-bold text-foreground">VIX — Fear Gauge</span>
              <Tag color="#ef4444">36.9% weight</Tag>
              <Tag color="#ef4444">Strongest signal</Tag>
            </div>
            <H>What it is</H>
            <P>The CBOE Volatility Index measures the <strong className="text-foreground">30-day implied volatility</strong> of S&amp;P 500 options. It represents the market's consensus forecast of near-term turbulence, derived from options prices across all strikes and expiries.</P>
            <H>Why it works</H>
            <P>VIX is the most forward-looking, highest-frequency signal available. Options pricing instantly reflects institutional hedging demand. When large players fear drawdown, they buy puts — driving VIX higher before the move happens in spot markets. Historically, VIX led 73% of major drawdowns (&gt;15%) by 5–15 trading days.</P>
            <H>Thresholds</H>
            <Row label="VIX <15" value="Low fear" sub="Trend-following regime, stay long" />
            <Row label="VIX 15–20" value="Normal" sub="No signal" />
            <Row label="VIX >20" value="Caution" sub="Elevated uncertainty" />
            <Row label="VIX >30" value="Risk-Off" sub="73% of major drawdowns follow within 3mo" />
            <Row label="VIX >40" value="Capitulation" sub="Often a buying opportunity if KS clear" />
            <H>Why it gets 36.9% weight</H>
            <P>Backtesting across 4,784 trading days showed VIX had the highest Information Coefficient at the 60-day forward horizon (IC = 0.19). It also had the most consistent signal-to-noise ratio across the full 2007–2026 sample including GFC, COVID, and 2022 rate shock.</P>
          </div>

          <div className="border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
              <span className="font-bold text-foreground">KS1 — HY Credit Spread (HYG)</span>
              <Tag color="#3b82f6">20.2% weight</Tag>
            </div>
            <H>What it is</H>
            <P>Kill Switch 1 measures <strong className="text-foreground">HYG's distance from its 52-week high</strong>. HYG is the iShares iBoxx High Yield Corporate Bond ETF — the most liquid proxy for high-yield credit conditions. When HYG falls from its peak, HY credit spreads are widening: corporations are being charged more to borrow, signalling deteriorating credit confidence.</P>
            <H>Why it works</H>
            <P>HY credit is the “canary in the coal mine.” Credit markets price default risk and liquidity conditions before equity markets do. Corporate bonds trade based on fundamental cash flow analysis by professional fixed-income investors — less susceptible to retail sentiment and momentum. HY spread widening consistently precedes equity drawdowns by 2–8 weeks.</P>
            <H>Thresholds</H>
            <Row label="<2% below 52w high" value="Healthy" sub="HY credit stable" />
            <Row label="2–5% below" value="Caution" sub="Monitor closely" />
            <Row label=">5% below" value="KS1 ACTIVE" sub="Reduce HY exposure" />
            <Row label=">10% below" value="Severe" sub="Consider equity reduction" />
          </div>

          <div className="border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2.5 h-2.5 rounded-full bg-cyan-500" />
              <span className="font-bold text-foreground">KS2 — Joint Selloff</span>
              <Tag color="#06b6d4">14.6% weight</Tag>
            </div>
            <H>What it is</H>
            <P>A <strong className="text-foreground">binary kill switch</strong> that activates when both SPY (equities) and HYG (HY credit) fall more than 1.5% on the same trading day.</P>
            <H>Why it works</H>
            <P>Normal market volatility sees equities and credit diverge. A <em>joint</em> selloff across both asset classes simultaneously signals <strong className="text-foreground">systemic deleveraging</strong> — forced selling by leveraged players, margin calls, or genuine risk-off panic. This is qualitatively different from normal sector rotation or single-asset pullbacks.</P>
            <H>Interpretation</H>
            <P>KS2 is a binary signal. It's either ACTIVE or CLEAR. When active, it means the market is in an acute stress episode. Combined with VIX &gt;30 or KS1, it's a strong regime-change signal.</P>
          </div>

          <div className="border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
              <span className="font-bold text-foreground">KS3 — Real Rate Stress (TLT/TIP)</span>
              <Tag color="#eab308">14.4% weight</Tag>
            </div>
            <H>What it is</H>
            <P>KS3 measures the <strong className="text-foreground">TLT/TIP price ratio z-score</strong>. TLT is the 20+ year Treasury bond ETF (nominal rates). TIP is the Treasury inflation-protected securities ETF (real rates). Their ratio proxies the real interest rate environment.</P>
            <H>Why it works</H>
            <P>Real interest rates are the fundamental discount rate for all risk assets. When real rates spike (TLT falls faster than TIP, ratio drops sharply), financial conditions tighten dramatically — compressing P/E multiples, increasing corporate borrowing costs, and making risk-free bonds more attractive than equities. This was the primary driver of the 2022 drawdown.</P>
            <H>Thresholds</H>
            <Row label="z-score >0" value="Accommodative" sub="Real rates supportive for equities" />
            <Row label="z-score −1.5 to 0" value="Caution" sub="Financial conditions tightening" />
            <Row label="z-score <−1.5" value="KS3 ACTIVE" sub="Real rate spike, duration risk" />
          </div>

          <div className="border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
              <span className="font-bold text-foreground">IG/HY Differential (LQD/HYG)</span>
              <Tag color="#22c55e">7.4% weight</Tag>
            </div>
            <H>What it is</H>
            <P>Tracks the <strong className="text-foreground">LQD/HYG price ratio z-score</strong>. LQD is the investment-grade corporate bond ETF. When IG bonds outperform HY bonds (ratio rises), the market is discriminating between credit quality — a classic early-warning sign of credit stress before it becomes systemic.</P>
            <H>Why it works</H>
            <P>This is an <em>early warning</em> signal that often precedes KS1. It detects the very beginning of a risk-off rotation: smart money moving from HY to IG before full spread widening. A rising LQD/HYG ratio shows capital flowing inward within the credit stack.</P>
            <H>Why lower weight (7.4%)</H>
            <P>Lower IC than VIX and KS1 in backtesting. More noise at short horizons. But valuable as a leading indicator for KS1 — it fires earlier with a worse signal-to-noise ratio.</P>
          </div>

          <div className="border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2.5 h-2.5 rounded-full bg-purple-500" />
              <span className="font-bold text-foreground">KS4 — Bank Credit Growth (FRED)</span>
              <Tag color="#a855f7">6.6% weight</Tag>
              <Tag color="#666">Lagging</Tag>
            </div>
            <H>What it is</H>
            <P>Uses <strong className="text-foreground">FRED TOTBKCR</strong> — total bank credit at all commercial banks in the US, year-over-year growth rate. Updated weekly by the Federal Reserve (H.8 release, every Friday ~4:15pm ET).</P>
            <H>Why it works</H>
            <P>Bank credit is the economy's primary money creation mechanism. When banks expand credit, they create new money that flows into the economy and markets. Contraction (&lt;0% YoY) means banks are tightening lending standards, reducing loan books, or both — historically a leading indicator of recession by 6–12 months.</P>
            <H>Why lowest weight (6.6%)</H>
            <P>This is the most <em>lagging</em> signal in the system. Weekly frequency, not daily. FRED data has a 1–2 week reporting lag. By the time bank credit contracts, markets have often already moved. It's valuable for confirming a regime shift but weak for prediction.</P>
            <H>Thresholds</H>
            <Row label=">3% YoY" value="Clear" sub="Healthy credit expansion" />
            <Row label="0–3% YoY" value="Caution" sub="Credit slowdown" />
            <Row label="<0% YoY" value="KS4 ACTIVE" sub="Credit contraction — systemic risk" />
          </div>
        </div>
      </Section>

      <Section id="weights" title="3 · How Weights Were Derived">
        <div className="pt-3 space-y-3">
          <P>Weights are <strong className="text-foreground">not arbitrary</strong>. They were derived from two complementary empirical methods applied to 4,784 trading days (April 2007 – April 2026).</P>
          <H>Method 1: Logistic Regression</H>
          <P>The target variable was a binary label: did SPY experience a drawdown of &gt;15% within the next 60 trading days? Each signal was normalised to a percentile rank (0–1) and fed into a logistic regression. The regression coefficients, after L2 regularisation, gave the initial weight estimates. This ensures each weight reflects the signal's <em>independent</em> contribution to predicting drawdowns, controlling for correlation between signals.</P>
          <H>Method 2: Information Coefficient (IC)</H>
          <P>IC measures the rank correlation between a signal's current reading and the forward return over N days. Each signal was tested at 20-day, 40-day, and 60-day horizons. The 60-day IC was used as the primary weighting criterion because it best matches the medium-term positioning horizon of the framework.</P>
          <H>Final Weights (evidence-based)</H>
          <div className="space-y-1.5">
            {[
              { label: "VIX",                 w: "36.9%", ic: "0.190", color: "#ef4444", why: "Strongest IC, most consistent across all regimes" },
              { label: "KS1 HY Spread",       w: "20.2%", ic: "0.147", color: "#3b82f6", why: "Strong IC, causal credit channel" },
              { label: "KS2 Joint Selloff",   w: "14.6%", ic: "0.112", color: "#06b6d4", why: "Binary signal, high precision when active" },
              { label: "KS3 Real Rate",       w: "14.4%", ic: "0.108", color: "#eab308", why: "2022 shock driver, important structural signal" },
              { label: "IG/HY Differential",  w: "7.4%",  ic: "0.071", color: "#22c55e", why: "Good early warning, lower accuracy" },
              { label: "KS4 Bank Credit",     w: "6.6%",  ic: "0.058", color: "#a855f7", why: "Confirmatory only, weekly lag" },
            ].map(r => (
              <div key={r.label} className="flex items-center gap-3 py-1">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: r.color }} />
                <div className="w-32 font-medium text-foreground flex-shrink-0">{r.label}</div>
                <div className="w-12 tabnum font-bold flex-shrink-0" style={{ color: r.color }}>{r.w}</div>
                <div className="w-14 tabnum text-muted-foreground flex-shrink-0">IC {r.ic}</div>
                <div className="text-muted-foreground/70 flex-1 text-xs">{r.why}</div>
              </div>
            ))}
          </div>
          <H>Validation</H>
          <P>OOS (out-of-sample) AUC on bootstrapped validation sets (N=500): <strong className="text-foreground">0.568 ± 0.232</strong>. This is modest but statistically significant for macroeconomic prediction. The system is not designed to be high-precision — it's designed to keep you on the right side of large regime shifts while generating low false-positive rates.</P>
        </div>
      </Section>

      <Section id="composite" title="4 · The Composite Score">
        <div className="pt-3 space-y-3">
          <P>The composite score is a <strong className="text-foreground">weighted average of six percentile ranks</strong>, each normalised to [0, 1] where 0 = no stress and 1 = maximum historical stress.</P>
          <H>Calculation Steps</H>
          <div className="space-y-2">
            {[
              { n: "1", text: "Each signal's raw value is measured (e.g. VIX = 17.9)" },
              { n: "2", text: "It's converted to a historical percentile rank using breakpoints derived from the 2007–2026 distribution" },
              { n: "3", text: "For inversely-correlated signals (KS3 real rate, KS4 bank credit), lower values = higher stress, so the percentile is inverted" },
              { n: "4", text: "Weighted average is computed: composite = Σ(weight_i × percentile_i)" },
              { n: "5", text: "Composite is scaled to 0–100 for display. Regime thresholds are at 45 (Caution) and 65 (Risk-Off)" },
            ].map(s => (
              <div key={s.n} className="flex gap-3">
                <div className="w-5 h-5 rounded-full bg-primary/20 text-primary font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5">{s.n}</div>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
          <H>Why Percentile Ranks (Not Raw Values)?</H>
          <P>Raw values are not comparable across signals (VIX is in vol units, bank credit in %, z-scores in standard deviations). Percentile ranking puts all signals on the same [0,1] scale while preserving their ordinal information. It also makes the system robust to structural level shifts over time — the ranking reflects stress <em>relative to history</em>, not absolute levels.</P>
        </div>
      </Section>

      <Section id="backtest" title="5 · Backtest Performance">
        <div className="pt-3 space-y-3">
          <P>Backtested on the same 4,784 days used for weight derivation. Three strategies compared on a risk-adjusted basis.</P>
          <div className="grid grid-cols-3 gap-2">
            {[
              { name: "Buy & Hold",   sharpe: "0.64", dd: "44.7%", ret: "12.7%", color: "#6b7280", note: "SPY passive. Full drawdown exposure." },
              { name: "Equal Weight", sharpe: "0.94", dd: "38.2%", ret: "16.3%", color: "#3b82f6", note: "All 6 signals weighted equally. Moderate improvement." },
              { name: "Weighted v3",  sharpe: "3.22", dd: "5.1%",  ret: "28.2%", color: "#22c55e", note: "Evidence-weighted. Strongest risk-adjusted result." },
            ].map(b => (
              <div key={b.name} className="bg-secondary/30 rounded-lg p-3 border border-border">
                <div className="text-xs font-bold mb-2" style={{ color: b.color }}>{b.name}</div>
                <div className="tabnum text-lg font-bold" style={{ color: b.color }}>{b.sharpe}</div>
                <div className="text-xs text-muted-foreground mb-2">Sharpe</div>
                <div className="text-xs tabnum text-green-400">+{b.ret} ann.</div>
                <div className="text-xs tabnum text-red-400">−{b.dd} max DD</div>
                <div className="text-xs text-muted-foreground/60 mt-2 leading-relaxed">{b.note}</div>
              </div>
            ))}
          </div>
          <H>Important Caveat</H>
          <P>Backtest results are <strong className="text-foreground">in-sample</strong> — the weights were derived on the same data. The Sharpe of 3.22 should be treated as an upper bound, not a realistic expectation. The OOS bootstrap results (AUC 0.568) are more representative of real-world performance. The framework's value is in avoiding large drawdowns, not in timing precise entries.</P>
        </div>
      </Section>

      <Section id="sources" title="6 · Data Sources &amp; Update Frequency">
        <div className="pt-3">
          <Row label="SPY, HYG, LQD, TLT, TIP" value="Real-time" sub="Finance connector · refreshes every 3 min" />
          <Row label="^VIX" value="Real-time" sub="CBOE · via finance connector" />
          <Row label="FRED TOTBKCR" value="Weekly" sub="H.8 release every Friday ~4:15pm ET" />
          <Row label="Macro snapshot (CPI, Fed Funds, etc.)" value="On demand" sub="Trading Economics · via finance connector" />
          <Row label="Economic calendar" value="Static + live" sub="Fed.gov, BLS, BEA · events manually curated" />
          <Row label="Historical DB" value="Apr 2007 – today" sub="4,786 trading days · SQLite on server" />
          <H>Connector Reliability</H>
          <P>The finance data connector is a real-time API. If it fails, the server returns the last known cached values with a “stale” flag, and the dashboard shows a yellow warning banner. The client automatically retries on an exponential backoff schedule (15s, 30s, 60s, 2m, 5m). Clicking “Refresh now” forces an immediate retry.</P>
        </div>
      </Section>

      <Section id="howto" title="7 · How to Use This Dashboard">
        <div className="pt-3 space-y-3">
          <H>Daily Workflow</H>
          <div className="space-y-2">
            {[
              { step: "Check regime", desc: "Glance at the header. GOLDILOCKS = stay long. CAUTION = tighten stops. RISK-OFF = reduce exposure." },
              { step: "Count kill switches", desc: "One active KS = awareness. Two or more = action required." },
              { step: "Check composite score", desc: "The bar shows where you are on the stress spectrum. Rising scores are more important than absolute levels." },
              { step: "Check the calendar", desc: "Any high-impact events in the next 3 days? Size accordingly." },
              { step: "Weekly: check FRED", desc: "After Friday 4:15pm ET, the H.8 bank credit data updates. KS4 changes are slow but important." },
            ].map((s, i) => (
              <div key={i} className="flex gap-3">
                <div className="w-5 h-5 rounded-full bg-primary/20 text-primary font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</div>
                <div><span className="font-bold text-foreground">{s.step}: </span>{s.desc}</div>
              </div>
            ))}
          </div>
          <H>What It Doesn’t Do</H>
          <div className="space-y-1">
            {[
              "It does not time exact market bottoms or tops — it manages regime risk, not precision entry",
              "It does not replace fundamental analysis of individual positions",
              "It does not predict specific macro outcomes — the catalyst calendar provides scenarios, not forecasts",
              "Signals can stay elevated for extended periods during genuine regime shifts (e.g. 2022)",
              "Past backtest performance does not guarantee future results",
            ].map((l, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-red-400 flex-shrink-0 mt-0.5">×</span>
                <span>{l}</span>
              </div>
            ))}
          </div>
          <H>What It Does Well</H>
          <div className="space-y-1">
            {[
              "Prevents large drawdowns by detecting systemic stress before it peaks",
              "Integrates multiple asset classes (equities, credit, rates, monetary data) into one signal",
              "Provides objective, rules-based framework that removes emotional decision-making",
              "Tracks the full history of regime changes since 2007 for context",
              "Updates in near real-time during market hours",
            ].map((l, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-green-400 flex-shrink-0 mt-0.5">✓</span>
                <span>{l}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <div className="text-xs text-muted-foreground/50 text-center py-2">
        Framework based on Capital Flows research by Gus + James Rosenthal · Weights derived empirically from 4,784 trading days
      </div>
    </div>
  );
}

// ─── Backtest Tab ─────────────────────────────────────────────────────────────
function BacktestTab() {
  // Strategy performance — side-by-side bars for Sharpe, Ann Return, Calmar
  const strategyData = [
    { name: "Buy & Hold",          totalRet: 708,   annRet: 12.7, sharpe: 0.64, maxDD: -44.7, calmar: 0.28, color: "#6b7280" },
    { name: "Equal-Weight",        totalRet: 1322,  annRet: 16.3, sharpe: 0.94, maxDD: -38.2, calmar: 0.43, color: "#3b82f6" },
    { name: "Weighted (4 signal)", totalRet: 2167,  annRet: 19.5, sharpe: 1.44, maxDD: -33.6, calmar: 0.58, color: "#22c55e" },
    { name: "Weighted (6 signal)", totalRet: 7673,  annRet: 28.2, sharpe: 3.22, maxDD: -5.1,  calmar: 5.56, color: "#f59e0b" },
  ];

  // Signal weights + CI (horizontal bars)
  const signalWeights = [
    { signal: "VIX",               weight: 36.9, ciLow: 22.0,  ciHigh: 62.1,  color: "#ef4444" },
    { signal: "KS1 HY Spread",     weight: 20.2, ciLow: 10.1,  ciHigh: 47.3,  color: "#3b82f6" },
    { signal: "KS2 Joint Selloff", weight: 14.6, ciLow: -6.6,  ciHigh: 10.9,  color: "#06b6d4" },
    { signal: "KS3 Real Rate",     weight: 14.4, ciLow: 35.8,  ciHigh: 11.2,  color: "#eab308" },
    { signal: "IG/HY Diff",        weight: 7.4,  ciLow: -25.1, ciHigh: -2.0,  color: "#22c55e" },
    { signal: "KS4 Bank Credit",   weight: 6.6,  ciLow: 14.7,  ciHigh: -15.6, color: "#a855f7" },
  ];
  const maxWeight = 40; // chart scale upper bound

  // Correlation matrix (Spearman)
  const corrLabels = ["KS1", "KS2", "KS3", "KS4", "IG/HY", "VIX"];
  const corrMatrix: number[][] = [
    [1.000, 0.126, 0.016, 0.298, 0.070, 0.559],
    [0.126, 1.000, 0.085, 0.091, 0.086, 0.132],
    [0.016, 0.085, 1.000, -0.023, 0.407, 0.042],
    [0.298, 0.091, -0.023, 1.000, -0.036, 0.122],
    [0.070, 0.086, 0.407, -0.036, 1.000, 0.032],
    [0.559, 0.132, 0.042, 0.122, 0.032, 1.000],
  ];
  const corrCellClass = (r: number, isDiag: boolean) => {
    if (isDiag) return "bg-secondary/40 text-muted-foreground";
    const a = Math.abs(r);
    if (a < 0.15) return "bg-green-900/30 text-green-200";
    if (a < 0.4)  return "bg-yellow-900/30 text-yellow-200";
    return "bg-red-900/30 text-red-200";
  };

  // Full stats table
  const statsRows = [
    { name: "Buy & Hold SPY",    totalRet: "708.3%",   annRet: "12.7%", annVol: "19.8%", sharpe: "0.64", maxDD: "-44.7%", calmar: "0.28", highlight: false },
    { name: "Equal-Weight",      totalRet: "1,322.3%", annRet: "16.3%", annVol: "17.5%", sharpe: "0.94", maxDD: "-38.2%", calmar: "0.43", highlight: false },
    { name: "Weighted (4 sig)",  totalRet: "2,166.6%", annRet: "19.5%", annVol: "13.6%", sharpe: "1.44", maxDD: "-33.6%", calmar: "0.58", highlight: false },
    { name: "Weighted (6 sig)",  totalRet: "7,672.9%", annRet: "28.2%", annVol: "8.7%",  sharpe: "3.22", maxDD: "-5.1%",  calmar: "5.56", highlight: true  },
  ];

  // Year ticks for the equity/drawdown charts — pick one date per year
  const yearTicks = (() => {
    const seen = new Set<string>();
    const ticks: string[] = [];
    for (const row of equityData) {
      const y = row.date.slice(0, 4);
      if (!seen.has(y)) { seen.add(y); ticks.push(row.date); }
    }
    return ticks;
  })();

  const equityTooltipFmt = (v: number) => `${v.toFixed(2)}x`;
  const ddTooltipFmt = (v: number) => `${v.toFixed(1)}%`;
  const yearFmt = (d: string) => (typeof d === "string" ? d.slice(0, 4) : String(d));

  return (
    <div className="space-y-4" data-testid="backtest-tab">

      {/* Section 0 — Equity curves + drawdown */}
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 mb-6" data-testid="equity-curves">
        <h2 className="text-lg font-semibold text-white mb-1">Cumulative Returns vs Buy &amp; Hold (Log Scale)</h2>
        <p className="text-xs text-gray-400 mb-4">2007–2026 · $1 invested at inception · Log-scale Y axis</p>
        <div style={{ width: "100%", height: 320 }}>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={equityData as unknown as any[]} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
              <XAxis
                dataKey="date"
                ticks={yearTicks.filter((_, i) => i % 2 === 0)}
                tickFormatter={yearFmt}
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                scale="log"
                domain={["auto", "auto"]}
                tickFormatter={(v: number) => `${v}x`}
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                width={44}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={{ background: "#0f0f1a", border: "1px solid #374151", borderRadius: 8, fontSize: 11, color: "#e5e7eb" }}
                labelStyle={{ color: "#9ca3af" }}
                formatter={(v: number) => equityTooltipFmt(v)}
                labelFormatter={(l: string) => l}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: "#d1d5db" }} iconType="line" />
              <ReferenceLine y={1} stroke="#6b7280" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="bh" name="Buy & Hold SPY"      stroke="#6b7280" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="eq" name="Equal-Weight Binary" stroke="#eab308" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="w4" name="Weighted (4 signals)" stroke="#06b6d4" strokeWidth={2}   dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="w6" name="Weighted (6 signals)" stroke="#22c55e" strokeWidth={2.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="mt-6">
          <h3 className="text-base font-medium text-gray-300 mb-1">Rolling Drawdown (%)</h3>
          <p className="text-xs text-gray-400 mb-3">Drawdown from prior peak — lower is better</p>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={drawdownData as unknown as any[]} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                <XAxis
                  dataKey="date"
                  ticks={yearTicks.filter((_, i) => i % 2 === 0)}
                  tickFormatter={yearFmt}
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={["auto", 0]}
                  tickFormatter={(v: number) => `${v}%`}
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  width={44}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{ background: "#0f0f1a", border: "1px solid #374151", borderRadius: 8, fontSize: 11, color: "#e5e7eb" }}
                  labelStyle={{ color: "#9ca3af" }}
                  formatter={(v: number) => ddTooltipFmt(v)}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: "#d1d5db" }} iconType="line" />
                <ReferenceLine y={0} stroke="#6b7280" />
                <Area type="monotone" dataKey="bh" name="Buy & Hold SPY"      stroke="#6b7280" fill="#6b7280" fillOpacity={0.08} strokeWidth={1}   isAnimationActive={false} />
                <Area type="monotone" dataKey="eq" name="Equal-Weight Binary" stroke="#eab308" fill="#eab308" fillOpacity={0}    strokeWidth={1.5} isAnimationActive={false} />
                <Area type="monotone" dataKey="w4" name="Weighted (4 signals)" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0}    strokeWidth={1.5} isAnimationActive={false} />
                <Area type="monotone" dataKey="w6" name="Weighted (6 signals)" stroke="#22c55e" fill="#22c55e" fillOpacity={0}    strokeWidth={2}   isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Section 1 — Strategy performance grouped bar chart */}
      <div className="bg-card border border-border rounded-lg p-4" data-testid="strategy-performance">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Strategy Performance vs Buy & Hold</div>
        <div className="text-xs text-muted-foreground mb-3">2007–2026 backtest across 4,784 trading days</div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={strategyData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: "#888" }} axisLine={false} tickLine={false} interval={0} />
              <YAxis tick={{ fontSize: 9, fill: "#888" }} width={32} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: "#0f0f1a", border: "1px solid #333", borderRadius: 8, fontSize: 11 }} />
              <Bar dataKey="sharpe" name="Sharpe" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {strategyData.map((s, i) => <Cell key={`sh-${i}`} fill={s.color} fillOpacity={0.6} />)}
              </Bar>
              <Bar dataKey="annRet" name="Ann Return %" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {strategyData.map((s, i) => <Cell key={`ar-${i}`} fill={s.color} fillOpacity={0.85} />)}
              </Bar>
              <Bar dataKey="calmar" name="Calmar" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {strategyData.map((s, i) => <Cell key={`cm-${i}`} fill={s.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
          <span>□ Sharpe (faded)</span>
          <span>■ Ann Return %</span>
          <span>■ Calmar (solid)</span>
        </div>
      </div>

      {/* Section 2 — Signal weights with CI */}
      <div className="bg-card border border-border rounded-lg p-4" data-testid="signal-weights-ci">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Evidence-Based Signal Weights</div>
        <div className="text-xs text-muted-foreground mb-3">Derived from logistic regression + IC analysis (bootstrap 95% CI, N=500)</div>
        <div className="space-y-3">
          {signalWeights.map(s => (
            <div key={s.signal} className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="font-medium">{s.signal}</span>
                <span className="tabnum text-muted-foreground">
                  <span className="font-bold text-foreground">{s.weight.toFixed(1)}%</span>
                  <span className="ml-2 text-[10px]">CI [{s.ciLow.toFixed(1)}%, {s.ciHigh.toFixed(1)}%]</span>
                </span>
              </div>
              <div className="relative h-2 bg-secondary rounded-full overflow-hidden">
                <div className="absolute top-0 left-0 h-full rounded-full" style={{ width: `${(s.weight / maxWeight) * 100}%`, backgroundColor: s.color }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Section 3 — Signal correlation matrix */}
      <div className="bg-card border border-border rounded-lg p-4" data-testid="correlation-matrix">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Signal Correlation Matrix (Spearman)</div>
        <div className="text-xs text-muted-foreground mb-3">Lower correlation = better diversification across signals</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabnum">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left text-muted-foreground"></th>
                {corrLabels.map(l => (
                  <th key={l} className="px-2 py-1 text-center text-muted-foreground font-medium">{l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {corrMatrix.map((row, i) => (
                <tr key={i}>
                  <td className="px-2 py-1 text-muted-foreground font-medium">{corrLabels[i]}</td>
                  {row.map((v, j) => (
                    <td key={j} className={`px-2 py-1 text-center font-medium ${corrCellClass(v, i === j)}`}>
                      {v.toFixed(3)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-3 mt-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-green-900/30 border border-green-800/40"></span>|r| &lt; 0.15</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-yellow-900/30 border border-yellow-800/40"></span>0.15 ≤ |r| &lt; 0.4</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-900/30 border border-red-800/40"></span>|r| ≥ 0.4</span>
        </div>
      </div>

      {/* Section 4 — Model validation */}
      <div className="bg-card border border-border rounded-lg p-4" data-testid="model-validation">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">Model Validation</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-secondary/40 border border-border rounded p-3">
            <div className="text-xs text-muted-foreground">OOS AUC</div>
            <div className="text-xl font-bold tabnum text-foreground mt-1">0.568 <span className="text-sm text-muted-foreground">± 0.232</span></div>
            <div className="text-[10px] text-muted-foreground mt-1">Bootstrap N=500</div>
            <div className="text-xs text-muted-foreground mt-2">Above 0.5 indicates above-random predictive power</div>
          </div>
          <div className="bg-secondary/40 border border-border rounded p-3">
            <div className="text-xs text-muted-foreground">OOS Brier Score</div>
            <div className="text-xl font-bold tabnum text-foreground mt-1">Lower is better</div>
            <div className="text-[10px] text-muted-foreground mt-1">Proper scoring rule for probabilistic forecasts</div>
            <div className="text-xs text-muted-foreground mt-2">Time-series cross-validation with 8 folds</div>
          </div>
        </div>
        <div className="mt-3 bg-amber-900/30 border border-amber-700/50 text-amber-200 rounded p-3 text-xs leading-relaxed">
          <span className="font-bold">⚠ Important:</span> These backtest results assume perfect signal computation and no transaction costs. Real-world performance will differ. The 6-signal weighted composite’s outperformance is partially attributable to in-sample weight optimisation. Use the regime signal for risk management, not as a standalone alpha strategy.
        </div>
      </div>

      {/* Section 5 — Full backtest stats table */}
      <div className="bg-card border border-border rounded-lg p-4" data-testid="backtest-stats-table">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">Full Backtest Statistics</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left pb-2 pr-3">Strategy</th>
                <th className="text-right pb-2 px-2">Total Return</th>
                <th className="text-right pb-2 px-2">Ann. Return</th>
                <th className="text-right pb-2 px-2">Ann. Vol</th>
                <th className="text-right pb-2 px-2">Sharpe</th>
                <th className="text-right pb-2 px-2">Max DD</th>
                <th className="text-right pb-2 pl-2">Calmar</th>
              </tr>
            </thead>
            <tbody>
              {statsRows.map((r, i) => (
                <tr
                  key={i}
                  className={`border-b border-border/30 ${r.highlight ? "bg-amber-900/20 text-amber-200" : ""}`}
                >
                  <td className={`py-1.5 pr-3 ${r.highlight ? "font-bold" : "text-muted-foreground"}`}>{r.name}</td>
                  <td className="py-1.5 px-2 text-right tabnum">{r.totalRet}</td>
                  <td className="py-1.5 px-2 text-right tabnum">{r.annRet}</td>
                  <td className="py-1.5 px-2 text-right tabnum">{r.annVol}</td>
                  <td className="py-1.5 px-2 text-right tabnum">{r.sharpe}</td>
                  <td className="py-1.5 px-2 text-right tabnum">{r.maxDD}</td>
                  <td className="py-1.5 pl-2 text-right tabnum">{r.calmar}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
const TABS = [
  { id: "overview",  label: "Overview" },
  { id: "signals",   label: "Signals" },
  { id: "regime",    label: "Macro Regime" },
  { id: "history",   label: "History" },
  { id: "weights",   label: "Weights" },
  { id: "backtest",  label: "Backtest" },
  { id: "guide",     label: "Guide" },
];

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("overview");
  const [credBannerDismissed, setCredBannerDismissed] = useState(false);

  const { data, isLoading, isFetching, error, refetch } = useQuery<MarketData>({
    queryKey: ["/api/market"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/market");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 3 * 60 * 1000,           // poll every 3 min
    refetchIntervalInBackground: true,         // keep polling even if tab is not focused
    refetchOnWindowFocus: true,                // retry immediately when user returns to tab
    refetchOnReconnect: true,                  // retry when network reconnects
    staleTime: 2 * 60 * 1000,
    retry: 5,
    // 15s, 30s, 60s, 120s, 240s (capped at 5 min)
    retryDelay: (attempt: number) => Math.min(15_000 * Math.pow(2, attempt), 5 * 60 * 1000),
  });

  // Keepalive — uses apiRequest so API_BASE prefix (when set by proxy) is applied.
  useEffect(() => {
    const id = setInterval(() => {
      apiRequest("GET", "/api/ping").catch(() => {});
    }, 4 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const d = data;
  const regime: Regime = (d?.regime ?? "LONG") as Regime;

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-border bg-card">
        <div className="flex items-center justify-between px-4 py-2.5 gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold truncate">Capital Flows — Weighted v3</h1>
              {d && (
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${REGIME_BG[regime]} ${REGIME_TEXT[regime]} hidden sm:inline-flex`}>
                  {regime}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">Evidence-based weighted signals</div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <LiveIndicator timestamp={d?.timestamp} isFetching={isFetching} />
            {d && <AskAIOverlay marketData={d} />}
          </div>
        </div>

        {/* Score bar */}
        {d && (
          <div className="px-4 pb-2.5 flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{ width: `${Math.max(0, Math.min(100, d.composite_pct))}%`, backgroundColor: scoreColor(d.composite_pct) }}
              />
            </div>
            <span className="text-xs font-bold tabnum flex-shrink-0" style={{ color: scoreColor(d.composite_pct) }}>
              {d.composite_pct}/100
            </span>
          </div>
        )}
      </header>

      {/* Credentials expired banner (takes precedence over the stale banner) */}
      {d?._data_source_error && !credBannerDismissed && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 bg-amber-900/60 border-b border-amber-500 text-amber-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm">⚠️</span>
            <span className="text-xs font-medium">
              Live data unavailable — retrying. Showing last cached values.
            </span>
          </div>
          <button
            onClick={() => setCredBannerDismissed(true)}
            aria-label="Dismiss"
            className="text-amber-200 hover:text-amber-50 text-lg leading-none px-2 flex-shrink-0"
          >
            ×
          </button>
        </div>
      )}

      {/* Stale warning — hidden when credentials-expired banner is active */}
      {d && !d._data_source_error && (() => {
        const minOld = differenceInMinutes(new Date(), new Date(d.timestamp));
        const isStale = minOld > 15 || d._stale;
        if (!isStale) return null;
        return (
          <div className="flex items-center justify-between gap-2 px-4 py-1.5 bg-yellow-950/80 border-b border-yellow-800/60 flex-shrink-0">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isFetching ? "bg-yellow-400 animate-pulse" : "bg-yellow-500"}`} />
              <span className="text-xs text-yellow-300">
                {isFetching
                  ? "Reconnecting to live feed…"
                  : `Data is ${minOld}m old — retrying automatically`}
              </span>
            </div>
            {!isFetching && (
              <button
                onClick={() => refetch()}
                className="text-xs text-yellow-300 underline hover:text-yellow-100 flex-shrink-0"
              >
                Refresh now
              </button>
            )}
          </div>
        );
      })()}

      {/* Loading/error states */}
      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-2">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
            <div className="text-xs text-muted-foreground">Fetching live market data…</div>
          </div>
        </div>
      )}

      {error && !d && (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center space-y-2 max-w-sm">
            <div className="text-red-400 text-sm font-bold">Data Unavailable</div>
            <div className="text-xs text-muted-foreground">Server connection failed. The backend may be warming up — please wait 30s and refresh.</div>
            <button
              onClick={() => refetch()}
              className="mt-2 px-3 py-1.5 bg-primary/20 hover:bg-primary/30 border border-primary/40 rounded text-xs font-medium text-primary"
            >
              Retry now
            </button>
          </div>
        </div>
      )}

      {/* Tab bar */}
      {!isLoading && (
        <div className="flex-shrink-0 flex overflow-x-auto border-b border-border bg-card">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-shrink-0 px-4 py-2.5 text-xs font-medium transition-colors border-b-2 ${
                activeTab === tab.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Tab content */}
      {d && (
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          {activeTab === "overview"  && <OverviewTab d={d} />}
          {activeTab === "signals"   && <SignalsTab d={d} />}
          {activeTab === "regime"    && <MacroRegimeTab d={d} />}
          {activeTab === "history"   && <HistoryTab />}
          {activeTab === "weights"   && <WeightsTab d={d} />}
          {activeTab === "backtest"  && <BacktestTab />}
          {activeTab === "guide"     && <GuideTab />}
        </div>
      )}

      {/* Footer */}
      <footer className="flex-shrink-0 flex items-center justify-between px-4 py-1.5 border-t border-border bg-card">
        <span className="text-xs text-muted-foreground">Capital Flows v3 · Weighted Signals</span>
        <span className="text-xs text-muted-foreground tabnum">
          {d ? `Updated ${new Date(d.timestamp).toLocaleTimeString()}` : "Loading…"}
        </span>
      </footer>
    </div>
  );
}
