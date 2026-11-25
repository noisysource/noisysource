// Which of the book's entities Atlas means, by name (pure: no Firebase).

/**
 * A name as a key: letters and digits only, without the company form, so Atlas's
 * "Noisy Source" finds "NOISYSOURCE - LDA" or "NoisySource, Lda".
 */
export const entityKey = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(lda|limitada|unipessoal|s\.?a|sociedade)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');

/** The entity Atlas meant: the same name (ignoring case, spacing and "Lda"), else one containing the other. */
export const entityForHint = <E extends { id: string; name: string; archived?: boolean }>(hint: string, entities: E[]): E | undefined => {
  const h = entityKey(hint);
  if (!h) return undefined;
  const live = entities.filter((e) => !e.archived);
  return (
    live.find((e) => entityKey(e.name) === h) ??
    live.find((e) => {
      const k = entityKey(e.name);
      return k.length > 0 && (k.includes(h) || h.includes(k));
    })
  );
};
