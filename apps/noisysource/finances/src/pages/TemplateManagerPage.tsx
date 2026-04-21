import { useEffect, useMemo, useState } from "react";
import type { Key } from "react";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";

type TemplateDoc = {
  id: string;
  name?: string;
  title?: string;
  type?: string;
  code?: string;
  createdAt?: Date | string;
  [k: string]: any;
};

export default function TemplatesPage() {
  const [rows, setRows] = useState<TemplateDoc[]>([]);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  async function load() {
    setBusy(true);
    setMsg(null);
    try {
      const list = await api.templates.list(); // assumes modular api.templates
      setRows(
        (list || []).map((x: any) => ({
          id: x.id,
          name: x.name ?? x.title ?? x.code ?? x.id,
          title: x.title,
          type: x.type,
          code: x.code,
          createdAt: x.createdAt,
          ...x,
        }))
      );
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load templates");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const types = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.type && s.add(r.type));
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesQ =
        !t ||
        (r.name || "").toLowerCase().includes(t) ||
        (r.title || "").toLowerCase().includes(t) ||
        (r.code || "").toLowerCase().includes(t) ||
        (r.type || "").toLowerCase().includes(t);
      const matchesType = typeFilter === "all" || (r.type || "") === typeFilter;
      return matchesQ && matchesType;
    });
  }, [rows, q, typeFilter]);

  const allFilteredSelected =
    filtered.length > 0 &&
    filtered.every((r) => !!selected[r.id]) &&
    filtered.some(Boolean);

  const anySelected = Object.values(selected).some(Boolean);
  const selectedIds = Object.entries(selected)
    .filter(([, v]) => !!v)
    .map(([k]) => k);

  const toggleAllFiltered = (on: boolean) => {
    const map: Record<string, boolean> = {};
    for (const r of filtered) map[r.id] = on;
    setSelected(map);
  };

  async function deleteOne(id: string) {
    if (!confirm("Delete this template? This cannot be undone.")) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.templates.delete(id);
      await load();
      setMsg("Deleted ✔");
    } catch (e: any) {
      setMsg(e?.message ?? "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selectedIds.length) return;
    if (
      !confirm(`Delete ${selectedIds.length} selected template(s)? This cannot be undone.`)
    )
      return;
    setBusy(true);
    setMsg(null);
    try {
      await Promise.all(selectedIds.map((id) => api.templates.delete(id)));
      await load();
      setSelected({});
      setMsg("Deleted selected ✔");
    } catch (e: any) {
      setMsg(e?.message ?? "Bulk delete failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAllFiltered() {
    if (!filtered.length) return;
    if (
      !confirm(`Delete ALL ${filtered.length} filtered template(s)? This cannot be undone.`)
    )
      return;
    setBusy(true);
    setMsg(null);
    try {
      await Promise.all(filtered.map((r) => api.templates.delete(r.id)));
      await load();
      setSelected({});
      setMsg("Deleted all filtered ✔");
    } catch (e: any) {
      setMsg(e?.message ?? "Bulk delete failed");
    } finally {
      setBusy(false);
    }
  }

  const fmtDate = (d?: Date | string) => {
    if (!d) return "—";
    const dd = typeof d === "string" ? new Date(d) : d;
    return isNaN(dd.getTime()) ? "—" : dd.toLocaleString();
    // (Firestore Timestamp should already be normalized in your domain mapper)
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <h2 className="text-xl font-semibold">Templates</h2>
        <div className="flex gap-2 items-center">
          <Input
            placeholder="Search name / code / type…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
          >
            <option value="all">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <Button
            variant="secondary"
            onClick={() => toggleAllFiltered(true)}
            disabled={busy || !filtered.length}
          >
            Select all (filtered)
          </Button>
          <Button
            variant="destructive"
            onClick={deleteSelected}
            disabled={busy || !anySelected}
          >
            Delete selected
          </Button>
          <Button
            variant="destructive"
            onClick={deleteAllFiltered}
            disabled={busy || !filtered.length}
          >
            Delete ALL filtered
          </Button>
        </div>
      </div>

      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm text-left">
          <thead>
            <tr className="border-b border-zinc-700 text-zinc-300">
              <th className="px-2 py-2 w-8">
                <input
                  type="checkbox"
                  onChange={(e) => toggleAllFiltered(e.target.checked)}
                  checked={allFilteredSelected}
                />
              </th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((x) => (
              <tr key={x.id as Key} className="border-b border-zinc-800">
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    checked={!!selected[x.id]}
                    onChange={(e) =>
                      setSelected((s) => ({ ...s, [x.id]: e.target.checked }))
                    }
                  />
                </td>
                <td className="px-3 py-2">{x.name || x.title || x.code || x.id}</td>
                <td className="px-3 py-2">{x.type || "—"}</td>
                <td className="px-3 py-2">{x.code || "—"}</td>
                <td className="px-3 py-2">{fmtDate(x.createdAt)}</td>
                <td className="px-3 py-2">
                  <button
                    className="text-red-400 underline disabled:opacity-50"
                    onClick={() => deleteOne(x.id)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-zinc-500">
                  No templates found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}