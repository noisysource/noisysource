// Small collection helpers

export function indexBy<T, K extends string | number | symbol>(
  arr: T[],
  key: (x: T) => K
): Record<K, T> {
  return arr.reduce((m, item) => {
    m[key(item)] = item;
    return m;
  }, {} as Record<K, T>);
}

export function groupBy<T, K extends string | number | symbol>(
  arr: T[],
  key: (x: T) => K
): Record<K, T[]> {
  return arr.reduce((m, item) => {
    const k = key(item);
    (m[k] ||= []).push(item);
    return m;
  }, {} as Record<K, T[]>);
}

export function sortBy<T>(arr: T[], selector: (x: T) => string | number) {
  return [...arr].sort((a, b) => {
    const A = selector(a);
    const B = selector(b);
    return A < B ? -1 : A > B ? 1 : 0;
  });
}

export function ensureArray<T>(x: T | T[] | null | undefined): T[] {
  return x == null ? [] : Array.isArray(x) ? x : [x];
}