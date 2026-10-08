// supabase/functions/_shared/publish.ts
// Salgskanaler (pakke H del 2): én felles regel for hvilke kanaler et produkt publiseres på.
// Brukes av push (shopify/index.ts), tilgjengelighetsjobben (når en bok blir aktiv) og
// bokdata-jobben (aktive bøker som mangler kanaler). Alle kanalene appen kjenner = alle
// `publications` i butikken, akkurat som push alltid har gjort.
//
// Rene funksjoner (channelsToPublish, publishBulkLine) testes i scripts/publish.test.mjs.
// Beskyttede produkter, lydbøker, e-bøker og ikke-bøker røres aldri her.

import { getShopDomain, shopifyGraphQL } from "./shopify.ts";
import { protectedProduct, type ProtectableProduct } from "./protected.ts";

export const PUBLICATIONS_QUERY = `
  query GetPublications {
    publications(first: 25) {
      edges { node { id } }
    }
  }
`;

export const PUBLISHABLE_PUBLISH_MUTATION = `
  mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

/** Samme mutasjon i bulk-form (én linje per produkt: { id, input }) */
export const PUBLISH_BULK_MUTATION = `mutation publishBulk($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) { userErrors { field message } }
}`;

/** Feltet som legger kanalene produktet allerede er publisert på inn i bulk-spørringene (barn-linjer med publication.id) */
export const PUBLISHED_ON_BULK_FIELD = `resourcePublicationsV2(onlyPublished: true) { edges { node { __typename publication { id } } } }`;

interface PublicationsCacheEntry { ids: string[]; expiry: number }
const publicationsCache = new Map<string, PublicationsCacheEntry>();

/** Alle salgskanalene i butikken. Hurtigbufret i 30 min per funksjonsinstans (kanalene endres sjelden). */
export async function getAllPublicationIds(_shopKey = "shop"): Promise<string[]> {
  // Nøkkelen er den aktive butikken, så kanaler fra en annen butikk aldri gjenbrukes etter bytte
  const shopKey = await getShopDomain();
  const cached = publicationsCache.get(shopKey);
  if (cached && Date.now() < cached.expiry) return cached.ids;
  const result = await shopifyGraphQL(PUBLICATIONS_QUERY, {});
  const ids = ((result.data?.publications?.edges as { node: { id: string } }[]) || []).map((e) => e.node.id);
  publicationsCache.set(shopKey, { ids, expiry: Date.now() + 30 * 60 * 1000 });
  return ids;
}

/** Publiserer ett produkt på alle kanaler (push). Kaster ved nettverks-/GraphQL-feil; brukerfeil returneres. */
export async function publishToAllChannels(productId: string, shopKey = "shop"): Promise<string | null> {
  const publicationIds = await getAllPublicationIds(shopKey);
  if (!publicationIds.length) return null;
  const r = await shopifyGraphQL(PUBLISHABLE_PUBLISH_MUTATION, {
    id: productId,
    input: publicationIds.map((publicationId) => ({ publicationId })),
  });
  const errs = (r.data?.publishablePublish?.userErrors ?? []) as { message: string }[];
  return errs.length ? errs.map((e) => e.message).join(", ") : null;
}

export interface PublishCandidate extends ProtectableProduct {
  id: string;
  status?: string | null;
  productType?: string | null;
  /** Kanalene produktet er publisert på nå (fra bulk-spørringen). undefined = ukjent → ingenting gjøres */
  publicationIds?: string[] | null;
}

/**
 * Kanalene produktet skal publiseres på nå (de som mangler), eller [] når det ikke skal røres:
 * beskyttet, ikke aktivt (eller blir ikke aktivt), ikke bok (lydbok, e-bok, ikke-bok) eller ukjent status for kanaler.
 * @param isBookType «Bok» fra ONIX (`bookFormat(...).productType`), null når ONIX mangler
 * @param willBeActive status etter jobbens egne endringer
 */
export function channelsToPublish(
  allIds: readonly string[],
  product: PublishCandidate,
  isBookType: string | null,
  willBeActive: boolean,
): string[] {
  if (!willBeActive) return [];
  if (protectedProduct(product)) return [];
  if (isBookType !== "Bok") return [];
  const pt = String(product.productType ?? "").trim();
  if (pt && pt !== "Bok") return []; // eksisterende Lydbok/E-bok/annet røres ikke
  if (!product.publicationIds) return [];
  const have = new Set(product.publicationIds);
  return allIds.filter((id) => !have.has(id));
}

/** JSONL-linje til PUBLISH_BULK_MUTATION */
export function publishBulkLine(productId: string, publicationIds: readonly string[]): { id: string; input: Array<{ publicationId: string }> } {
  return { id: productId, input: publicationIds.map((publicationId) => ({ publicationId })) };
}

/** «ville blitt publisert på 5 kanaler (3 bøker)» */
export function publishSummary(products: number, channels: number, update: boolean): string {
  return `${update ? "publisert" : "ville blitt publisert"} på ${channels} kanaler (${products} bøker)`;
}
