import { useEffect, useMemo, useState, type Key } from "react";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";
import { useEntity } from "../hooks/EntityContext";
import { CategoryForm } from "../components/forms/CategoryForm";

type CategoryDoc = {
  id: string;
  name?: string;
  code?: string;
  type?: string;
  parentId?: string;
  createdAt?: Date | string;
  [k: string]: any;
};

export default function CategoriesPage() {
  const { selectedEntity } = useEntity();

  const [rows, setRows] = useState<CategoryDoc[]>([]);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  async function load() {
    if (!selectedEntity.id) return;
    setBusy(true);
    setMsg(null);
    try {
      const list = await api.categories.list();
      setRows(
        (list || []).map((x: any) => ({
          id: x.id,
          name: x.name ?? x.code ?? x.id,
          code: x.code,
          type: x.type,
          parentId: x.parentId,
          createdAt: x.createdAt,
          ...x,
        }))
      );
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load categories");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [selectedEntity.id]);

  const types = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.type && s.add(r.type));
    return Array.from(s).sort();
  }, [rows]);

  const byId = useMemo(() => {
    const m = new Map<string, CategoryDoc>();
    rows.forEach((r) => m.set(r.id, r));
    return m;
  }, [rows]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesQ =
        !t ||
        (r.name || "").toLowerCase().includes(t) ||
        (r.code || "").toLowerCase().includes(t) ||
        (r.type || "").toLowerCase().includes(t);
      const matchesType = typeFilter === "all" || (r.type || "") === typeFilter;
      return matchesQ && matchesType;
    });
  }, [rows, q, typeFilter]);

  const editing = useMemo(
    () => (editingId ? rows.find(c => c.id === editingId) ?? null : null),
    [rows, editingId]
  );

  const allFilteredSelected =
    filtered.length > 0 &&
    filtered.every((r) => !!selected[r.id]) &&
    filtered.some(Boolean);


  const toggleAllFiltered = (on: boolean) => {
    const map: Record<string, boolean> = {};
    for (const r of filtered) map[r.id] = on;
    setSelected(map);
  };

  function startCreate() {
    setEditingId(null);
    setIsFormOpen(true);
  }

  function startEdit(id: string) {
    setEditingId(id);
    setIsFormOpen(true);
  }

  async function deleteOne(id: string) {
    if (!confirm("Delete this category? This cannot be undone.")) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.categories.delete(id);
      await load();
      setMsg("Deleted ✔");
    } catch (e: any) {
      setMsg(e?.message ?? "Delete failed");
    } finally {
      setBusy(false);
    }
  }


  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-6">
      <div className="space-y-4">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <h2 className="text-xl font-semibold">Categories</h2>
          <div className="flex gap-2 items-center flex-wrap">
            <Button onClick={startCreate} disabled={busy}>New Category</Button>
            <Input
              placeholder="Search..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 h-9"
            >
              <option value="all">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
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
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Parent</th>
                <th className="px-3 py-2">System Role</th>
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
                  <td className="px-3 py-2">{x.name || x.code || x.id}</td>
                  <td className="px-3 py-2">{x.code || "—"}</td>
                  <td className="px-3 py-2">{x.type || "—"}</td>
                  <td className="px-3 py-2">{x.parentId ? (byId.get(x.parentId)?.name || x.parentId) : "—"}</td>
                  <td className="px-3 py-2">{x.systemRole || "—"}</td>
                  <td className="px-3 py-2 space-x-2">
                    <Button variant="outline" size="sm" onClick={() => startEdit(x.id)} disabled={busy}>Edit</Button>
                    <Button variant="destructive" size="sm" onClick={() => deleteOne(x.id)} disabled={busy}>Delete</Button>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-zinc-500">
                    No categories found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      {isFormOpen && (
        <div className="xl:sticky xl:top-4 h-fit space-y-3">
          <CategoryForm
            initial={editing as any}
            onSaved={() => { setEditingId(null); setIsFormOpen(false); load(); }}
            onCancel={() => { setEditingId(null); setIsFormOpen(false); }}
          />
        </div>
      )}
    </div>
  );
}
