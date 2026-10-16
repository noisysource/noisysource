import { useMemo, useState } from "react";
import { validateSeed, type SeedValidation } from "@shared/lib/finhubSeed";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { db } from "../lib/firebase";
import { planSeedImport, type SeedWrite } from "../lib/seedImport/plan";
import { applySeedImport, previewSeedImport, type SeedPreviewRow } from "../lib/seedImport/apply";

const PROJECT_ID = db.app.options.projectId ?? "?";

const STATUS_LABEL = { create: "criar", update: "alterar", unchanged: "sem alterações" } as const;

/**
 * Dev Tools → Importar seed (HANDOFF-finhub-data.md §3): pick the file → validate → preview per
 * entity → import into the project this build points at. Re-importing the same file changes nothing.
 */
export default function SeedImportCard() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [validation, setValidation] = useState<SeedValidation | null>(null);
  const [writes, setWrites] = useState<SeedWrite[]>([]);
  const [preview, setPreview] = useState<SeedPreviewRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function onFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    setFileName(file.name);
    setParseError(null); setValidation(null); setWrites([]); setPreview(null); setResult(null); setProgress(null);
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch (e: any) {
      setParseError(`Não é JSON válido: ${e?.message ?? e}`);
      return;
    }
    const v = validateSeed(json);
    setValidation(v);
    if (v.seed && !v.errors.length) setWrites(planSeedImport(v.seed, v.importable));
  }

  async function runPreview() {
    setBusy(true); setResult(null);
    try {
      setPreview(await previewSeedImport(writes, (done, total) => setProgress(`A ler ${done}/${total}…`)));
      setProgress(null);
    } catch (e: any) {
      setResult({ ok: false, text: `Pré-visualização falhou: ${e?.message ?? e}` });
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!confirm(`Importar ${writes.length} registos para o projeto ${PROJECT_ID}?`)) return;
    setBusy(true); setResult(null);
    try {
      await applySeedImport(writes, (done, total, w) => setProgress(`${done}/${total} — ${w.entityId ?? "global"} · ${w.collection} · ${w.id}`));
      setResult({ ok: true, text: `Importados ${writes.length} registos para ${PROJECT_ID}. Pré-visualizar de novo deve mostrar tudo "sem alterações".` });
      setPreview(null);
    } catch (e: any) {
      setResult({ ok: false, text: `Importação parou em ${e?.message ?? e}. O que já foi escrito fica; corrigir e importar de novo é seguro.` });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // Counts per entity · collection, and the records that would change.
  const groups = useMemo(() => {
    const out = new Map<string, { create: number; update: number; unchanged: number; rows: SeedPreviewRow[] }>();
    for (const r of preview ?? []) {
      const k = `${r.entityId ?? "global"} · ${r.collection}`;
      const g = out.get(k) ?? { create: 0, update: 0, unchanged: 0, rows: [] };
      g[r.diff.status]++;
      if (r.diff.status !== "unchanged") g.rows.push(r);
      out.set(k, g);
    }
    return [...out.entries()];
  }, [preview]);

  const errors = parseError ? [{ path: "(ficheiro)", message: parseError }] : validation?.errors ?? [];

  return (
    <Card className="p-4 space-y-4">
      <div>
        <h2 className="text-lg font-semibold mb-1">Importar seed</h2>
        <p className="text-sm text-zinc-400">
          Ficheiro JSON com os dados do FinHub (formato em <span className="font-mono">seed/finhub-seed.example.json</span>).
          Valida, mostra o que muda e só escreve quando carregares em Importar. Contratos, rendimentos, contratos EC e
          seguros criam as mesmas entradas recorrentes que os formulários. Reimportar o mesmo ficheiro não altera nada.
          Saldos e anexos ficam como estão.
        </p>
        <p className="text-xs text-zinc-500 mt-1">Projeto: <span className="font-mono text-zinc-300">{PROJECT_ID}</span></p>
      </div>

      <input type="file" accept="application/json,.json" onChange={onFile} disabled={busy} />
      {fileName && <div className="text-xs text-zinc-500">{fileName}</div>}

      {errors.length > 0 && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm space-y-1">
          <div className="font-medium text-red-300">{errors.length} erro(s): nada é importado até estarem corrigidos.</div>
          <ul className="list-disc pl-5 text-red-200/90 space-y-0.5">
            {errors.map((e, i) => <li key={i}><span className="font-mono text-xs">{e.path}</span>: {e.message}</li>)}
          </ul>
        </div>
      )}

      {validation && !errors.length && (
        <div className="text-sm text-emerald-400">Válido: {writes.length} registos a importar.</div>
      )}

      {validation && validation.refused.length > 0 && !errors.length && (
        <div className="rounded-md border border-amber-900 bg-amber-950/30 p-3 text-sm space-y-1">
          <div className="font-medium text-amber-300">{validation.refused.length} registo(s) ficam de fora (TODO no ficheiro):</div>
          <ul className="list-disc pl-5 text-amber-200/90 space-y-0.5">
            {validation.refused.map(r => (
              <li key={r.path}><span className="font-mono text-xs">{r.id}</span> — {r.reasons.join("; ")}</li>
            ))}
          </ul>
        </div>
      )}

      {writes.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={runPreview} disabled={busy}>Pré-visualizar</Button>
          {preview && (
            <Button onClick={runImport} disabled={busy} variant="destructive">
              Importar para {PROJECT_ID}
            </Button>
          )}
        </div>
      )}

      {progress && <div className="text-xs text-zinc-400 font-mono">{progress}</div>}

      {preview && (
        <div className="space-y-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="py-1">Entidade · coleção</th>
                <th className="py-1 text-right">{STATUS_LABEL.create}</th>
                <th className="py-1 text-right">{STATUS_LABEL.update}</th>
                <th className="py-1 text-right">{STATUS_LABEL.unchanged}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([k, g]) => (
                <tr key={k} className="border-t border-zinc-800">
                  <td className="py-1 font-mono text-xs">{k}</td>
                  <td className="py-1 text-right tabular-nums">{g.create || ""}</td>
                  <td className="py-1 text-right tabular-nums">{g.update || ""}</td>
                  <td className="py-1 text-right tabular-nums text-zinc-500">{g.unchanged || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {groups.some(([, g]) => g.rows.length) && (
            <details className="text-xs">
              <summary className="cursor-pointer text-zinc-400">Ver o que muda</summary>
              <ul className="mt-2 space-y-0.5 font-mono">
                {groups.flatMap(([, g]) => g.rows).map(r => (
                  <li key={`${r.entityId}/${r.collection}/${r.id}`}>
                    {STATUS_LABEL[r.diff.status]} {r.entityId ?? "global"}/{r.collection}/{r.id}
                    {r.diff.status === "update" && <span className="text-zinc-500"> — {r.diff.changed.join(", ")}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {result && (
        <div className={`text-sm whitespace-pre-wrap ${result.ok ? "text-emerald-400" : "text-red-400"}`}>{result.text}</div>
      )}
    </Card>
  );
}
