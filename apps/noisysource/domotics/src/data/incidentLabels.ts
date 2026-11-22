/**
 * Who switched the pump, in words. Apart from incidents.ts so pure code can use
 * them without pulling in Firestore.
 */

/** 'guard' = the E13 protection, out of the app since 2026-11-04 and removed from the bridge on 2026-11-22: past records keep it, so it keeps its labels. */
export type SwitchSource = 'app' | 'automation' | 'guard' | 'outside' | 'unknown';

export const SOURCE_LABEL: Record<SwitchSource, string> = {
  app: 'pela app / ponte',
  automation: 'pela automação',
  guard: 'pela proteção E13',
  outside: 'de fora (SmartLife, painel, técnicos ou temporizador)',
  unknown: 'origem desconhecida',
};

export type LogOrigin = SwitchSource | 'pump' | 'note';

export const LOG_ORIGIN: Record<LogOrigin, string> = {
  outside: 'De fora',
  unknown: 'Desconhecida',
  guard: 'Proteção E13',
  automation: 'Automação',
  app: 'App / ponte',
  pump: 'Bomba (avaria)',
  note: 'Nota',
};
