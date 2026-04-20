import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { ExternalLink, ChevronDown, ChevronUp, RefreshCw, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface Scenario {
  label: string;
  desc: string;
}

interface CatalystEvent {
  id: string;
  date: string;
  endDate?: string;
  event: string;
  period: string;
  type: string;
  impact: "high" | "medium" | "low";
  sourceUrl: string;
  sourceName: string;
  note: string;
  daysOut: number;
  isPast: boolean;
  consensus: string;
  expected: string;
  bull: Scenario;
  base: Scenario;
  bear: Scenario;
}

interface CatalystData {
  events: CatalystEvent[];
  macroData: Record<string, number>;
  fetchedAt: string;
}

const TYPE_STYLE: Record<string, string> = {
  fed:       "bg-purple-900/50 border-purple-700 text-purple-300",
  inflation: "bg-orange-900/50 border-orange-800 text-orange-300",
  labor:     "bg-blue-900/50 border-blue-800 text-blue-300",
  growth:    "bg-yellow-900/50 border-yellow-800 text-yellow-300",
  activity:  "bg-indigo-900/50 border-indigo-800 text-indigo-300",
};

const IMPACT_COLOR: Record<string, string> = {
  high:   "bg-red-500",
  medium: "bg-yellow-500",
  low:    "bg-teal-500",
};

const TYPE_LABEL: Record<string, string> = {
  fed: "FED", inflation: "INFLATION", labor: "LABOR", growth: "GROWTH", activity: "ACTIVITY",
};

export default function CatalystCalendar() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["/api/catalysts"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/catalysts");
      const json = await res.json() as { ok: boolean; data: CatalystData };
      if (!json.ok) throw new Error("Failed to load catalysts");
      return json.data;
    },
    staleTime: 30 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });

  const formatDate = (dateStr: string, endDate?: string) => {
    const d = new Date(dateStr + "T12:00:00Z");
    const base = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (endDate) {
      const end = new Date(endDate + "T12:00:00Z");
      return `${base}–${end.getDate()}`;
    }
    return base;
  };

  const events = data?.events?.filter(e => !e.isPast && (filter === "all" || e.type === filter)) ?? [];

  return (
    <div data-testid="catalyst-calendar-live">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Macro Catalyst Calendar</span>
          {data && (
            <span className="text-xs text-muted-foreground">
              · live values from{" "}
              <a href="https://tradingeconomics.com/united-states/indicators" target="_blank" rel="noopener noreferrer"
                className="text-primary hover:underline">Trading Economics</a>
              {" / "}
              <a href="https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm" target="_blank" rel="noopener noreferrer"
                className="text-primary hover:underline">Fed.gov</a>
              {" / "}
              <a href="https://www.bls.gov/schedule/2026/home.htm" target="_blank" rel="noopener noreferrer"
                className="text-primary hover:underline">BLS</a>
            </span>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          data-testid="catalyst-refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Filter pills */}
      <div className="flex gap-1.5 flex-wrap mb-3">
        {["all", "fed", "inflation", "labor", "growth", "activity"].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-all ${
              filter === f
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border hover:border-primary/50"
            }`}
          >
            {f === "all" ? "All" : TYPE_LABEL[f]}
          </button>
        ))}
      </div>

      {/* Live macro snapshot pills */}
      {data?.macroData && (
        <div className="flex gap-2 flex-wrap mb-3">
          {[
            { label: "CPI YoY", val: data.macroData.inflationRate, unit: "%", warn: (v: number) => v > 3 },
            { label: "Core CPI", val: data.macroData.coreInflationRate, unit: "%", warn: (v: number) => v > 2.5 },
            { label: "Fed Funds", val: data.macroData.interestRate, unit: "%", warn: () => false },
            { label: "Unemployment", val: data.macroData.unemploymentRate, unit: "%", warn: (v: number) => v > 4.5 },
            { label: "GDP QoQ", val: data.macroData.gdpGrowth, unit: "%", warn: (v: number) => v < 1 },
          ].filter(m => m.val !== undefined && m.val !== null).map(m => (
            <div key={m.label} className={`text-xs px-2.5 py-1 rounded-lg border ${
              m.warn(m.val!) ? "bg-yellow-900/30 border-yellow-800 text-yellow-300" : "bg-card border-border text-muted-foreground"
            }`}>
              <span className="text-foreground font-medium">{m.val!.toFixed(1)}{m.unit}</span>
              <span className="ml-1">{m.label}</span>
            </div>
          ))}
        </div>
      )}

      {isLoading && (
        <div className="space-y-2">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      )}

      {isError && (
        <div className="text-xs text-red-400 py-3 text-center">Failed to load catalyst data. <button onClick={() => refetch()} className="underline">Retry</button></div>
      )}

      {!isLoading && !isError && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {events.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-6">No upcoming events for this filter.</div>
          )}
          {events.map((evt, i) => {
            const isOpen = expanded === evt.id;
            const isToday = evt.daysOut === 0;
            const isImminent = evt.daysOut >= 0 && evt.daysOut <= 3;

            return (
              <div key={evt.id} className={`border-b border-border last:border-0 ${isToday ? "bg-primary/5" : ""}`}
                data-testid={`catalyst-${evt.id}`}>

                {/* Row header — always visible */}
                <button
                  className="w-full text-left px-3 py-3 flex items-start gap-3 hover:bg-white/[0.02] transition-colors"
                  onClick={() => setExpanded(isOpen ? null : evt.id)}
                >
                  {/* Date */}
                  <div className="flex-shrink-0 w-14 text-center">
                    <div className="text-xs font-bold text-foreground tabnum leading-tight">
                      {formatDate(evt.date, evt.endDate)}
                    </div>
                    <div className={`text-xs tabnum mt-0.5 ${
                      isToday ? "text-primary font-bold" :
                      isImminent ? "text-yellow-400" : "text-muted-foreground"
                    }`}>
                      {isToday ? "TODAY" : evt.daysOut === 1 ? "TOMORROW" : `${evt.daysOut}d`}
                    </div>
                  </div>

                  {/* Impact dot */}
                  <div className="flex-shrink-0 mt-1.5">
                    <div className={`w-2 h-2 rounded-full ${IMPACT_COLOR[evt.impact]}`} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-foreground">{evt.event}</span>
                      <span className="text-xs text-muted-foreground">{evt.period}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${TYPE_STYLE[evt.type]}`}>
                        {TYPE_LABEL[evt.type]}
                      </span>
                      {isImminent && !isToday && (
                        <span className="text-xs px-1.5 py-0.5 rounded border bg-yellow-900/30 border-yellow-700 text-yellow-300 font-medium">IMMINENT</span>
                      )}
                    </div>
                    {/* Consensus always shown */}
                    <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-1">
                      <span className="text-foreground/70 font-medium">Consensus: </span>{evt.consensus}
                    </div>
                  </div>

                  {/* Expand chevron */}
                  <div className="flex-shrink-0 text-muted-foreground mt-0.5">
                    {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </div>
                </button>

                {/* Expanded detail */}
                {isOpen && (
                  <div className="px-3 pb-4 space-y-3 border-t border-border/50">

                    {/* What to watch */}
                    <div className="pt-3">
                      <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">What to watch</div>
                      <p className="text-xs text-foreground/80 leading-relaxed">{evt.expected}</p>
                    </div>

                    {/* Bull / Base / Bear */}
                    <div>
                      <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-2">Scenarios</div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">

                        {/* Bull */}
                        <div className="rounded-lg border border-teal-800 bg-teal-950/30 p-2.5">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <TrendingUp className="w-3 h-3 text-teal-400 flex-shrink-0" />
                            <span className="text-xs font-bold text-teal-300">BULL — {evt.bull.label}</span>
                          </div>
                          <p className="text-xs text-teal-200/80 leading-relaxed">{evt.bull.desc}</p>
                        </div>

                        {/* Base */}
                        <div className="rounded-lg border border-border bg-secondary/30 p-2.5">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <Minus className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                            <span className="text-xs font-bold text-foreground/80">BASE — {evt.base.label}</span>
                          </div>
                          <p className="text-xs text-muted-foreground leading-relaxed">{evt.base.desc}</p>
                        </div>

                        {/* Bear */}
                        <div className="rounded-lg border border-red-900 bg-red-950/30 p-2.5">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <TrendingDown className="w-3 h-3 text-red-400 flex-shrink-0" />
                            <span className="text-xs font-bold text-red-300">BEAR — {evt.bear.label}</span>
                          </div>
                          <p className="text-xs text-red-200/80 leading-relaxed">{evt.bear.desc}</p>
                        </div>
                      </div>
                    </div>

                    {/* Note + Source */}
                    <div className="flex items-start justify-between gap-2 pt-1">
                      <p className="text-xs text-muted-foreground italic leading-relaxed flex-1">{evt.note}</p>
                      <a
                        href={evt.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-shrink-0 flex items-center gap-1 text-xs text-primary hover:underline"
                        onClick={e => e.stopPropagation()}
                        data-testid={`catalyst-source-${evt.id}`}
                      >
                        <ExternalLink className="w-3 h-3" />
                        {evt.sourceName}
                      </a>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Legend */}
      {!isLoading && (
        <div className="flex items-center gap-3 mt-2 pl-1">
          {[["bg-red-500","High impact"],["bg-yellow-500","Medium"],["bg-teal-500","Low"]].map(([cls, label]) => (
            <span key={label} className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className={`w-2 h-2 rounded-full ${cls} inline-block`} />{label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
