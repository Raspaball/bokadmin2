// supabase/functions/_shared/book-tags.ts
// Tagger (pakke B del 7). Push legger ikke lenger forfatter og tittel inn som
// tagger; bkg-* og alle andre tagger beholdes. Ren TypeScript (testes i scripts/).
//
// Den gamle push sendte «Etternavn, Fornavn, Tittel» som én tekst, og Shopify
// delte den på komma: Avkledd fikk taggene «Brochmann», «Nina» og hele tittelen.
// Ved oppdatering fjernes derfor:
//   - tagger lik en forfatter («Nina Brochmann» eller «Brochmann, Nina») eller
//     tittelen (hele eller hovedtittelen før kolon), og
//   - delene av et navn eller en tittel som ble delt på komma, men bare når alle
//     delene finnes som tagger (da er det sikkert den gamle push som laget dem).
// Sammenligningen er uten store/små bokstaver, ekstra mellomrom og diakritiske
// tegn («Sūnzi» = «Sunzi», «Mélissa» = «Melissa»).

import { mainTitle } from "./handle.js";
import { isProtectedTag } from "./protected.ts";

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

/** «Nina Brochmann» → «Brochmann, Nina» (siste ord som etternavn). */
function invertName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.trim();
  const last = parts.pop()!;
  return `${last}, ${parts.join(" ")}`;
}

export interface TagCleanResult {
  tags: string[];
  removed: string[];
}

/**
 * Nytt taggsett: dagens tagger uten forfatter/tittel, pluss `addTags` (bkg-*).
 * @param authors forfatterne som «Fornavn Etternavn»
 * @param authorTexts andre skrivemåter som kan ha blitt tagget (f.eks. books.author «Brochmann, Nina»)
 */
export function cleanBookTags(
  currentTags: readonly string[],
  book: { title: string; authors: readonly string[]; authorTexts?: readonly string[] },
  addTags: readonly string[] = [],
): TagCleanResult {
  const present = new Set(currentTags.map(norm));
  const whole = new Set<string>();
  const splitGroups: string[][] = [];

  const addPhrase = (phrase: string | null | undefined) => {
    const p = String(phrase ?? "").trim();
    if (!p) return;
    whole.add(norm(p));
    const parts = p.split(",").map(norm).filter(Boolean);
    if (parts.length > 1) splitGroups.push(parts);
  };
  for (const a of book.authors) { addPhrase(a); addPhrase(invertName(a)); }
  for (const t of book.authorTexts ?? []) addPhrase(t);
  addPhrase(book.title);
  addPhrase(mainTitle(book.title));

  const remove = new Set(whole);
  for (const group of splitGroups) {
    if (group.every((p) => present.has(p))) group.forEach((p) => remove.add(p));
  }

  const removed: string[] = [];
  const kept: string[] = [];
  for (const t of currentTags) {
    if (remove.has(norm(t)) && !t.startsWith("bkg-") && !isProtectedTag(t)) removed.push(t);
    else kept.push(t);
  }
  for (const t of addTags) if (!kept.some((k) => norm(k) === norm(t))) kept.push(t);
  return { tags: kept, removed };
}

// ── Rydd tagger (taggjobben tag_cleanup, oppdrag 09.10.2026) ────────────────────
// Regel: bare bkg-N, bkg-NN, bkg-NNN (1–3 sifre) og de beskyttede taggene (gave, lokal, lokalhistorie,
// lokallitteratur, uten forskjell på store og små bokstaver) beholdes. Alt annet fjernes: navn, titler,
// emnetagger (skjoenn-rom, sakpr, Faglitteratur, 9+) og formattagger. Ingen tagger legges til.

const BKG_TAG = /^bkg-\d{1,3}$/i;

/** true = taggen står igjen etter rydding. */
export function isKeptTag(tag: unknown): boolean {
  const t = String(tag ?? "").trim();
  return BKG_TAG.test(t) || isProtectedTag(t);
}

/** Taggene som fjernes (i den rekkefølgen de står). Tom liste = ingenting å gjøre. */
export function tagsToRemove(tags: readonly unknown[] | null | undefined): string[] {
  return (tags ?? []).map((t) => String(t ?? "")).filter((t) => t.trim() !== "" && !isKeptTag(t));
}
