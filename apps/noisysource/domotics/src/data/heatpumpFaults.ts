/**
 * Fault codes for the Zantia Vancouver 13 (R32) heat pump.
 *
 * The unit reports faults as several Tuya bitmap datapoints, one bit per code.
 * Which bit means which code comes from the device's Tuya cloud thing model;
 * what each code means comes from the Zantia manual ("Vancouver 13DC-32",
 * §5.3.2-8): https://zantia.com/storage/products/vzau85qrqt.pdf
 *
 * The Tuya `code` names on these bitmaps (`smart_system`, `power_system`, ...)
 * are the module vendor's generic names and don't describe their content. See
 * `apps/noisysource/domotics-bridge/README.md` for the full datapoint table.
 */

/** null = bit unused by the model. */
type BitLabels = ReadonlyArray<string | null>;

const E01_E16: BitLabels = Array.from(
  { length: 16 },
  (_, i) => `E${String(i + 1).padStart(2, '0')}`,
);

/** Tuya status code -> labels in bit order (bit 0 first). */
export const FAULT_BITMAPS: Readonly<Record<string, BitLabels>> = {
  fault: E01_E16,
  smart_system: [
    'E17', 'E18', 'E19', 'E20', null, 'E22', 'E23', 'E24',
    'E21', 'E25', 'E26', 'E27', 'E28', 'E29', 'E58', null, 'E32',
  ],
  power_system: [
    null, null, null, 'E36', null, null, 'E59', 'E40',
    null, null, null, 'E44', 'E45',
  ],
  ithium_battery_system: [null, 'E50'],
  electronic_system: [
    'E20_1', 'E20_5', null, null, null, 'E20_288', 'E20_384', 'E20_32',
    'E20_16', 'E20_264', 'E20_260', null, null, null, null, 'E20_257',
  ],
  bcu_com_state: ['E20_290', null, 'E20_4', null, 'E20_261'],
};

const MEANINGS: Readonly<Record<string, string>> = {
  E01: 'Sensor temp. exterior',
  E02: 'Sensor permutador',
  E03: 'Sensor sucção',
  E04: 'Sensor entrada EVI',
  E05: 'Sensor saída EVI',
  E06: 'Sensor descarga',
  E07: 'Sensor AQS',
  E08: 'Sensor saída água',
  E09: 'Sensor entrada água',
  E10: 'Sensor refrigerante',
  E11: 'Erro sensor alta pressão',
  E12: 'Erro sensor baixa pressão',
  E13: 'Proteção alta pressão (refrigerante a mais, estrangulamento ou sensor de pressão)',
  E14: 'Proteção baixa pressão (refrigerante a menos, estrangulamento ou sensor)',
  E15: 'Erro de caudal (caudal de água baixo / fluxostato)',
  E16: 'Erro comunicação placa ↔ controlador',
  E17: 'Temp. descarga elevada',
  E20: 'Proteção módulo IPM',
  E22: 'Diferencial temp. água muito elevado (verificar bomba e filtro)',
  E23: 'Anti-gelo AQS 2x em 60 min',
  E24: 'Anti-gelo aquecimento 2x em 90 min',
  E26: 'Sensor T6',
  E27: 'Temp. ambiente > 45 °C',
  E28: 'Temp. entrada água > 40 °C em arrefecimento',
  E29: 'Sensor temp. ambiente',
  E32: 'Temp. saída água > 75 °C (verificar bomba e filtro)',
  E36: 'Comunicação placa ventilador DC',
  E40: 'Temp. saída água < 5 °C em arrefecimento',
  E44: 'Motor DC 1',
  E45: 'Motor DC 2',
  E50: 'Alta temp. permutador',
  E58: 'Temp. ambiente abaixo do limite P82',
  E99: 'Comunicação módulo inverter',
};

const UNKNOWN = 'Ver manual';

/** Short Portuguese meaning for a fault code. Never empty. */
export function faultMeaning(code: string): string {
  if (MEANINGS[code]) return MEANINGS[code];
  if (code.startsWith('E20_')) return `${MEANINGS.E20} (${code}) — ver manual`;
  return UNKNOWN;
}

