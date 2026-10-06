// supabase/functions/_shared/collections.ts
// Samlingskall i Admin API 2026-07. `input: CollectionInput` er utfaset for
// collectionCreate/collectionUpdate; de gjeldende argumentene er
// `collection: CollectionCreateInput` / `collection: CollectionUpdateInput`.
// Regler (ruleSet) heter nå «sources». En samling laget med tagSources() blir en
// smart samling med samme ruleSet (TAG EQUALS <tagg>) som før, og en samling
// uten sources blir manuell (testet i Testbutikk 2026-10-01).
// Brukt av shopify (bkg-samlinger og strømmer) og sjangre-sync.

export const COLLECTION_CREATE_MUTATION = `
  mutation collectionCreate($collection: CollectionCreateInput!) {
    collectionCreate(collection: $collection) {
      collection { id title handle }
      userErrors { field message }
    }
  }
`;

export const COLLECTION_UPDATE_MUTATION = `
  mutation collectionUpdate($collection: CollectionUpdateInput!) {
    collectionUpdate(collection: $collection) {
      collection { id sortOrder }
      userErrors { field message }
    }
  }
`;

/**
 * Riktig tittel for en eksisterende bkg-samling, eller null når den allerede er
 * riktig eller koden ikke har et navn i COLLECTION_NAMES (da røres den ikke).
 * Retter f.eks. «Bokgruppe 334» → «Ungdom» (pakke B del 9). Handle endres ikke.
 */
export function collectionTitleFix(currentTitle: string | null | undefined, wantedTitle: string | undefined): string | null {
  if (!wantedTitle) return null;
  return (currentTitle ?? "").trim() === wantedTitle ? null : wantedTitle;
}

export interface BkgCollectionPlan {
  /** `suffixed`: tittelen er den samme som en annen samling og har fått « (kode)» */
  create: Array<{ code: string; handle: string; title: string; suffixed?: boolean }>;
  rename: Array<{ code: string; id: string; from: string; to: string }>;
  /** Finnes med riktig tittel */
  existing: string[];
}

/**
 * Titlene til samlinger som lages (pakke H, etter sjekkrapport 06.10). Flere koder har samme
 * navn i bokgruppelista («Jus» under både 21 og 22, «Verk» som både 6 og 60). Eksisterende
 * samlinger får ikke nytt navn. En NY samling som ellers får nøyaktig samme navn som en
 * eksisterende samling eller en annen ny, får «{navn} ({kode})» («Jus (221)»). Er to nye
 * like, får begge tillegget.
 * @param codes     kodene som skal lages
 * @param existing  titlene til samlinger som finnes (og de som får ny tittel til det som står i lista)
 * @param names     COLLECTION_NAMES
 */
export function newCollectionTitles(
  codes: readonly string[],
  existing: Iterable<string>,
  names: Record<string, string>,
): Map<string, { title: string; suffixed: boolean }> {
  const norm = (t: string) => t.trim().toLocaleLowerCase("nb");
  const count = new Map<string, number>();
  for (const t of existing) count.set(norm(t), (count.get(norm(t)) ?? 0) + 1);
  for (const c of codes) { const t = names[c] ?? `Bokgruppe ${c}`; count.set(norm(t), (count.get(norm(t)) ?? 0) + 1); }
  const out = new Map<string, { title: string; suffixed: boolean }>();
  for (const c of codes) {
    const t = names[c] ?? `Bokgruppe ${c}`;
    out.set(c, (count.get(norm(t)) ?? 0) > 1 ? { title: `${t} (${c})`, suffixed: true } : { title: t, suffixed: false });
  }
  return out;
}

/**
 * Hvilke bkg-samlinger som må lages eller få ny tittel (pakke E del 5).
 * @param codes   kodene (med overordnede nivåer, se bokgruppeCollectionCodes)
 * @param current eksisterende samlinger: kode → { id, title } (handle bkg-<kode>)
 * @param names   COLLECTION_NAMES
 */
export function bkgCollectionPlan(
  codes: readonly string[],
  current: ReadonlyMap<string, { id: string; title: string }>,
  names: Record<string, string>,
): BkgCollectionPlan {
  const plan: BkgCollectionPlan = { create: [], rename: [], existing: [] };
  const toCreate: string[] = [];
  const titlesAfter: string[] = [];
  for (const code of codes) {
    const col = current.get(code);
    if (!col) { toCreate.push(code); continue; }
    const fixed = collectionTitleFix(col.title, names[code]);
    if (fixed) { plan.rename.push({ code, id: col.id, from: col.title, to: fixed }); titlesAfter.push(fixed); }
    else { plan.existing.push(code); titlesAfter.push(col.title); }
  }
  // Alle eksisterende bkg-samlinger (også de planen ikke nevner) teller når navnene sammenlignes
  for (const [code, col] of current) if (!codes.includes(code)) titlesAfter.push(col.title);
  const titles = newCollectionTitles(toCreate, titlesAfter, names);
  for (const code of toCreate) {
    const t = titles.get(code)!;
    plan.create.push({ code, handle: `bkg-${code}`, title: t.title, ...(t.suffixed ? { suffixed: true } : {}) });
  }
  return plan;
}

/** Smart samling: produkter med taggen (tilsvarer ruleSet TAG EQUALS <tag>). */
export function tagSources(tag: string) {
  return [{
    source: {
      title: `Tagg ${tag}`,
      inclusion: {
        matchType: "ALL",
        conditions: [{ productTag: { relation: "TAGGED_WITH", values: [tag], matchType: "ANY" } }],
      },
    },
  }];
}
