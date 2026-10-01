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