/**
 * Bitmap values should arrive as non-negative integers, but this is device
 * data relayed through a cloud and a Firestore doc, so anything else (a
 * numeric string, garbage) is tolerated rather than trusted.
 */
function asBitmap(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Every active fault code across all fault bitmaps, in table order. A set bit
 * the model doesn't name is still reported (as `<code>#<bit>`) rather than
 * swallowed: an unexplained alarm is better than a silent one.
 */
export function decodeFaults(get: (code: string) => unknown): string[] {
  const out: string[] = [];
  for (const [code, labels] of Object.entries(FAULT_BITMAPS)) {
    let n = asBitmap(get(code));
    // Division rather than bitwise ops, so values above 2^31 don't go negative.
    for (let bit = 0; n > 0; bit++, n = Math.floor(n / 2)) {
      if (n % 2 === 1) out.push(labels[bit] ?? `${code}#${bit}`);
    }
  }
  return out;
}

/**
 * What each fault means for this house: likely causes, how the unit behaves
 * with it, what to do. For the Reports page and the technicians' printout.
 * Causes are the manual's (§5.3.2-8); behaviour is what was seen here.
 * Codes without an entry fall back to their meaning and "see the manual".
 */
export interface FaultGuide {
  name: string;
  /** Where it shows up in the pump's data. */
  where?: string;
  causes: string[];
  behaviour?: string;
  todo: string[];
}

const GUIDE: Readonly<Record<string, FaultGuide>> = {
  E13: {
    name: 'Proteção de alta pressão',
    where: 'registo de falhas (dp 15) = 4096, bit 12',
    causes: [
      'Carga de refrigerante: possível excesso de R32.',
      'Restrição no circuito de refrigerante: filtro desidratador, válvula de expansão eletrónica.',
      'Pressostato ou sensor de alta pressão: funcionamento e ponto de disparo.',
      'Caudal de água: filtro, purga de ar, circulador, e se há bypass ou caudal mínimo quando as zonas fecham.',
    ],
    behaviour:
      'Um disparo isolado limpa sozinho em cerca de 1,5 min e a máquina volta a arrancar. ' +
      'Dois disparos em cerca de 15 min bloqueiam-na: só o painel, o disjuntor ou a assistência a rearmam ' +
      '(o módulo Wi-Fi/Tuya não tem rearme).',
    todo: [
      'Verificação no local pela assistência: carga de refrigerante, restrições, pressostato/sensor de alta pressão e caudal de água.',
    ],
  },
  E14: {
    name: 'Proteção de baixa pressão',
    causes: ['Refrigerante a menos (fuga).', 'Restrição no circuito de refrigerante.', 'Sensor ou pressostato de baixa pressão.'],
    todo: ['Chamar a assistência: não se resolve na casa.'],
  },
  E15: {
    name: 'Erro de caudal',
    causes: ['Caudal de água baixo: filtro sujo, ar no circuito, circulador, zonas todas fechadas.', 'Fluxostato com defeito.'],
    todo: ['Verificar o filtro de água e purgar o ar.', 'Se repetir, chamar a assistência.'],
  },
  E22: {
    name: 'Diferencial de temperatura da água muito elevado',
    causes: ['Pouca água a circular: circulador ou filtro.'],
    todo: ['Verificar a bomba circuladora e o filtro.'],
  },
  E32: {
    name: 'Temperatura de saída de água acima de 75 °C',
    causes: ['Pouca água a circular: circulador ou filtro.'],
    todo: ['Verificar a bomba circuladora e o filtro.'],
  },
};

/** Never empty: codes without an entry get their meaning and a pointer to the manual. */
export function faultGuide(code: string): FaultGuide {
  return GUIDE[code] ?? {
    name: faultMeaning(code),
    causes: [],
    todo: ['Ver o manual (Vancouver 13DC-32, §5.3.2-8) e, se repetir, chamar a assistência.'],
  };
}
