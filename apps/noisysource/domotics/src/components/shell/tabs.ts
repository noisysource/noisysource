import { Box, Car, Home, LayoutGrid, Menu, Thermometer, Zap, type LucideIcon } from 'lucide-react';

/**
 * The app's sections. One list drives both navigations: the phone's bottom
 * bar shows the five used every day, the browser's top bar shows them all.
 * Clima and Mais stay reachable on a phone from the home screen (the heating
 * card, and the menu button in its header).
 */
export type Tab = 'casa' | 'divisoes' | 'clima' | 'energia' | 'carros' | 'planta' | 'mais';

export interface TabDef {
  id: Tab;
  label: string;
  /** Shorter label for the phone bar, where five have to fit. */
  short?: string;
  icon: LucideIcon;
  phone: boolean;
}

export const TABS: TabDef[] = [
  { id: 'casa', label: 'Casa', icon: Home, phone: true },
  { id: 'divisoes', label: 'Divisões', icon: LayoutGrid, phone: true },
  { id: 'clima', label: 'Clima', icon: Thermometer, phone: false },
  { id: 'energia', label: 'Energia', icon: Zap, phone: true },
  { id: 'carros', label: 'Carros', short: 'Carro', icon: Car, phone: true },
  { id: 'planta', label: 'Planta 3D', short: '3D', icon: Box, phone: true },
  { id: 'mais', label: 'Mais', icon: Menu, phone: false },
];

const IDS = new Set<string>(TABS.map(t => t.id));

/** The section in the address (`#/energia`), so a tab survives a reload and can be bookmarked. */
export function tabFromHash(hash: string): Tab | null {
  const id = hash.replace(/^#\/?/, '');
  return IDS.has(id) ? (id as Tab) : null;
}
