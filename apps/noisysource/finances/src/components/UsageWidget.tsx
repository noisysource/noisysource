import { useEffect, useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase"; // ensure this is getFunctions(app, "europe-west1")
import type { UsageSnapshot } from "../types/usage";

function Bar({ used, free, label }: { used: number; free: number; label: string }) {
  const denom = Math.max(1, Number.isFinite(free) ? free : 0);
  const pct = useMemo(() => Math.min(100, Math.round((used / denom) * 100)), [used, denom]);
  const ok = used <= free;
  return (
    <div className="w-full" aria-label={label} role="group">
      <div className="flex justify-between text-xs mb-1 text-gray-400">
        <span>{used.toLocaleString()}</span>
        <span>{(free ?? 0).toLocaleString()} free</span>
      </div>
      <div
        className="w-full h-2 rounded-md overflow-hidden bg-neutral-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={free ?? 0}
        aria-valuenow={used}
      >
        <div className={`h-2 ${ok ? "bg-emerald-500" : "bg-red-500"}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10px] mt-1 text-gray-500">{pct}% of free tier</div>
    </div>
  );
}

type Props = { className?: string };

export default function UsageWidget({ className = "" }: Props) {
  const [data, setData] = useState<UsageSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // Type the callable's return payload
        const call = httpsCallable<unknown, UsageSnapshot>(functions, "getUsageSnapshot");
        const res = await call();
        if (!mounted) return;
        setData(res.data ?? null);
      } catch (e: any) {
        if (!mounted) return;
        setErr(e?.message ?? "Failed to load usage");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) return <div className="text-sm text-gray-400">Loading usage…</div>;
  if (err) return <div className="text-sm text-red-400">Usage error: {err}</div>;
  if (!data) return null;

  const start = new Date(data.window.start);
  const end = new Date(data.window.end);

  return (
    <div className={["p-4 rounded-2xl border border-neutral-800 space-y-4", "text-neutral-200", className].join(" ")}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-neutral-100">Firebase Usage — {data.month}</h3>
        <span className="text-xs text-neutral-400">
          {isNaN(start.getTime()) ? "—" : start.toLocaleDateString()} –{" "}
          {isNaN(end.getTime()) ? "—" : end.toLocaleDateString()}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <div className="text-xs font-medium mb-1 text-neutral-200">
            Firestore Reads {data.status?.firestoreReadsOk ? "✅" : "⚠️"}
          </div>
          <Bar label="Firestore Reads" used={data.firestore?.reads ?? 0} free={data.firestore?.free?.reads ?? 0} />
        </div>

        <div>
          <div className="text-xs font-medium mb-1 text-neutral-200">
            Firestore Writes {data.status?.firestoreWritesOk ? "✅" : "⚠️"}
          </div>
          <Bar label="Firestore Writes" used={data.firestore?.writes ?? 0} free={data.firestore?.free?.writes ?? 0} />
        </div>

        <div>
          <div className="text-xs font-medium mb-1 text-neutral-200">
            Functions Invocations {data.status?.functionsInvocationsOk ? "✅" : "⚠️"}
          </div>
          <Bar label="Functions Invocations" used={data.functions?.invocations ?? 0} free={data.functions?.free ?? 0} />
        </div>

        <div>
          <div className="text-xs font-medium mb-1 text-neutral-200">
            Auth New Users {data.status?.authOk ? "✅" : "⚠️"}
          </div>
          <Bar label="Auth New Users" used={data.auth?.newUsers ?? 0} free={data.auth?.free?.users ?? 0} />
        </div>

        <div>
          <div className="text-xs font-medium mb-1 text-neutral-200">
            Storage (GB) {data.status?.storageOk ? "✅" : "⚠️"}
          </div>
          <Bar label="Storage (GB)" used={data.storage?.gb ?? 0} free={data.storage?.free?.gb ?? 0} />
        </div>

        <div>
          <div className="text-xs font-medium mb-1 text-neutral-200">
            Hosting Storage (GB) {data.status?.hostingOk ? "✅" : "⚠️"}
          </div>
          <Bar label="Hosting Storage (GB)" used={data.hosting?.gb ?? 0} free={data.hosting?.free?.gb ?? 0} />
        </div>
      </div>
      <div className="text-xs text-neutral-400 pt-2 border-t border-neutral-800">
          Firestore Deletes: {data.firestore?.deletes?.toLocaleString() ?? 0} (informational)
      </div>
    </div>
  );
}