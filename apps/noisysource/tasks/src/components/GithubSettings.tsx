import { useEffect, useState } from 'react';
import { Github, X } from 'lucide-react';
import { errText, githubInfo, setGithubToken } from '../lib/github';

/**
 * The GitHub token the board uses to read PRs and merge them. Sent once to
 * the server and never shown again: the app only learns whose it is.
 */
export function GithubSettings({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ configured: boolean; login: string | null } | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { githubInfo().then(setInfo, (e) => setMsg(errText(e))); }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await setGithubToken(token);
      setInfo({ configured: true, login: r.login });
      setToken('');
      setMsg(`Saved. The board acts on GitHub as ${r.login}.`);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <Github size={18} /> <h2 className="flex-1 font-medium">GitHub</h2>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-800" aria-label="Close"><X size={16} /></button>
        </div>
        <p className="text-sm text-zinc-400">
          {info === null ? 'Checking…' : info.configured ? `Connected as ${info.login}.` : 'Not connected: cards can\'t show PRs or merge yet.'}
        </p>
        <p className="mt-3 text-xs leading-relaxed text-zinc-500">
          Create a fine-grained token at github.com → Settings → Developer settings, for the <b>noisysource</b> account,
          its repositories only, with: Pull requests (read and write), Contents (read and write, needed to merge),
          Checks (read). Pick an expiry; paste a new one here when it runs out.
        </p>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…"
          autoComplete="off" className="mt-3 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-600" />
        <button onClick={() => void save()} disabled={busy || !token}
          className="mt-3 w-full rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50">
          {busy ? 'Checking with GitHub…' : info?.configured ? 'Replace token' : 'Save token'}
        </button>
        {msg && <p className="mt-3 text-xs text-zinc-300">{msg}</p>}
      </div>
    </div>
  );
}
