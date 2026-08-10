/**
 * English pluralization for interface copy.
 *
 * Exists because `${n} choice(s)` had appeared in four places: machine shorthand leaking into
 * the human voice, in a UI that reads "3 edges" correctly twenty lines away. It is deliberately
 * only what this product needs — English, regular and explicit-irregular forms — rather than a
 * dependency. The app ships English-only today (`html lang="en"`, no i18n framework); if that
 * changes, the fix is a real message catalogue with plural categories, not more cases here.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** `plural` with the number in front, which is how these read at every call site. */
export function counted(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${plural(count, singular, pluralForm)}`;
}
