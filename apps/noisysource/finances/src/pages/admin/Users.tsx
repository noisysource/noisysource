import { useEffect, useState } from 'react';
import { collection, getDocs, setDoc, updateDoc, doc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { AppUser } from '@shared/models/AppUser';
import { Role, ROLE_LABELS } from '@shared/models/Roles';
import { db, functions } from '../../lib/firebase';
import { Card, CardContent } from '../../components/ui/card';
import { Switch } from '../../components/ui/switch';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

const ALL_ROLES = Object.values(Role);

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);

  const [addEmail, setAddEmail] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function reload() {
    setLoading(true);
    const snapshot = await getDocs(collection(db, 'users'));
    setUsers(snapshot.docs.map(d => ({ uid: d.id, ...d.data() } as AppUser)));
    setLoading(false);
  }

  useEffect(() => { reload(); }, []);

  const toggleRole = async (uid: string, role: Role) => {
    const user = users.find(u => u.uid === uid);
    if (!user) return;
    const updatedRoles = { ...user.roles, [role]: !user.roles?.[role] };
    await updateDoc(doc(db, 'users', uid), { roles: updatedRoles });
    setUsers(prev => prev.map(u => u.uid === uid ? { ...u, roles: updatedRoles } : u));
  };

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    const email = addEmail.trim().toLowerCase();
    if (!email) return;
    setAddBusy(true);
    setAddMsg(null);
    try {
      const fn = httpsCallable<{ email: string }, { uid: string; email: string; name: string }>(
        functions, 'lookupUserByEmail'
      );
      const { data } = await fn({ email });

      await setDoc(doc(db, 'users', data.uid), {
        email: data.email,
        name: data.name || email,
        roles: {},
      }, { merge: true });

      setAddEmail('');
      setAddMsg({ text: `${data.email} added — assign roles below.`, ok: true });
      await reload();
    } catch (err: any) {
      const msg = err?.message ?? 'Failed';
      setAddMsg({
        text: msg.includes('not-found')
          ? `No account found for ${email}. They must sign in to the app first.`
          : msg,
        ok: false,
      });
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <section className="space-y-6 max-w-3xl">
      <h2 className="text-xl font-semibold">Access Control</h2>

      {/* Add user */}
      <Card>
        <CardContent className="p-4">
          <p className="text-sm text-zinc-400 mb-3">
            Add a user by email. They must have signed in to the app at least once first.
          </p>
          <form onSubmit={addUser} className="flex gap-2">
            <Input
              type="email"
              placeholder="user@example.com"
              value={addEmail}
              onChange={e => setAddEmail(e.target.value)}
              disabled={addBusy}
              className="flex-1"
            />
            <Button type="submit" disabled={addBusy || !addEmail.trim()}>
              {addBusy ? 'Looking up…' : 'Add user'}
            </Button>
          </form>
          {addMsg && (
            <p className={`text-sm mt-2 ${addMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {addMsg.text}
            </p>
          )}
        </CardContent>
      </Card>

      {/* User list */}
      {loading ? (
        <p className="text-zinc-500 text-sm">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-zinc-500 text-sm">No users yet — add one above.</p>
      ) : (
        users.map(user => (
          <UserCard key={user.uid} user={user} onToggle={toggleRole} />
        ))
      )}
    </section>
  );
}

function UserCard({ user, onToggle }: {
  user: AppUser;
  onToggle: (uid: string, role: Role) => void;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div>
          <p className="font-medium text-zinc-100">{user.name || '—'}</p>
          <p className="text-sm text-zinc-500">{user.email}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ALL_ROLES.map(role => {
            const active = !!user.roles?.[role];
            return (
              <label
                key={role}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium cursor-pointer select-none transition-colors ${
                  active
                    ? 'bg-emerald-950 border-emerald-600 text-emerald-300'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-500'
                }`}
              >
                {ROLE_LABELS[role]}
                <Switch
                  checked={active}
                  onCheckedChange={() => onToggle(user.uid, role)}
                />
              </label>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
