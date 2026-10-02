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
  create: Array<{ code: string; handle: string; title: string }>;
  rename: Array<{ code: string; id: string; from: string; to: string }>;
  /** Finnes med riktig tittel */
  existing: string[];
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
  for (const code of codes) {
    const col = current.get(code);
    if (!col) {
      plan.create.push({ code, handle: `bkg-${code}`, title: names[code] ?? `Bokgruppe ${code}` });
      continue;
    }
    const fixed = collectionTitleFix(col.title, names[code]);
    if (fixed) plan.rename.push({ code, id: col.id, from: col.title, to: fixed });
    else plan.existing.push(code);
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
