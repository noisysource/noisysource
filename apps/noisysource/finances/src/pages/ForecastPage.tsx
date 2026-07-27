import { useEffect, useMemo, useState } from "react";
import type { ForecastEventDoc, ForecastEventStatus } from "@shared/models/RecurringEntry";
import { formatEUR } from "@shared/lib/money";
import { generateForecastEvents, summariseByMonth, toYM } from "@shared/lib/forecast";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { api } from "../lib/api";
import { useEntity } from "../hooks/EntityContext";

const STATUS_LABELS: Record<ForecastEventStatus, string> = {
  forecast: "Forecast",
  confirmed: "Confirmed",
  skipped: "Skipped",
};

const STATUS_STYLE: Record<ForecastEventStatus, string> = {
  forecast: "bg-zinc-800 text-zinc-300",
  confirmed: "bg-emerald-900 text-emerald-300",
  skipped: "bg-zinc-900 text-zinc-600 line-through",
};

function currentYM(): string {
  const d = new Date();
  return toYM(d.getFullYear(), d.getMonth() + 1);
}

export default function ForecastPage() {
  const { selectedEntity } = useEntity();

  const [startYM, setStartYM] = useState<string>(currentYM);
  const [events, setEvents] = useState<ForecastEventDoc[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string>(currentYM);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const endYM = useMemo(() => {
    const [y, m] = startYM.split("-").map(Number);
    const d = new Date(y, m - 1 + 11, 1);
    return toYM(d.getFullYear(), d.getMonth() + 1);
  }, [startYM]);

  async function loadEvents() {
    setBusy(true);
    setMsg(null);
    try {
      const evts = await api.forecastEvents.listInRange(startYM, endYM);
      setEvents(evts);
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load events");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void loadEvents(); }, [selectedEntity.id, startYM]);

  async function generate() {
    setGenerating(true);
    setMsg(null);
    try {
      const recurring = await api.recurring.listActive();
      const existingIds = new Set(events.map(e => e.id));
      const toCreate = generateForecastEvents(recurring, startYM, 12, existingIds);

      if (!toCreate.length) {
        setMsg("All events already generated — nothing new to add.");
        return;
      }

      await Promise.all(toCreate.map(e => api.forecastEvents.upsertEvent(e)));
      await loadEvents();
      setMsg(`Generated ${toCreate.length} event(s) ✔`);
    } catch (e: any) {
      setMsg(e?.message ?? "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function updateStatus(id: string, status: ForecastEventStatus) {
    try {
      await api.forecastEvents.updateStatus(id, status);
      setEvents(prev => prev.map(e => e.id === id ? { ...e, status } : e));
    } catch (e: any) {
      setMsg(e?.message ?? "Update failed");
    }
  }

  async function deleteEvent(id: string) {
    if (!confirm("Delete this event?")) return;
    try {
      await api.forecastEvents.delete(id);
      setEvents(prev => prev.filter(e => e.id !== id));
    } catch (e: any) {
      setMsg(e?.message ?? "Delete failed");
    }
  }

  const summary = useMemo(() => summariseByMonth(events), [events]);
  const monthEvents = useMemo(
    () => events.filter(e => e.yearMonth === selectedMonth).sort((a, b) => a.dayOfMonth - b.dayOfMonth),
    [events, selectedMonth]
  );

  const overallNet = useMemo(
    () => summary.reduce((s, m) => s + m.netCents, 0),
    [summary]
  );

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <div className="text-xs text-zinc-400 mb-1">Start month</div>
          <input
            type="month"
            value={startYM}
            onChange={e => setStartYM(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
          />
        </div>
        <Button onClick={generate} disabled={generating || busy} variant="secondary">
          {generating ? "Generating…" : "Generate from recurring"}
        </Button>
        <Button onClick={loadEvents} disabled={busy} variant="secondary">
          Refresh
        </Button>
        {overallNet !== 0 && (
          <div className="text-sm text-zinc-400">
            12-month net: <span className={overallNet >= 0 ? "text-emerald-400 font-medium" : "text-red-400 font-medium"}>
              {formatEUR(overallNet)}
            </span>
          </div>
        )}
      </div>

      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      {/* 12-month summary grid */}
      <Card className="overflow-x-auto">
        <div className="grid grid-cols-12 min-w-[900px]">
          {summary.length === 0 ? (
            <div className="col-span-12 px-4 py-6 text-zinc-500 text-sm">
              No events yet. Add recurring entries and click "Generate from recurring".
            </div>
          ) : (
            summary.map(s => {
              const isSelected = s.yearMonth === selectedMonth;
              return (
                <button
                  key={s.yearMonth}
                  onClick={() => setSelectedMonth(s.yearMonth)}
                  className={`flex flex-col items-center py-3 px-1 border-r border-zinc-800 last:border-r-0 transition-colors hover:bg-zinc-800 ${isSelected ? "bg-zinc-800 ring-1 ring-inset ring-zinc-600" : ""}`}
                >
                  <div className="text-xs text-zinc-400 mb-2">{s.yearMonth.slice(5)}/{s.yearMonth.slice(2, 4)}</div>
                  <div className="text-xs text-emerald-400">{formatEUR(s.incomeCents)}</div>
                  <div className="text-xs text-red-400">−{formatEUR(s.expenseCents)}</div>
                  <div className={`text-xs font-semibold mt-1 ${s.netCents >= 0 ? "text-white" : "text-red-400"}`}>
                    {s.netCents >= 0 ? "+" : ""}{formatEUR(s.netCents)}
                  </div>
                  <div className="text-xs text-zinc-600 mt-1">{s.eventCount} items</div>
                </button>
              );
            })
          )}
        </div>
      </Card>

      {/* Selected month events */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-medium">
            {selectedMonth} — {monthEvents.length} event(s)
          </h3>
        </div>

        {monthEvents.length === 0 ? (
          <div className="text-zinc-500 text-sm">No events for this month. Select a month above or generate events.</div>
        ) : (
          <div className="space-y-2">
            {monthEvents.map(e => (
              <div
                key={e.id}
                className="flex items-center gap-3 px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800"
              >
                {/* Day badge */}
                <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs text-zinc-400 shrink-0">
                  {e.dayOfMonth}
                </div>

                {/* Description + meta */}
                <div className="flex-1 min-w-0">
                  <div className={`font-medium text-sm ${e.status === "skipped" ? "line-through text-zinc-600" : ""}`}>
                    {e.description}
                  </div>
                  <div className="text-xs text-zinc-500 capitalize">{e.type}{e.recurringId ? " · recurring" : " · one-off"}</div>
                </div>

                {/* Amount */}
                <div className={`text-sm font-semibold shrink-0 ${
                  e.type === "income" ? "text-emerald-400"
                  : e.type === "expense" ? "text-red-400"
                  : "text-blue-400"
                }`}>
                  {e.type === "expense" ? "−" : "+"}{formatEUR(e.amountCents)}
                </div>

                {/* Status badge */}
                <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${STATUS_STYLE[e.status]}`}>
                  {STATUS_LABELS[e.status]}
                </span>

                {/* Actions */}
                <div className="flex gap-1 shrink-0">
                  {e.status !== "confirmed" && (
                    <button
                      onClick={() => updateStatus(e.id, "confirmed")}
                      className="text-xs px-2 py-1 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-300"
                    >
                      ✔
                    </button>
                  )}
                  {e.status !== "forecast" && (
                    <button
                      onClick={() => updateStatus(e.id, "forecast")}
                      className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                    >
                      Reset
                    </button>
                  )}
                  {e.status !== "skipped" && (
                    <button
                      onClick={() => updateStatus(e.id, "skipped")}
                      className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400"
                    >
                      Skip
                    </button>
                  )}
                  <button
                    onClick={() => deleteEvent(e.id)}
                    className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-red-900 text-zinc-400 hover:text-red-300"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
