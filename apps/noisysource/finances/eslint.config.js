import tsParser from '@typescript-eslint/parser';

// FinHub v2 (HANDOFF-finhub-v2.md, "Code layout"): src/v2/** must not import the old app's pages,
// its api layer or contractSync, nor another company's module. Allowed reuse from the old code:
// @shared/lib/{payroll, irs, vat, ecProjection, money} and src/lib/parsers/bpiPdf (plus the
// app's Firebase instance, src/lib/firebase). Everything else comes from @shared/finhub.
const OLD_APP = [
  { group: ['**/pages', '**/pages/**'], message: 'FinHub v2 não importa páginas da app antiga.' },
  { group: ['**/lib/api', '**/lib/api/**'], message: 'FinHub v2 lê e escreve eventos (src/v2/*/eventStore), não a api antiga.' },
  { group: ['**/lib/contractSync', '**/lib/contractSync.*'], message: 'contractSync copia dados derivados: é o que a v2 substitui.' },
  {
    group: ['@shared/lib/*', '!@shared/lib/payroll', '!@shared/lib/irs', '!@shared/lib/vat', '!@shared/lib/ecProjection', '!@shared/lib/money'],
    message: 'Da @shared/lib antiga, a v2 só usa payroll, irs, vat, ecProjection e money.',
  },
  { group: ['@shared/models', '@shared/models/*'], message: 'A v2 usa os tipos de @shared/finhub, não os modelos antigos.' },
];
const otherCompanies = (self) => ['noisysource', 'noisyphocus', 'casa']
  .filter(c => c !== self)
  .map(c => ({ group: [`**/${c}`, `**/${c}/**`], message: `O módulo ${self} não importa o módulo ${c}.` }));

const ts = {
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  },
};

export default [
  {
    rules: {
      // your rules here
    }
  },
  {
    files: ['src/v2/**/*.{ts,tsx}'],
    ...ts,
    rules: { 'no-restricted-imports': ['error', { patterns: OLD_APP }] },
  },
  ...['noisysource', 'noisyphocus', 'casa'].map(company => ({
    files: [`src/v2/${company}/**/*.{ts,tsx}`],
    ...ts,
    rules: { 'no-restricted-imports': ['error', { patterns: [...OLD_APP, ...otherCompanies(company)] }] },
  })),
];
