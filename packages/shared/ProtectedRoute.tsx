// shared/components/auth/ProtectRoute.tsx
import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useUser } from './hooks';
import type { AppUser } from '@shared/dist/models';

type Role = keyof NonNullable<AppUser['roles']>;

interface ProtectRouteProps {
  children: ReactNode;
  requiredRole?: Role;
}

export function ProtectRoute({ children, requiredRole }: ProtectRouteProps) {
  const user = useUser();

  if (user === undefined) {
    return (
      <div className="flex items-center justify-center h-screen text-white">
        <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-white" />
      </div>
    );
  }

  // 🚫 Not authenticated
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // 🔐 Authenticated, but missing required role
  if (requiredRole && !user.roles?.[requiredRole]) {
    return <Navigate to="/not-authorized" replace />;
  }

  return <>{children}</>;
}