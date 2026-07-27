import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { api } from "../../lib/api";
import type { CategoryDoc, CategoryType } from "@shared/models/Category";
import { CATEGORY_SYSTEM_ROLE_OPTIONS } from "@shared/models/Category";

type Props = {
  initial?: CategoryDoc | null;
  onSaved: (id: string) => void;
  onCancel: () => void;
};

export function CategoryForm({ initial, onSaved, onCancel }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState<CategoryType>("EXPENSE");
  const [systemRole, setSystemRole] = useState<string>("");
  const [parentId, setParentId] = useState("");

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      setName(initial.name || "");
      setType(initial.type || "EXPENSE");
      setSystemRole(initial.systemRole || "");
      setParentId(initial.parentId || "");
    } else {
      setName("");
      setType("EXPENSE");
      setSystemRole("");
      setParentId("");
    }
  }, [initial]);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const payload = {
        id: initial?.id,
        name,
        type,
        systemRole,
        parentId: parentId || undefined,
      };
      const id = await api.categories.save(payload as any);
      onSaved(id);
    } catch (e: any) {
      setMsg(e?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 p-4 border rounded-lg">
      <h3 className="font-semibold text-lg">{initial ? "Edit Category" : "New Category"}</h3>
      <div className="grid gap-2">
        <label>Name</label>
        <Input value={name} onChange={e => setName(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <label>Type</label>
        <select value={type} onChange={e => setType(e.target.value as CategoryType)} className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 h-9">
          <option value="EXPENSE">Expense</option>
          <option value="INCOME">Income</option>
          <option value="LIABILITY">Liability</option>
          <option value="EQUITY">Equity</option>
        </select>
      </div>
      <div className="grid gap-2">
        <label>System Role</label>
        <select value={systemRole} onChange={e => setSystemRole(e.target.value)} className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 h-9">
          {CATEGORY_SYSTEM_ROLE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
       <div className="grid gap-2">
        <label>Parent Category (Optional)</label>
        <Input value={parentId} onChange={e => setParentId(e.target.value)} placeholder="Enter parent category ID" />
      </div>

      {msg && <div className="text-sm text-red-500">{msg}</div>}

      <div className="flex gap-2">
        <Button onClick={save} disabled={busy}>Save</Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
