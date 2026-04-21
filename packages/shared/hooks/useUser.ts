import { useContext } from 'react';
import { AppUser } from '@shared/models';
import { UserContext } from './UserContext';

export function useUser(): AppUser | null | undefined {
  return useContext(UserContext);
}