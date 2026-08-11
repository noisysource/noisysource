import { useEffect, useState, useMemo } from 'react';
import { useUser } from '@shared/hooks';
import {
  createVaultConfig, unlockVault, encrypt, decrypt, generatePassword,
} from '../lib/crypto';
import {
  loadVaultConfig, saveVaultConfig, loadEntries,
  addVaultEntry, updateVaultEntry, deleteVaultEntry,
  type VaultEntryDoc, type SensitivePayload,
} from '../lib/vaultDb';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Plus, Eye, EyeOff, Copy, Pencil, Trash2,
  RefreshCw, Search, ShieldCheck,
} from 'lucide-react';

const CATEGORIES = ['Banco', 'Email', 'Dev', 'Social', 'Serviços', 'Geral'];

export default function VaultPage() {
  const user = useUser();
  const [ready, setReady]         = useState(false);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [entries,   setEntries]   = useState<VaultEntryDoc[]>([]);

  const [search,      setSearch]      = useState('');
  const [category,    setCategory]    = useState<string | null>(null);
  const [copiedId,    setCopiedId]    = useState<string | null>(null);
  const [revealedId,  setRevealedId]  = useState<string | null>(null);
  const [revealedPwd, setRevealedPwd] = useState('');

  const [modal,       setModal]       = useState<'add' | 'edit' | null>(null);
  const [editEntry,   setEditEntry]   = useState<VaultEntryDoc | null>(null);
  const [form,        setForm]        = useState(emptyForm());
  const [showFormPwd, setShowFormPwd] = useState(false);
  const [formBusy,    setFormBusy]    = useState(false);
  const [formErr,     setFormErr]     = useState<string | null>(null);

  // ── auto-unlock from Firebase Auth uid ───────────────────────────────────────

  useEffect(() => {
    if (!user?.uid) return;
    void initVault(user.uid);
  }, [user?.uid]);

  async function initVault(uid: string) {
    setReady(false);
    let cfg = await loadVaultConfig(uid);
    let key: CryptoKey;
    if (!cfg) {
      const result = await createVaultConfig(uid);
      await saveVaultConfig(uid, result.config);
      key = result.key;
    } else {
      key = (await unlockVault(uid, cfg))!;
    }
    setCryptoKey(key);
    setEntries(await loadEntries(uid));
    setReady(true);
  }

  // ── entry actions ─────────────────────────────────────────────────────────────

  async function handleReveal(entry: VaultEntryDoc) {
    if (!cryptoKey) return;
    if (revealedId === entry.id) { setRevealedId(null); setRevealedPwd(''); return; }
    const p = JSON.parse(await decrypt(cryptoKey, { ciphertext: entry.encryptedData, iv: entry.iv })) as SensitivePayload;
    setRevealedPwd(p.password); setRevealedId(entry.id);
  }

  async function handleCopy(entry: VaultEntryDoc) {
    if (!cryptoKey) return;
    const p = JSON.parse(await decrypt(cryptoKey, { ciphertext: entry.encryptedData, iv: entry.iv })) as SensitivePayload;
    await navigator.clipboard.writeText(p.password);
    setCopiedId(entry.id); setTimeout(() => setCopiedId(null), 2000);
  }

  function openAdd() {
    setModal('add'); setEditEntry(null); setForm(emptyForm());
    setShowFormPwd(false); setFormErr(null);
  }

  async function openEdit(entry: VaultEntryDoc) {
    if (!cryptoKey) return;
    const p = JSON.parse(await decrypt(cryptoKey, { ciphertext: entry.encryptedData, iv: entry.iv })) as SensitivePayload;
    setForm({ title: entry.title, category: entry.category, username: entry.username, url: entry.url ?? '', password: p.password, notes: p.notes });
    setEditEntry(entry); setModal('edit'); setShowFormPwd(false); setFormErr(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!cryptoKey || !user?.uid) return;
    setFormBusy(true); setFormErr(null);
    try {
      const sealed = await encrypt(cryptoKey, JSON.stringify({ password: form.password, notes: form.notes } as SensitivePayload));
      if (modal === 'add') {
        const entry = await addVaultEntry(user.uid, form.title.trim(), form.category, form.username.trim(), form.url.trim() || undefined, sealed);
        setEntries(prev => [...prev, entry].sort((a, b) => a.title.localeCompare(b.title)));
      } else if (modal === 'edit' && editEntry) {
        await updateVaultEntry(editEntry.id, form.title.trim(), form.category, form.username.trim(), form.url.trim() || undefined, sealed);
        setEntries(prev => prev.map(x => x.id === editEntry.id
          ? { ...x, title: form.title.trim(), category: form.category, username: form.username.trim(), url: form.url.trim() || undefined }
          : x));
      }
      setModal(null);
    } catch (err: any) { setFormErr(err?.message ?? 'Erro'); }
    finally { setFormBusy(false); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Eliminar esta entrada?')) return;
    await deleteVaultEntry(id);
    setEntries(prev => prev.filter(e => e.id !== id));
    if (revealedId === id) setRevealedId(null);
  }

  // ── filtered list ─────────────────────────────────────────────────────────────

  const filtered = useMemo(() => entries.filter(e =>
    (!category || e.category === category) &&
    (!search || e.title.toLowerCase().includes(search.toLowerCase()) || e.username.toLowerCase().includes(search.toLowerCase()))
  ), [entries, category, search]);

  // ── render ────────────────────────────────────────────────────────────────────

  if (!ready) {
    return <div className="text-zinc-500 text-sm pt-8 text-center">A carregar vault…</div>;
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-48">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Pesquisar título ou utilizador…" className="pl-8" />
        </div>
        <Button onClick={openAdd} variant="secondary" className="shrink-0">
          <Plus size={14} className="mr-1" /> Nova entrada
        </Button>
      </div>

      {/* Category filter */}
      <div className="flex gap-1.5 flex-wrap">
        <FilterPill label={`Todos (${entries.length})`} active={!category} onClick={() => setCategory(null)} />
        {CATEGORIES.map(c => {
          const n = entries.filter(e => e.category === c).length;
          return n > 0 ? <FilterPill key={c} label={`${c} (${n})`} active={category === c} onClick={() => setCategory(category === c ? null : c)} /> : null;
        })}
      </div>

      {/* Entry list */}
      {filtered.length === 0 ? (
        <div className="py-16 text-center text-zinc-600">
          {entries.length === 0
            ? <><p className="text-3xl mb-2">🔒</p><p className="text-sm">Vault vazio. Adiciona a primeira entrada.</p></>
            : <p className="text-sm">Sem resultados.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(entry => (
            <Card key={entry.id} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{entry.title}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 shrink-0">{entry.category}</span>
                  </div>
                  <div className="text-xs text-zinc-500 truncate mt-0.5">{entry.username}</div>
                  {entry.url && <div className="text-xs text-zinc-600 truncate">{entry.url}</div>}
                  {revealedId === entry.id && (
                    <div className="mt-2 px-2 py-1.5 rounded bg-zinc-800 font-mono text-xs text-emerald-300 select-all break-all">
                      {revealedPwd}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-0.5 shrink-0">
                  <IconBtn title={revealedId === entry.id ? 'Ocultar' : 'Mostrar'} onClick={() => handleReveal(entry)}>
                    {revealedId === entry.id ? <EyeOff size={14} /> : <Eye size={14} />}
                  </IconBtn>
                  <IconBtn title={copiedId === entry.id ? 'Copiado!' : 'Copiar password'} onClick={() => handleCopy(entry)}
                    className={copiedId === entry.id ? 'text-emerald-400' : ''}>
                    <Copy size={14} />
                  </IconBtn>
                  <IconBtn title="Editar" onClick={() => openEdit(entry)}><Pencil size={14} /></IconBtn>
                  <IconBtn title="Eliminar" onClick={() => handleDelete(entry.id)} className="hover:text-red-400"><Trash2 size={14} /></IconBtn>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add / Edit modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <Card className="w-full max-w-md p-5 space-y-4">
            <div className="font-semibold">{modal === 'add' ? 'Nova entrada' : 'Editar entrada'}</div>
            <form onSubmit={handleSave} className="space-y-3">
              <LabeledField label="Título">
                <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="BPI Online, Gmail…" required autoFocus />
              </LabeledField>

              <LabeledField label="Categoria">
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none">
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </LabeledField>

              <LabeledField label="Username / Email">
                <Input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  placeholder="user@example.com" />
              </LabeledField>

              <LabeledField label="Password">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input type={showFormPwd ? 'text' : 'password'}
                      value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                      className="pr-8 font-mono" placeholder="••••••••" required />
                    <button type="button" onClick={() => setShowFormPwd(s => !s)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white">
                      {showFormPwd ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                  <button type="button" title="Gerar password aleatória"
                    onClick={() => setForm(f => ({ ...f, password: generatePassword() }))}
                    className="px-2.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors shrink-0">
                    <RefreshCw size={14} />
                  </button>
                </div>
              </LabeledField>

              <LabeledField label="URL (opcional)">
                <Input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://…" />
              </LabeledField>

              <LabeledField label="Notas (opcional)">
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none resize-none"
                  rows={2} />
              </LabeledField>

              {formErr && <div className="text-sm text-red-400">{formErr}</div>}

              <div className="flex gap-2 pt-1">
                <Button type="submit" className="flex-1" disabled={formBusy}>
                  <ShieldCheck size={14} className="mr-1.5" />
                  {formBusy ? 'A cifrar…' : 'Guardar'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setModal(null)}>Cancelar</Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function emptyForm() {
  return { title: '', category: CATEGORIES[5], username: '', url: '', password: '', notes: '' };
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-zinc-400 mb-1">{label}</div>
      {children}
    </div>
  );
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
        active ? 'bg-zinc-700 border-zinc-500 text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-600'
      }`}>
      {label}
    </button>
  );
}

function IconBtn({ title, onClick, children, className = '' }: {
  title: string; onClick: () => void; children: React.ReactNode; className?: string;
}) {
  return (
    <button title={title} onClick={onClick}
      className={`p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-white transition-colors ${className}`}>
      {children}
    </button>
  );
}
