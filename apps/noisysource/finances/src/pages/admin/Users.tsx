// apps/finhub/src/pages/admin/Users.tsx
import { useEffect, useState } from 'react';
import { collection, getDocs, updateDoc, doc } from 'firebase/firestore';
import { AppUser } from '@shared/models/AppUser';
import { db } from '../../lib/firebase';
import { Card, CardContent } from '../../components/ui/card';
import { Switch } from '../../components/ui/switch';
import { Role } from '@shared/models/Roles';

const ROLES: Role[] = Object.values(Role);

export default function AdminUsersPage() {
    const [users, setUsers] = useState<AppUser[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchUsers = async () => {
            const snapshot = await getDocs(collection(db, 'users'));
            const data = snapshot.docs.map((doc) => ({
                uid: doc.id,
                ...doc.data(),
            })) as AppUser[];
            setUsers(data);
            setLoading(false);
        };
        fetchUsers();
    }, []);

    const toggleRole = async (uid: string, role: keyof AppUser['roles']) => {
        const user = users.find((u) => u.uid === uid);
        if (!user) return;

        const updatedRoles = {
            ...user.roles,
            [role]: !user.roles?.[role],
        };

        await updateDoc(doc(db, 'users', uid), { roles: updatedRoles });

        setUsers((prev) =>
            prev.map((u) =>
                u.uid === uid ? { ...u, roles: updatedRoles } : u
            )
        );
    };

    return (
        <section className="space-y-6">
            <h2 className="text-2xl font-bold flex items-center gap-2">👥 User Access Control</h2>

            {loading ? (
                <p className="text-muted-foreground">Loading users…</p>
            ) : users.length === 0 ? (
                <p className="text-muted-foreground">No users found.</p>
            ) : (
                users.map((user) => (
                    <UserCard key={user.uid} user={user} onToggle={toggleRole} />
                ))
            )}
        </section>
    );
}

function UserCard({
    user,
    onToggle,
}: {
    user: AppUser;
    onToggle: (uid: string, role: keyof AppUser['roles']) => void;
}) {
    return (
        <Card>
            <CardContent className="p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    {/* Left: User Info */}
                    <div className="space-y-1">
                        <p className="text-lg font-semibold">{user.name || 'Unnamed User'}</p>
                        <p className="text-sm text-muted-foreground">{user.email}</p>
                    </div>

                    {/* Right: Roles */}
                    <div className="flex flex-wrap gap-3">
                        {ROLES.map((role) => {
                            const isActive = !!user.roles?.[role];
                            return (
                                <div
                                    key={role}
                                    className={`flex items-center gap-2 rounded-full border px-3 py-1 ${isActive
                                            ? 'bg-green-100 border-green-400 text-green-900'
                                            : 'bg-muted border-muted text-muted-foreground'
                                        }`}
                                >
                                    <span className="text-sm font-medium capitalize">{role}</span>
                                    <Switch
                                        checked={isActive}
                                        onCheckedChange={() => onToggle(user.uid, role)}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}