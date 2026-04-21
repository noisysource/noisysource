import { createContext } from 'react';
import type { AppUser } from '@shared/models';

export const UserContext = createContext<AppUser | null | undefined>(undefined);