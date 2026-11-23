import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase';

interface AuthContextValue {
  user: User | null;
  authReady: boolean;
  signingIn: boolean;
  connectingWorkspace: boolean;
  authError: string | null;
  workspaceToken: string | null;
  hasWorkspaceAccess: boolean;
  signInWithGoogle: () => Promise<void>;
  connectGoogleWorkspace: () => Promise<string | null>;
  clearWorkspaceToken: () => void;
  signOut: () => Promise<void>;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [connectingWorkspace, setConnectingWorkspace] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // Access token is kept strictly in-memory (never persisted to localStorage, sessionStorage, or Firestore)
  const [workspaceToken, setWorkspaceToken] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      if (!nextUser) {
        setWorkspaceToken(null);
      }
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  const signInWithGoogle = async () => {
    setSigningIn(true);
    setAuthError(null);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      setWorkspaceToken(credential?.accessToken ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to sign in with Google.';
      setAuthError(msg);
    } finally {
      setSigningIn(false);
    }
  };

  const connectGoogleWorkspace = useCallback(async (): Promise<string | null> => {
    setConnectingWorkspace(true);
    setAuthError(null);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      const token = credential?.accessToken ?? null;
      setWorkspaceToken(token);
      return token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to connect Google Workspace permissions.';
      setAuthError(msg);
      return null;
    } finally {
      setConnectingWorkspace(false);
    }
  }, []);

  const clearWorkspaceToken = useCallback(() => {
    setWorkspaceToken(null);
  }, []);

  const signOut = async () => {
    setWorkspaceToken(null);
    await fbSignOut(auth);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        authReady,
        signingIn,
        connectingWorkspace,
        authError,
        workspaceToken,
        hasWorkspaceAccess: Boolean(workspaceToken),
        signInWithGoogle,
        connectGoogleWorkspace,
        clearWorkspaceToken,
        signOut,
        clearAuthError: () => setAuthError(null),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
