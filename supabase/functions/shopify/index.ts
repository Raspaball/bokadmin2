// supabase/functions/shopify/index.ts
// Deploy: supabase functions deploy shopify --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getShopDomain, shopifyGraphQL } from "../_shared/shopify.ts";

// ── Bokbasen auth (for ISBN → bokgruppekode lookup during catalog sync) ───────
const BOKBASEN_AUTH_URL = "https://auth.bokbasen.io/oauth/token";
const BOKBASEN_ONIX_BASE = "https://api.bokbasen.io/metadata";

interface BokbasenCredentials {
  clientId: string;
  clientSecret: string;
}

// Shopify-tilgangen er felles for hele serveren (se _shared/shopify.ts).
// Kun Bokbasen kan fortsatt settes per bruker i user_settings.
interface CredentialBundle {
  bokbasen: BokbasenCredentials;
}

interface BokbasenTokenCacheEntry {
  token: string;
  expiry: number;
}

const bokbasenTokenCache = new Map<string, BokbasenTokenCacheEntry>();

interface PublicationsCacheEntry {
  ids: string[];
  expiry: number;
}

const publicationsCache = new Map<string, PublicationsCacheEntry>();

async function getBokbasenToken(credentials: BokbasenCredentials): Promise<string> {
  const cacheKey = `${credentials.clientId}:${credentials.clientSecret}`;
  const cached = bokbasenTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.token;

  const res = await fetch(BOKBASEN_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      audience: "https://api.bokbasen.io/metadata/",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Bokbasen auth: ${res.status}`);
  const data = await res.json();
  const token = data.access_token as string;
  const expiry = Date.now() + (data.expires_in - 60) * 1000;
  bokbasenTokenCache.set(cacheKey, { token, expiry });
  return token;
}

// Minimal ONIX parser: only extracts SubjectSchemeIdentifier 37 (bokgruppekode)
async function fetchBokgruppekode(isbn: string, credentials: BokbasenCredentials): Promise<string | null> {
  try {
    const token = await getBokbasenToken(credentials);
    const res = await fetch(`${BOKBASEN_ONIX_BASE}/export/onix/v2/${isbn}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const xml = (await res.text())
      .replace(/\s+xmlns[^"]*"[^"]*"/g, "")
      .replace(/<(\w+:)/g, "<")
      .replace(/<\/(\w+:)/g, "</");
    for (const s of xml.matchAll(/<Subject[\s\S]*?<\/Subject>/gi)) {
      const scheme = s[0].match(/<SubjectSchemeIdentifier[^>]*>(.*?)<\/SubjectSchemeIdentifier>/i)?.[1];
      const code = s[0].match(/<SubjectCode[^>]*>(.*?)<\/SubjectCode>/i)?.[1]?.trim();
      if (scheme === "37" && code) return code;
    }
    return null;
  } catch {
    return null;
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Convert plain text (newline-separated paragraphs) to HTML for Shopify body_html
function toHtml(text: string): string {
  if (!text.trim()) return "";
  return text.trim()
    .split(/\n\n+/)
    .map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

interface BookMetadata {
  isbn: string;
  title: string;
  author: string;
  publisher: string;
  year: string;
  format: string;
  price: number | null;
  description: string;
  imageUrl: string;
  image_url?: string;
  genre: string;
  bokgruppe: string;
  bokgruppekode?: string;
  vekt: number | null;
}

// ── Bokgruppekode → collection name map (1-digit, 2-digit, 3-digit) ──────────
// Kilde: https://forleggerforeningen.no/bokgruppene/
// Format på nettstedet er X.Y.Z — her oversatt til XYZ (f.eks. 3.1.6 → 316)

const COLLECTION_NAMES: Record<string, string> = {
  // ── 1-sifret (hovednivå) ──────────────────────────────────────────────────
  '1': 'Skolebøker',
  '2': 'Fagbøker og lærebøker',
  '3': 'Sakprosa',
  '4': 'Skjønnlitteratur',
  '5': 'Billigbøker',
  '6': 'Verk',
  '7': 'Kommisjonsbøker, lover, forskningsrapporter',
  '8': 'Lydbøker og elektroniske innholdsprodukter',
  '9': 'Annen litteratur',

  // ── 2-sifret ──────────────────────────────────────────────────────────────
  '11': 'Skolebøker',
  '21': 'Fagbøker, høyere utdanning',
  '22': 'Fagbøker, yrkesfaglig utdanning',
  '31': 'Sakprosa norsk, voksne',
  '32': 'Sakprosa oversatt, voksne',
  '33': 'Sakprosa norsk, barn og ungdom',
  '34': 'Sakprosa oversatt, barn og ungdom',
  '41': 'Norsk skjønnlitteratur, voksne',
  '42': 'Oversatt skjønnlitteratur, voksne',
  '43': 'Norsk skjønnlitteratur, barn og ungdom',
  '44': 'Oversatt skjønnlitteratur, barn og ungdom',
  '50': 'Billigbøker',
  '60': 'Verk',
  '70': 'Kommisjonsbøker og tilsvarende',
  '80': 'Digitale produkter, læremateriell',
  '81': 'E-bøker, forbrukermarkedet',
  '82': 'Digitalt læremateriell',
  '83': 'Øvrige produkter',
  '85': 'E-bøker',
  '88': 'Lydbøker',
  '89': 'Digitale læremidler',
  '91': 'Norske serieromaner',
  '92': 'Oversatte underholdningsromaner',
  '93': 'Utenlandsk sakprosa',
  '94': 'Utenlandsk skjønnlitteratur',

  // ── 3-sifret ──────────────────────────────────────────────────────────────
  // 1xx — Skolebøker
  '110': 'Grunnskolen',
  '120': 'Videregående skole',
  // 2xx — Fagbøker og lærebøker
  '210': 'Diverse fagbøker',
  '211': 'Jus',
  '212': 'Økonomi, administrasjon, markedsføring',
  '213': 'Helse og sosialfag',
  '214': 'Samfunnsvitenskapelige fag',
  '215': 'Pedagogikk',
  '216': 'Språk og estetiske fag',
  '217': 'Religion, historie, litteraturvitenskap, filosofi',
  '218': 'Tekniske fag',
  '219': 'Naturvitenskapelige fag',
  '220': 'Diverse fagbøker',
  '221': 'Jus',
  '222': 'Økonomi, administrasjon, markedsføring',
  '223': 'Helse og sosialfag',
  '224': 'Samfunnsvitenskapelige fag',
  '225': 'Pedagogikk',
  '226': 'Språk og estetiske fag',
  '227': 'Religion, historie, litteraturvitenskap, filosofi',
  '228': 'Tekniske fag',
  '229': 'Naturvitenskapelige fag',
  // 3xx — Sakprosa
  '310': 'Diverse sakprosa',
  '311': 'Kultur, religion, kunst',
  '312': 'Samfunn, historie',
  '313': 'Kropp og sinn',
  '314': 'Natur, friluftsliv, sport',
  '315': 'Reise og geografi',
  '316': 'Mat og drikke',
  '317': 'Hobby',
  '318': 'Teknikk og populærvitenskap',
  '319': 'Memoarer, biografier',
  '320': 'Diverse sakprosa oversatt',
  '321': 'Kultur, religion, kunst',
  '322': 'Samfunn, historie',
  '323': 'Kropp og sinn',
  '324': 'Natur, friluftsliv, sport',
  '325': 'Reise og geografi',
  '326': 'Mat og drikke',
  '327': 'Hobby',
  '328': 'Teknikk, populærvitenskap',
  '329': 'Memoarer, biografier',
  '330': 'Diverse sakprosa barn og ungdom',
  '331': 'Billedbøker',
  '332': 'Barn',
  '333': 'Junior',
  '334': 'Ungdom',
  '340': 'Diverse sakprosa barn og ungdom oversatt',
  '341': 'Billedbøker',
  '342': 'Barn',
  '343': 'Junior',
  '344': 'Ungdom',
  // 4xx — Skjønnlitteratur
  '410': 'Diverse norsk skjønnlitteratur',
  '411': 'Romaner',
  '412': 'Noveller',
  '413': 'Lyrikk',
  '414': 'Skuespill',
  '415': 'Essays',
  '416': 'Antologier',
  '417': 'Krim/spenning',
  '418': 'Klassisk litteratur',
  '419': 'Sang- og visebøker',
  '420': 'Diverse oversatt skjønnlitteratur',
  '421': 'Romaner',
  '422': 'Noveller',
  '423': 'Lyrikk',
  '424': 'Skuespill',
  '425': 'Essays',
  '426': 'Antologier',
  '427': 'Krim/spenning',
  '428': 'Klassisk litteratur',
  '429': 'Sang- og visebøker',
  '430': 'Diverse norsk skjønnlitteratur barn og ungdom',
  '431': 'Billedbøker',
  '432': 'Romaner barn',
  '433': 'Romaner junior',
  '434': 'Romaner ungdom',
  '435': 'Antologier',
  '436': 'Klassisk litteratur',
  '437': 'Sang, viser, dikt',
  '438': 'Noveller',
  '440': 'Diverse oversatt skjønnlitteratur barn og ungdom',
  '441': 'Billedbøker',
  '442': 'Romaner barn',
  '443': 'Romaner junior',
  '444': 'Romaner ungdom',
  '445': 'Antologier',
  '446': 'Klassisk litteratur',
  '447': 'Sang, viser, dikt',
  '448': 'Noveller',
  // 5xx — Billigbøker
  '500': 'Diverse billigbøker',
  '501': 'Norsk sakprosa for voksne',
  '502': 'Norsk skjønnlitteratur for voksne',
  '503': 'Oversatt sakprosa for voksne',
  '504': 'Oversatt skjønnlitteratur for voksne',
  '505': 'Norsk sakprosa for barn og ungdom',
  '506': 'Norsk skjønnlitteratur for barn og ungdom',
  '507': 'Oversatt sakprosa for barn og ungdom',
  '508': 'Oversatt skjønnlitteratur for barn og ungdom',
  // 6xx — Verk
  '600': 'Diverse verk',
  '601': 'Skjønnlitterære verk for voksne',
  '602': 'Sakprosaverk for voksne',
  '603': 'Skjønnlitterære verk for barn og unge',
  '604': 'Sakprosaverk for barn og unge',
  '605': 'Leksikale verk for voksne',
  '606': 'Leksikale verk for barn og unge',
  // 7xx — Kommisjonsbøker, lover, forskningsrapporter
  '700': 'Diverse kommisjonsbøker',
  '701': 'Tidsskrifter',
  '702': 'Grunnskolen/Videregående skole',
  '703': 'Lærebøker for høyere utdanning',
  '704': 'Lærebøker til voksenopplæring',
  '705': 'Fagbøker for profesjonsmarkedet',
  '706': 'Skjønnlitteratur/sakprosa for voksne',
  '707': 'Skjønnlitteratur/sakprosa for barn',
  '708': 'Lover, forskrifter og forskningsrapporter',
  '709': 'Sammensatte bokprodukter',
  // 8xx — Lydbøker og elektroniske innholdsprodukter
  '800': 'Diverse digitale produkter',
  '801': 'Grunnskolen',
  '802': 'Videregående skole',
  '803': 'Høyere utdanning',
  '804': 'Voksenopplæring',
  '805': 'Faglitteratur for profesjonsmarkedet',
  '806': 'Sakprosa, voksne',
  '807': 'Sakprosa, barn og unge',
  '808': 'Skjønnlitteratur, barn og unge',
  '809': 'Lover, forskrifter og forskningsrapporter',
  '810': 'Diverse lydbøker (fysisk)',
  '811': 'Lydbok (fysisk) norsk sakprosa, voksne',
  '812': 'Lydbok (fysisk) norsk skjønnlitteratur, voksne',
  '813': 'Lydbok (fysisk) oversatt sakprosa, voksne',
  '814': 'Lydbok (fysisk) oversatt skjønnlitteratur, voksne',
  '815': 'Lydbok (fysisk) norsk sakprosa, barn og ungdom',
  '816': 'Lydbok (fysisk) norsk skjønnlitteratur, barn og ungdom',
  '817': 'Lydbok (fysisk) oversatt sakprosa, barn og ungdom',
  '818': 'Lydbok (fysisk) oversatt skjønnlitteratur, barn og ungdom',
  '820': 'Diverse digitalt læremateriell',
  '821': 'Digitalt læremateriell, grunnskolen',
  '822': 'Digitalt læremateriell, videregående',
  '823': 'Digitalt læremateriell, høyere utdanning',
  '824': 'Digitalt læremateriell, voksenopplæring',
  '825': 'Faglitteratur for profesjonsmarkedet, digitalt',
  '830': 'Diverse øvrige produkter',
  '831': 'Kart',
  '832': 'Kalendere, dagbøker, almanakker',
  '833': 'Lover, forskrifter og forskningsrapporter',
  '834': 'Leker, puslespill, tegne- og malemateriell',
  '835': 'Butikkmateriell',
  '836': 'Kontorartikler og kortevarer',
  '837': 'Vitnemål, skoleadministrativt materiell',
  '838': 'Sammensatte produkter',
  '850': 'Diverse e-bøker',
  '851': 'E-bok norsk sakprosa, voksne',
  '852': 'E-bok norsk skjønnlitteratur, voksne',
  '853': 'E-bok oversatt sakprosa, voksne',
  '854': 'E-bok oversatt skjønnlitteratur, voksne',
  '855': 'E-bok norsk sakprosa, barn og ungdom',
  '856': 'E-bok norsk skjønnlitteratur, barn og ungdom',
  '857': 'E-bok oversatt sakprosa, barn og ungdom',
  '858': 'E-bok oversatt skjønnlitteratur, barn og ungdom',
  '880': 'Diverse lydbøker',
  '881': 'Lydbok norsk sakprosa, voksne',
  '882': 'Lydbok norsk skjønnlitteratur, voksne',
  '883': 'Lydbok oversatt sakprosa, voksne',
  '884': 'Lydbok oversatt skjønnlitteratur, voksne',
  '885': 'Lydbok norsk sakprosa, barn og ungdom',
  '886': 'Lydbok norsk skjønnlitteratur, barn og ungdom',
  '887': 'Lydbok oversatt sakprosa, barn og ungdom',
  '888': 'Lydbok oversatt skjønnlitteratur, barn og ungdom',
  '890': 'Diverse digitale læremidler',
  '891': 'Digitale læremidler, grunnskolen',
  '892': 'Digitale læremidler, videregående',
  '893': 'Digitale læremidler, høyere utdanning',
  '894': 'Digitale læremidler, voksenopplæring',
  '895': 'Faglitteratur for profesjonsmarkedet, digitalt',
  // 9xx — Annen litteratur
  '910': 'Norske serieromaner',
  '920': 'Oversatte underholdningsromaner',
  '930': 'Diverse utenlandsk sakprosa',
  '931': 'Sakprosa på originalspråket, voksen',
  '932': 'Ordbøker og undervisningsmateriell på originalspråket',
  '933': 'Reise og geografi på originalspråket',
  '934': 'Sakprosa på originalspråket, barn og ungdom',
  '940': 'Diverse utenlandsk skjønnlitteratur',
  '941': 'Skjønnlitteratur på originalspråket, voksen',
  '942': 'Krim og spenning på originalspråket, voksen',
  '943': 'Fantasy/SF på originalspråket, voksen',
  '944': 'Skjønnlitteratur på originalspråket, barn og ungdom',
};

// Derive all tag codes for a given bokgruppekode (1-digit, 2-digit, 3-digit)
function bokgruppeTagsForKode(kode: string): string[] {
  const tags: string[] = [];
  if (kode.length >= 1) tags.push(`bkg-${kode[0]}`);
  if (kode.length >= 2) tags.push(`bkg-${kode.slice(0, 2)}`);
  if (kode.length >= 3) tags.push(`bkg-${kode}`);
  return tags;
}

// ── Product mutations ────────────────────────────────────────────────────────

const PRODUCT_BY_HANDLE_QUERY = `
  query productByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      id title handle
      variants(first: 1) { edges { node { id sku price } } }
      images(first: 1) { edges { node { id } } }
    }
  }
`;

const PRODUCT_CREATE_MUTATION = `
  mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product {
        id title handle
        variants(first: 1) { edges { node { id sku price } } }
      }
      userErrors { field message }
    }
  }
`;

const PRODUCT_UPDATE_MUTATION = `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product {
        id title handle
        variants(first: 1) { edges { node { id sku price } } }
      }
      userErrors { field message }
    }
  }
`;

const VARIANT_UPDATE_MUTATION = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price }
      userErrors { field message }
    }
  }
`;

const INVENTORY_ITEM_UPDATE = `
  mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id sku }
      userErrors { field message }
    }
  }
`;

const PRODUCT_IMAGE_MUTATION = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id }
      mediaUserErrors { field message }
    }
  }
`;

const PUBLICATIONS_QUERY = `
  query GetPublications {
    publications(first: 25) {
      edges { node { id name } }
    }
  }
`;

const PUBLISHABLE_PUBLISH_MUTATION = `
  mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

// Sales channels ("publications") a product must be published to so it doesn't
// sit at "0 salgskanaler" after export. Cached per shop for the life of the
// function instance — the set of channels rarely changes.
async function getAllPublicationIds(): Promise<string[]> {
  const shopDomain = getShopDomain();
  const cached = publicationsCache.get(shopDomain);
  if (cached && Date.now() < cached.expiry) return cached.ids;

  const result = await shopifyGraphQL(PUBLICATIONS_QUERY, {});
  const ids = ((result.data?.publications?.edges as { node: { id: string } }[]) || []).map((e) => e.node.id);
  publicationsCache.set(shopDomain, { ids, expiry: Date.now() + 30 * 60 * 1000 });
  return ids;
}

async function publishToAllChannels(productId: string): Promise<void> {
  const publicationIds = await getAllPublicationIds();
  if (!publicationIds.length) return;
  await shopifyGraphQL(PUBLISHABLE_PUBLISH_MUTATION, {
    id: productId,
    input: publicationIds.map((publicationId) => ({ publicationId })),
  });
}

// ── Collection mutations ─────────────────────────────────────────────────────

const COLLECTION_BY_HANDLE_QUERY = `
  query collectionByHandle($handle: String!) {
    collectionByHandle(handle: $handle) {
      id title handle
    }
  }
`;

const COLLECTION_CREATE_MUTATION = `
  mutation collectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id title handle }
      userErrors { field message }
    }
  }
`;

const ALL_PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        cursor
        node { id handle tags }
      }
      pageInfo { hasNextPage }
    }
  }
`;

const CATALOG_PRODUCTS_QUERY = `
  query GetCatalogProducts($first: Int!, $after: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
    products(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse) {
      edges {
        cursor
        node {
          id handle title productType vendor status
          descriptionHtml tags createdAt
          images(first: 1) { edges { node { url altText } } }
          variants(first: 1) {
            edges { node { id price compareAtPrice sku barcode inventoryPolicy } }
          }
          seoTitleMf: metafield(namespace: "global", key: "title_tag") { value }
          seoDescMf: metafield(namespace: "global", key: "description_tag") { value }
          collections(first: 10) { edges { node { title } } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ── Push one book ────────────────────────────────────────────────────────────

async function pushOneBook(
  book: BookMetadata
): Promise<{ shopifyId: string; handle: string; variantId?: string }> {
  // Build tag list: author, title + bokgruppekode hierarchy
  const tagList = [book.author, book.title].filter(Boolean);
  if (book.bokgruppekode) {
    tagList.push(...bokgruppeTagsForKode(book.bokgruppekode));
  }
  const tags = tagList.join(", ");

  const handle = book.isbn;

  // Step 1: Check if product exists, then create or update
  let product: Record<string, unknown> | null = null;
  let isUpdate = false;
  let alreadyHasImage = false;

  try {
    const lookupResult = await shopifyGraphQL(PRODUCT_BY_HANDLE_QUERY, { handle });
    const existing = lookupResult.data?.productByHandle;
    if (existing?.id) {
      product = existing;
      isUpdate = true;
      alreadyHasImage = (existing.images as { edges: unknown[] })?.edges?.length > 0;
    }
  } catch (_) { /* not found — create */ }

  const productInput: Record<string, unknown> = {
    title: book.title,
    handle,
    descriptionHtml: toHtml(book.description || ""),
    vendor: book.publisher || "",
    productType: book.author || "",
    tags,
    status: "ACTIVE",
  };

  if (isUpdate && product) {
    productInput.id = product.id;
    const updateResult = await shopifyGraphQL(PRODUCT_UPDATE_MUTATION, { input: productInput });
    const { product: updated, userErrors } = updateResult.data?.productUpdate || {};
    if (userErrors?.length) throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
    if (updated) product = updated;
  } else {
    const createResult = await shopifyGraphQL(PRODUCT_CREATE_MUTATION, { input: productInput });
    const { product: created, userErrors } = createResult.data?.productCreate || {};
    if (userErrors?.length) throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
    product = created;
  }

  if (!product?.id) throw new Error("Product create/update returned no product");

  // Publish to every available sales channel — productCreate does not do this
  // on its own, so a freshly exported product would otherwise sit at "0
  // salgskanaler" until someone publishes it manually in Shopify Admin.
  try {
    await publishToAllChannels(product.id as string);
  } catch (_) { /* non-critical — product still exists, just unpublished */ }

  const variantId = (product.variants as { edges: { node: { id: string } }[] })?.edges?.[0]?.node?.id;

  // Step 2: Update variant price + barcode
  if (variantId) {
    await shopifyGraphQL(VARIANT_UPDATE_MUTATION, {
      productId: product.id,
      variants: [{
        id: variantId,
        barcode: book.isbn,
        price: book.price ? String(book.price) : "0",
        taxable: false,
      }],
    });

    // Step 2b: Update inventory item (SKU + weight)
    try {
      const variantQuery = `{ productVariant(id: "${variantId}") { inventoryItem { id } } }`;
      const variantData = await shopifyGraphQL(variantQuery, {});
      const inventoryItemId = variantData.data?.productVariant?.inventoryItem?.id;
      if (inventoryItemId) {
        const invInput: Record<string, unknown> = { sku: book.isbn };
        if (book.vekt) invInput.measurement = { weight: { value: book.vekt, unit: "GRAMS" } };
        await shopifyGraphQL(INVENTORY_ITEM_UPDATE, { id: inventoryItemId, input: invInput });
      }
    } catch (_) { /* non-critical */ }
  }

  // Step 3: SEO via metafields
  try {
    await shopifyGraphQL(`
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key value }
          userErrors { field message }
        }
      }
    `, {
      metafields: [
        { ownerId: product.id, namespace: "global", key: "title_tag", value: book.title || "", type: "single_line_text_field" },
        { ownerId: product.id, namespace: "global", key: "description_tag", value: (book.description || "").slice(0, 320), type: "single_line_text_field" },
      ],
    });
  } catch (_) { /* non-critical */ }

  // Step 4: Image — only add if product has no image yet
  const imageUrl = book.imageUrl || book.image_url;
  if (imageUrl && !alreadyHasImage) {
    try {
      await shopifyGraphQL(PRODUCT_IMAGE_MUTATION, {
        productId: product.id,
        media: [{ originalSource: imageUrl, alt: book.title, mediaContentType: "IMAGE" }],
      });
    } catch (_) { /* non-critical */ }
  }

  return { shopifyId: product.id as string, handle: product.handle as string, variantId };
}

// ── Sync Smart Collections ────────────────────────────────────────────────────

interface CollectionSyncDetail {
  code: string;
  level: number;
  title: string;
  status: "created" | "existing" | "error";
  id?: string;
  error?: string;
}

interface CollectionSyncResult {
  created: number;
  existing: number;
  errors: number;
  total: number;
  details: CollectionSyncDetail[];
}

interface FullSyncResult {
  products: {
    total: number;
    updated: number;
    alreadyTagged: number;
    noKode: number;
    tagErrors: number;
  };
  collections: CollectionSyncResult;
}

interface AnalyzeResult {
  totalProducts: number;
  alreadyTagged: number;   // har bkg-NNN tag allerede
  needsTagging: number;    // mangler bkg-NNN men har ISBN-handle → kan fikses
  unplaceable: number;     // mangler bkg-tag og er ikke ISBN → kan ikke plasseres automatisk
  collections: {
    existing: number;      // bkg-* collections som allerede finnes i Shopify
    toCreate: number;      // bkg-* collections som vil bli opprettet
    total: number;         // totalt antall i COLLECTION_NAMES
  };
}

async function analyzeCollections(): Promise<AnalyzeResult> {
  // Hent alle produkter (kun id, handle, tags)
  const allProducts: Array<{ handle: string; tags: string[] }> = [];
  let after: string | null = null;

  while (true) {
    const variables: Record<string, unknown> = { first: 250 };
    if (after) variables.after = after;
    const result = await shopifyGraphQL(`
      query($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { cursor node { handle tags } }
        }
      }
    `, variables);
    const edges: Array<{ cursor: string; node: { handle: string; tags: string[] } }> =
      result.data?.products?.edges ?? [];
    for (const edge of edges) {
      allProducts.push(edge.node);
      after = edge.cursor;
    }
    if (!result.data?.products?.pageInfo?.hasNextPage) break;
    await new Promise(r => setTimeout(r, 200));
  }

  // Analyser tags — finn koder som faktisk brukes i katalogen
  let alreadyTagged = 0, needsTagging = 0, unplaceable = 0;
  const koderInUse = new Set<string>(); // 3-digit koder som faktisk finnes
  for (const product of allProducts) {
    const tag3 = product.tags.find(t => /^bkg-\d{3}$/.test(t));
    if (tag3) {
      alreadyTagged++;
      koderInUse.add(tag3.slice(4)); // strip "bkg-"
    } else if (/^\d{10,13}$/.test(product.handle)) {
      needsTagging++;
    } else {
      unplaceable++;
    }
  }

  // Bygg ut alle koder som faktisk vil bli opprettet (1+2+3-sifret for brukte koder)
  const codesNeeded = new Set<string>();
  for (const kode of koderInUse) {
    if (kode.length >= 1) codesNeeded.add(kode[0]);
    if (kode.length >= 2) codesNeeded.add(kode.slice(0, 2));
    if (kode.length >= 3) codesNeeded.add(kode);
  }

  // Hent eksisterende bkg-* collections (batch 250)
  const existingBkgHandles = new Set<string>();
  let colAfter: string | null = null;
  while (true) {
    const variables: Record<string, unknown> = { first: 250 };
    if (colAfter) variables.after = colAfter;
    const result = await shopifyGraphQL(`
      query($first: Int!, $after: String) {
        collections(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { cursor node { handle } }
        }
      }
    `, variables);
    const edges: Array<{ cursor: string; node: { handle: string } }> =
      result.data?.collections?.edges ?? [];
    for (const edge of edges) {
      if (edge.node.handle.startsWith("bkg-")) existingBkgHandles.add(edge.node.handle);
      colAfter = edge.cursor;
    }
    if (!result.data?.collections?.pageInfo?.hasNextPage) break;
    await new Promise(r => setTimeout(r, 200));
  }

  const needed = [...codesNeeded];
  const existing = needed.filter(k => existingBkgHandles.has(`bkg-${k}`)).length;
  const total = needed.length;

  return {
    totalProducts: allProducts.length,
    alreadyTagged,
    needsTagging,
    unplaceable,
    collections: { existing, toCreate: total - existing, total },
  };
}

async function ensureCollections(
  koder: Set<string>
): Promise<CollectionSyncResult> {
  // Expand each 3-digit code to 1-digit, 2-digit, and 3-digit codes
  const allCodes = new Set<string>();
  for (const kode of koder) {
    if (!kode || kode === "ukjent") continue;
    const k = kode.trim();
    if (k.length >= 1) allCodes.add(k[0]);
    if (k.length >= 2) allCodes.add(k.slice(0, 2));
    if (k.length >= 3) allCodes.add(k.slice(0, 3));
  }

  // Sort: 1-digit first, then 2-digit, then 3-digit
  const sortedCodes = [...allCodes].sort((a, b) => a.length - b.length || a.localeCompare(b));

  let created = 0, existing = 0, errors = 0;
  const details: CollectionSyncDetail[] = [];

  for (const code of sortedCodes) {
    const handle = `bkg-${code}`;
    const title = COLLECTION_NAMES[code] ?? `Bokgruppe ${code}`;
    const tag = `bkg-${code}`;
    const level = code.length;

    try {
      const lookupResult = await shopifyGraphQL(COLLECTION_BY_HANDLE_QUERY, { handle });
      const existingCol = lookupResult.data?.collectionByHandle;

      if (existingCol?.id) {
        existing++;
        details.push({ code, level, title, status: "existing", id: existingCol.id });
      } else {
        const createResult = await shopifyGraphQL(COLLECTION_CREATE_MUTATION, {
          input: {
            title,
            handle,
            ruleSet: {
              appliedDisjunctively: false,
              rules: [{ column: "TAG", relation: "EQUALS", condition: tag }],
            },
          },
        });
        const { collection, userErrors } = createResult.data?.collectionCreate || {};
        if (userErrors?.length) {
          throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
        }
        created++;
        details.push({ code, level, title, status: "created", id: collection?.id });
      }
    } catch (e) {
      errors++;
      details.push({ code, level, title, status: "error", error: String(e) });
    }

    await new Promise(r => setTimeout(r, 250));
  }

  return { created, existing, errors, total: sortedCodes.length, details };
}

async function fullSyncCollections(
  bokbasenCredentials: BokbasenCredentials,
): Promise<FullSyncResult> {
  // ── Step 1: Fetch all Shopify products (paginated) ─────────────────────────
  const allProducts: Array<{ id: string; handle: string; tags: string[] }> = [];
  let after: string | null = null;

  while (true) {
    const variables: Record<string, unknown> = { first: 50 };
    if (after) variables.after = after;

    const result = await shopifyGraphQL(ALL_PRODUCTS_QUERY, variables);
    const edges: Array<{ cursor: string; node: { id: string; handle: string; tags: string[] } }> =
      result.data?.products?.edges ?? [];
    const pageInfo: { hasNextPage: boolean } = result.data?.products?.pageInfo ?? {};

    for (const edge of edges) {
      allProducts.push(edge.node);
      after = edge.cursor;
    }

    if (!pageInfo.hasNextPage) break;
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Step 2: Determine bokgruppekode for each product ──────────────────────
  // If a product already has a 3-digit bkg-NNN tag, we know its kode.
  // Otherwise look it up from Bokbasen (handle = ISBN).
  const productToKode = new Map<string, string>(); // product.id → kode
  const needsLookup: Array<{ id: string; handle: string; tags: string[] }> = [];

  for (const product of allProducts) {
    const existing = product.tags.find(t => /^bkg-\d{3}$/.test(t));
    if (existing) {
      productToKode.set(product.id, existing.slice(4)); // strip "bkg-"
    } else if (/^\d{10,13}$/.test(product.handle)) {
      needsLookup.push(product); // ISBN-shaped handle, look up Bokbasen
    }
  }

  // Batch Bokbasen lookups (10 parallel)
  const batchSize = 10;
  for (let i = 0; i < needsLookup.length; i += batchSize) {
    const batch = needsLookup.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (p) => {
        const kode = await fetchBokgruppekode(p.handle, bokbasenCredentials);
        if (!kode) throw new Error("no_kode");
        return { id: p.id, kode };
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") productToKode.set(r.value.id, r.value.kode);
    }
    if (i + batchSize < needsLookup.length) await new Promise(r => setTimeout(r, 150));
  }

  // ── Step 3: Tag products that are missing bkg-* tags ──────────────────────
  let updated = 0, alreadyTagged = 0, noKode = 0, tagErrors = 0;
  const koderFound = new Set<string>();

  for (const product of allProducts) {
    const kode = productToKode.get(product.id);
    if (!kode) { noKode++; continue; }

    koderFound.add(kode);
    const requiredTags = bokgruppeTagsForKode(kode);
    const missingTags = requiredTags.filter(t => !product.tags.includes(t));

    if (missingTags.length === 0) { alreadyTagged++; continue; }

    try {
      const updateResult = await shopifyGraphQL(PRODUCT_UPDATE_MUTATION, {
        input: { id: product.id, tags: [...product.tags, ...missingTags] },
      });
      const { userErrors } = updateResult.data?.productUpdate ?? {};
      if (userErrors?.length) throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
      updated++;
    } catch (_e) {
      tagErrors++;
    }

    await new Promise(r => setTimeout(r, 250));
  }

  // ── Step 4: Create / verify Smart Collections ──────────────────────────────
  const collections = await ensureCollections(koderFound);

  return {
    products: { total: allProducts.length, updated, alreadyTagged, noKode, tagErrors },
    collections,
  };
}

// ── CSV export ───────────────────────────────────────────────────────────────

function escapeCSV(val: string | number | null | undefined): string {
  const str = String(val ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function booksToShopifyCSV(books: BookMetadata[]): string {
  const headers = [
    "URL handle", "Title", "Description", "Vendor", "Type", "Tags",
    "Published on online store", "Status", "Option1 name", "Option1 value",
    "SKU", "Barcode", "Price", "Charge tax", "Product category",
    "Continue selling when out of stock", "Inventory tracker",
    "Weight value (grams)", "Weight unit for display", "Fulfillment service",
    "Requires shipping", "Gift card", "Product image URL",
    "SEO title", "SEO description",
    "Google Shopping / Google product category", "Google Shopping / Condition",
  ];

  const rows = books.map(book => {
    const tagList = [book.author, book.title].filter(Boolean);
    if (book.bokgruppekode) tagList.push(...bokgruppeTagsForKode(book.bokgruppekode));
    const tags = tagList.join(", ");
    const imageUrl = book.imageUrl || book.image_url || "";

    return [
      book.isbn, book.title, book.description || "", book.publisher || "",
      book.author || "", tags, "TRUE", "active", "Title", "Default Title",
      book.isbn, book.isbn, book.price ?? "", "FALSE", "Media > Books > Print Books",
      "continue", "", book.vekt ?? "", "g", "manual", "TRUE", "FALSE",
      imageUrl, book.title, (book.description || "").slice(0, 320),
      "Media > Books", "New",
    ].map(escapeCSV).join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

// ── Megameny — dynamisk fra COLLECTION_NAMES ─────────────────────────────────
// Bygger 3-nivå struktur (bkg-N → bkg-NN → bkg-NNN) direkte fra COLLECTION_NAMES
// slik at menyen alltid er i sync med alle definerte koder.

interface MenuItemInput {
  title: string;
  url: string;
  items?: MenuItemInput[];
}

// Fetch bkg-* collections that have at least 1 product
async function getActiveBkgCodes(): Promise<Set<string>> {
  const activeCodes = new Set<string>();
  let colAfter: string | null = null;
  while (true) {
    const variables: Record<string, unknown> = { first: 50 };
    if (colAfter) variables.after = colAfter;
    const result = await shopifyGraphQL(`
      query($first: Int!, $after: String) {
        collections(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges {
            cursor
            node {
              handle
              products(first: 1) { edges { node { id } } }
            }
          }
        }
      }
    `, variables);
    const edges: Array<{ cursor: string; node: { handle: string; products: { edges: unknown[] } } }> =
      result.data?.collections?.edges ?? [];
    for (const edge of edges) {
      const { handle, products } = edge.node;
      if (handle.startsWith("bkg-") && products.edges.length > 0) {
        activeCodes.add(handle.slice(4)); // strip "bkg-"
      }
      colAfter = edge.cursor;
    }
    if (!result.data?.collections?.pageInfo?.hasNextPage) break;
    await new Promise(r => setTimeout(r, 200));
  }
  return activeCodes;
}

// Build menu tree only from codes that are active (have products), plus their ancestors
function buildMenuStructureFromCodes(activeCodes: Set<string>, maxDepth: 2 | 3): MenuItemInput[] {
  const codes = Object.keys(COLLECTION_NAMES);

  const is2digitActive = (code2: string) =>
    activeCodes.has(code2) ||
    codes.some(k => k.length === 3 && k.startsWith(code2) && activeCodes.has(k));

  return codes
    .filter(k => k.length === 1)
    .sort()
    .flatMap(code1 => {
      const level2 = codes
        .filter(k => k.length === 2 && k[0] === code1 && is2digitActive(k))
        .sort()
        .map(code2 => {
          if (maxDepth === 2) {
            return { title: COLLECTION_NAMES[code2], url: `/collections/bkg-${code2}` } as MenuItemInput;
          }
          const level3 = codes
            .filter(k => k.length === 3 && k.startsWith(code2) && activeCodes.has(k))
            .sort()
            .map(code3 => ({ title: COLLECTION_NAMES[code3], url: `/collections/bkg-${code3}` }));
          return {
            title: COLLECTION_NAMES[code2],
            url: `/collections/bkg-${code2}`,
            ...(level3.length ? { items: level3 } : {}),
          } as MenuItemInput;
        });
      if (level2.length === 0) return [];
      return [{
        title: COLLECTION_NAMES[code1],
        url: `/collections/bkg-${code1}`,
        items: level2,
      } as MenuItemInput];
    });
}

// maxDepth: 2 = 1-digit → 2-digit only (for nesting under a parent item like "Nettbutikk", total 3 levels)
//           3 = 1-digit → 2-digit → 3-digit (for standalone menus, total 3 levels)
function buildMenuStructure(maxDepth: 2 | 3 = 2): MenuItemInput[] {
  const codes = Object.keys(COLLECTION_NAMES);
  return codes
    .filter(k => k.length === 1)
    .sort()
    .map(code1 => {
      const level2 = codes
        .filter(k => k.length === 2 && k[0] === code1)
        .sort()
        .map(code2 => {
          if (maxDepth === 2) {
            return {
              title: COLLECTION_NAMES[code2],
              url: `/collections/bkg-${code2}`,
            };
          }
          const level3 = codes
            .filter(k => k.length === 3 && k.startsWith(code2))
            .sort()
            .map(code3 => ({
              title: COLLECTION_NAMES[code3],
              url: `/collections/bkg-${code3}`,
            }));
          return {
            title: COLLECTION_NAMES[code2],
            url: `/collections/bkg-${code2}`,
            ...(level3.length ? { items: level3 } : {}),
          };
        });
      return {
        title: COLLECTION_NAMES[code1],
        url: `/collections/bkg-${code1}`,
        ...(level2.length ? { items: level2 } : {}),
      };
    });
}


async function buildMegaMenu(
  menuHandle: string,
): Promise<{ success: boolean; itemsCount?: number }> {
  menuHandle = menuHandle.toLowerCase().trim();

  interface ExistingMenuItem {
    id?: string;
    title: string;
    type?: string;
    url?: string;
    resourceId?: string;
    tags?: string[];
    items?: ExistingMenuItem[];
  }

  interface MenuUpdateItem {
    id?: string;
    title: string;
    type?: string;
    url?: string;
    resourceId?: string;
    tags?: string[];
    items?: MenuUpdateItem[];
  }

  // 1. List menyer inkl. eksisterende items, og finn riktig via handle
  const menuQuery = `
    query GetMenus {
      menus(first: 50) {
        edges {
          node {
            id
            title
            handle
            items {
              id
              title
              type
              url
              resourceId
              tags
              items {
                id
                title
                type
                url
                resourceId
                tags
                items {
                  id
                  title
                  type
                  url
                  resourceId
                  tags
                }
              }
            }
          }
        }
      }
    }
  `;
  const menuData = await shopifyGraphQL(menuQuery, {});
  const allMenus: Array<{ id: string; title: string; handle: string; items?: ExistingMenuItem[] }> =
    (menuData.data?.menus?.edges ?? []).map(
      (e: { node: { id: string; title: string; handle: string; items?: ExistingMenuItem[] } }) => e.node
    );
  const menu = allMenus.find(m => m.handle === menuHandle);
  if (!menu) {
    const available = allMenus.map(m => `"${m.handle}"`).join(", ");
    throw new Error(`Fant ikke meny med handle "${menuHandle}". Tilgjengelige: ${available || "ingen"}`);
  }

  // 2 levels under "Nettbutikk" = 3 total (Shopify max)
  // Only include categories that have actual products in Shopify
  const activeCodes = await getActiveBkgCodes();
  const menuStructure = activeCodes.size > 0
    ? buildMenuStructureFromCodes(activeCodes, 2)
    : buildMenuStructure(2); // fallback to full tree if no active codes found

  function generatedToUpdateItems(items: MenuItemInput[]): MenuUpdateItem[] {
    return items.map(item => ({
      type: "HTTP",
      title: item.title,
      url: item.url,
      ...(item.items?.length ? { items: generatedToUpdateItems(item.items) } : {}),
    }));
  }

  function existingToUpdateItems(items: ExistingMenuItem[]): MenuUpdateItem[] {
    return items.map(item => ({
      ...(item.id ? { id: item.id } : {}),
      title: item.title,
      ...(item.type ? { type: item.type } : {}),
      ...(item.url ? { url: item.url } : {}),
      ...(item.resourceId ? { resourceId: item.resourceId } : {}),
      ...(item.tags?.length ? { tags: item.tags } : {}),
      ...(item.items?.length ? { items: existingToUpdateItems(item.items) } : {}),
    }));
  }

  const generatedItems = generatedToUpdateItems(menuStructure);
  const existingTopLevel = existingToUpdateItems(menu.items ?? []);

  let foundNettbutikk = false;
  const mergedItems: MenuUpdateItem[] = existingTopLevel.map(item => {
    if (item.title.trim().toLowerCase() !== "nettbutikk") return item;
    foundNettbutikk = true;
    return {
      ...item,
      items: generatedItems,
    };
  });

  if (!foundNettbutikk) {
    mergedItems.push({
      title: "Nettbutikk",
      type: "HTTP",
      url: "/collections/all",
      items: generatedItems,
    });
  }

  // 2. Oppdater menyen med sammenslåtte items
  function toGQLInput(val: unknown, enumField = false): string {
    if (val === null || val === undefined) return "null";
    if (typeof val === "string") return enumField ? val : JSON.stringify(val);
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (Array.isArray(val)) return `[${val.map(v => toGQLInput(v)).join(", ")}]`;
    if (typeof val === "object") {
      const fields = Object.entries(val as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${toGQLInput(v, k === "type")}`).join(", ");
      return `{${fields}}`;
    }
    return String(val);
  }

  const itemsLiteral = toGQLInput(mergedItems);
  const updateMutation = `
    mutation {
      menuUpdate(id: ${JSON.stringify(menu.id)}, title: ${JSON.stringify(menu.title)}, items: ${itemsLiteral}) {
        menu {
          id
          title
          handle
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const updateData = await shopifyGraphQL(updateMutation, {});
  const { userErrors } = updateData.data?.menuUpdate ?? {};
  if (userErrors?.length) {
    throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
  }
  return { success: true, itemsCount: generatedItems.length };
}

// ── Credential helpers ────────────────────────────────────────────────────────

// Decode JWT payload without verification (server-side, acceptable)
function getUserIdFromJWT(authHeader: string): string | null {
  try {
    const token = authHeader.replace("Bearer ", "");
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

// Look up per-user Bokbasen credentials from user_settings, fall back to env vars.
// Shopify is server-wide and handled by _shared/shopify.ts.
async function getCredentials(userId: string | null): Promise<CredentialBundle> {
  if (userId) {
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const res = await fetch(
        `${supabaseUrl}/rest/v1/user_settings?user_id=eq.${userId}&select=bokbasen_client_id,bokbasen_client_secret`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      );
      const rows = await res.json();
      const settings = rows?.[0];
      if (settings?.bokbasen_client_id || settings?.bokbasen_client_secret) {
        return {
          bokbasen: {
            clientId: settings.bokbasen_client_id || Deno.env.get("BOKBASEN_CLIENT_ID")!,
            clientSecret: settings.bokbasen_client_secret || Deno.env.get("BOKBASEN_CLIENT_SECRET")!,
          },
        };
      }
    } catch { /* fall through to env vars */ }
  }
  // Fall back to global env vars (admin user or development)
  return {
    bokbasen: {
      clientId: Deno.env.get("BOKBASEN_CLIENT_ID")!,
      clientSecret: Deno.env.get("BOKBASEN_CLIENT_SECRET")!,
    },
  };
}

// ── Feed (Manual Collection) management ──────────────────────────────────────

const FEEDS_LIST_QUERY = `
  query FeedsList($first: Int!, $query: String!) {
    collections(first: $first, sortKey: UPDATED_AT, reverse: true, query: $query) {
      edges {
        node {
          id title handle sortOrder
          productsCount { count }
          image { url altText }
          products(first: 4) {
            edges {
              node {
                featuredImage { url }
              }
            }
          }
        }
      }
    }
  }
`;

const FEED_GET_QUERY = `
  query FeedGet($id: ID!, $first: Int!) {
    collection(id: $id) {
      id title handle sortOrder
      productsCount { count }
      image { url altText }
      products(first: $first) {
        edges {
          node {
            id title handle productType vendor status createdAt
            images(first: 1) { edges { node { url } } }
            variants(first: 1) { edges { node { id price } } }
          }
        }
      }
    }
  }
`;

const COLLECTION_DELETE_MUTATION = `
  mutation CollectionDelete($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors { field message }
    }
  }
`;

const COLLECTION_ADD_PRODUCTS_MUTATION = `
  mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id productsCount { count } }
      userErrors { field message }
    }
  }
`;

const COLLECTION_REMOVE_PRODUCTS_MUTATION = `
  mutation CollectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) {
      userErrors { field message }
    }
  }
`;

const COLLECTION_UPDATE_MUTATION = `
  mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id sortOrder }
      userErrors { field message }
    }
  }
`;

const COLLECTION_REORDER_MUTATION = `
  mutation CollectionReorder($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      userErrors { field message }
    }
  }
`;

async function feedsList() {
  const result = await shopifyGraphQL(FEEDS_LIST_QUERY, { first: 100, query: "collection_type:custom" });
  const edges = result.data?.collections?.edges ?? [];
  return edges
    .filter((e: any) => !e.node.handle?.startsWith('bkg-'))
    .map((e: any) => ({
      id: e.node.id,
      title: e.node.title,
      handle: e.node.handle,
      sortOrder: e.node.sortOrder,
      productsCount: e.node.productsCount?.count ?? 0,
      image: e.node.image?.url ?? null,
      productImages: (e.node.products?.edges ?? [])
        .map((pe: any) => pe.node.featuredImage?.url)
        .filter(Boolean) as string[],
    }));
}

async function feedGet(collectionId: string) {
  const result = await shopifyGraphQL(FEED_GET_QUERY, { id: collectionId, first: 250 });
  const col = result.data?.collection;
  if (!col) throw new Error("Collection not found");
  const products = (col.products?.edges ?? []).map((e: any) => ({
    id: e.node.id,
    title: e.node.title,
    handle: e.node.handle,
    author: e.node.productType ?? "",
    vendor: e.node.vendor ?? "",
    status: e.node.status,
    createdAt: e.node.createdAt ?? "",
    image: e.node.images?.edges?.[0]?.node?.url ?? null,
    price: e.node.variants?.edges?.[0]?.node?.price ?? "0.00",
  }));
  return {
    collection: {
      id: col.id,
      title: col.title,
      handle: col.handle,
      sortOrder: col.sortOrder,
      productsCount: col.productsCount?.count ?? 0,
      image: col.image?.url ?? null,
    },
    products,
  };
}

async function feedCreate(title: string) {
  const result = await shopifyGraphQL(COLLECTION_CREATE_MUTATION, {
    input: { title, collectionType: "MANUAL" },
  });
  const { collection, userErrors } = result.data?.collectionCreate ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
  return collection;
}

async function feedDelete(collectionId: string) {
  const result = await shopifyGraphQL(COLLECTION_DELETE_MUTATION, {
    input: { id: collectionId },
  });
  const { userErrors } = result.data?.collectionDelete ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
}

async function feedAddProducts(collectionId: string, productIds: string[]) {
  const result = await shopifyGraphQL(COLLECTION_ADD_PRODUCTS_MUTATION, {
    id: collectionId,
    productIds,
  });
  const { userErrors } = result.data?.collectionAddProducts ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
}

async function feedRemoveProducts(collectionId: string, productIds: string[]) {
  const result = await shopifyGraphQL(COLLECTION_REMOVE_PRODUCTS_MUTATION, {
    id: collectionId,
    productIds,
  });
  const { userErrors } = result.data?.collectionRemoveProducts ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
}

async function feedUpdate(collectionId: string, updates: { sortOrder?: string }) {
  const input: Record<string, unknown> = { id: collectionId };
  if (updates.sortOrder) input.sortOrder = updates.sortOrder;
  const result = await shopifyGraphQL(COLLECTION_UPDATE_MUTATION, { input });
  const { userErrors } = result.data?.collectionUpdate ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
}

async function feedReorderProducts(collectionId: string, moves: Array<{ id: string; newPosition: string }>) {
  const result = await shopifyGraphQL(COLLECTION_REORDER_MUTATION, {
    id: collectionId,
    moves,
  });
  const { userErrors } = result.data?.collectionReorderProducts ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
}

// ── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/shopify\/?/, "");
    const body = req.method !== "GET" ? await req.json().catch(() => ({})) : {};

    const userId = getUserIdFromJWT(req.headers.get("Authorization") ?? "");
    const { bokbasen } = await getCredentials(userId);

    // POST /shopify/test — verify the server's Shopify connection (Dev Dashboard app,
    // credentials from Supabase secrets). Returns shop name, domain and product count.
    if (path === "test" && req.method === "POST") {
      const result = await shopifyGraphQL(`{ shop { name myshopifyDomain } productsCount { count } }`, {});
      return new Response(JSON.stringify({
        success: true,
        shopName: result.data?.shop?.name,
        shopDomain: result.data?.shop?.myshopifyDomain,
        productsCount: result.data?.productsCount?.count ?? 0,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/push — push one book
    if (path === "push" && req.method === "POST") {
      const book: BookMetadata = body.book;
      if (!book?.isbn) return new Response(JSON.stringify({ error: "Missing book data" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const result = await pushOneBook(book);
      return new Response(JSON.stringify({ success: true, ...result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/push-bulk — push multiple books
    if (path === "push-bulk" && req.method === "POST") {
      const books: BookMetadata[] = body.books || [];
      const results = [];
      for (const book of books) {
        try {
          const result = await pushOneBook(book);
          results.push({ isbn: book.isbn, success: true, shopifyId: result.shopifyId, handle: result.handle });
        } catch (e) {
          results.push({ isbn: book.isbn, success: false, error: String(e) });
        }
        await new Promise(r => setTimeout(r, 500));
      }
      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /shopify/analyze-collections — les-bare analyse: tagger, collections, plassering
    if (path === "analyze-collections" && req.method === "GET") {
      const result = await analyzeCollections();
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/sync-collections — tag all Shopify products + create Smart Collections
    if (path === "sync-collections" && req.method === "POST") {
      const result = await fullSyncCollections(bokbasen);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /shopify/count — hent totalt antall produkter med én query
    if (path === "count" && req.method === "GET") {
      const result = await shopifyGraphQL(`{ productsCount { count } }`, {});
      const count: number = result.data?.productsCount?.count ?? 0;
      return new Response(JSON.stringify({ count }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/catalog — hent én side av Shopify-katalogen
    if (path === "catalog" && req.method === "POST") {
      const after: string | undefined = body.after || undefined;
      const first = Math.min(body.first || 50, 250);
      const sortKey: string = body.sortKey || "CREATED_AT";
      const reverse: boolean = body.reverse !== undefined ? Boolean(body.reverse) : true;
      const variables: Record<string, unknown> = { first, sortKey, reverse };
      if (after) variables.after = after;

      const result = await shopifyGraphQL(CATALOG_PRODUCTS_QUERY, variables);
      const edges: Array<{ cursor: string; node: Record<string, unknown> }> =
        result.data?.products?.edges ?? [];
      const pageInfo: { hasNextPage: boolean; endCursor: string } =
        result.data?.products?.pageInfo ?? {};

      const products = edges.map(({ node }) => {
        const variant = (node.variants as { edges: { node: Record<string, unknown> }[] })?.edges?.[0]?.node ?? {};
        return {
          id: node.id as string,
          handle: node.handle as string,
          title: node.title as string,
          productType: (node.productType as string) ?? "",
          vendor: (node.vendor as string) ?? "",
          status: node.status as string,
          descriptionHtml: (node.descriptionHtml as string) ?? "",
          tags: (node.tags as string[]) ?? [],
          createdAt: (node.createdAt as string) ?? "",
          price: (variant.price as string) ?? "",
          compareAtPrice: (variant.compareAtPrice as string | null) ?? null,
          sku: (variant.sku as string) ?? "",
          barcode: (variant.barcode as string) ?? "",
          variantId: (variant.id as string) ?? "",
          imageUrl: ((node.images as { edges: { node: { url: string } }[] })?.edges?.[0]?.node?.url) ?? "",
          seoTitle: ((node.seoTitleMf as { value: string } | null)?.value) ?? "",
          seoDescription: ((node.seoDescMf as { value: string } | null)?.value) ?? "",
          collections: ((node.collections as { edges: { node: { title: string } }[] })?.edges ?? []).map(e => e.node.title),
        };
      });

      return new Response(JSON.stringify({ products, pageInfo }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/catalog/search — søk i Shopify-katalogen (tittel, forfatter, ISBN)
    if (path === "catalog/search" && req.method === "POST") {
      const searchQuery: string = (body.query || "").trim();
      if (!searchQuery) {
        return new Response(JSON.stringify({ error: "Mangler søkeord (query)" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Build Shopify search query — search across title, product_type (author), vendor, and handle (ISBN)
      const escaped = searchQuery.replace(/"/g, '\\"');
      const shopifyQuery = `title:*${escaped}* OR product_type:*${escaped}* OR vendor:*${escaped}* OR handle:*${escaped}*`;
      const after: string | undefined = body.after || undefined;
      const first = Math.min(body.first || 50, 100);

      const SEARCH_QUERY = `
        query SearchProducts($first: Int!, $after: String, $query: String!) {
          products(first: $first, after: $after, query: $query) {
            edges {
              cursor
              node {
                id handle title productType vendor status
                descriptionHtml tags createdAt
                images(first: 1) { edges { node { url altText } } }
                variants(first: 1) {
                  edges { node { id price compareAtPrice sku barcode inventoryPolicy } }
                }
                seoTitleMf: metafield(namespace: "global", key: "title_tag") { value }
                seoDescMf: metafield(namespace: "global", key: "description_tag") { value }
                collections(first: 10) { edges { node { title } } }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `;

      const variables: Record<string, unknown> = { first, query: shopifyQuery };
      if (after) variables.after = after;

      const result = await shopifyGraphQL(SEARCH_QUERY, variables);
      const edges: Array<{ cursor: string; node: Record<string, unknown> }> =
        result.data?.products?.edges ?? [];
      const pageInfo: { hasNextPage: boolean; endCursor: string } =
        result.data?.products?.pageInfo ?? {};

      const products = edges.map(({ node }) => {
        const variant = (node.variants as { edges: { node: Record<string, unknown> }[] })?.edges?.[0]?.node ?? {};
        return {
          id: node.id as string,
          handle: node.handle as string,
          title: node.title as string,
          productType: (node.productType as string) ?? "",
          vendor: (node.vendor as string) ?? "",
          status: node.status as string,
          descriptionHtml: (node.descriptionHtml as string) ?? "",
          tags: (node.tags as string[]) ?? [],
          createdAt: (node.createdAt as string) ?? "",
          price: (variant.price as string) ?? "",
          compareAtPrice: (variant.compareAtPrice as string | null) ?? null,
          sku: (variant.sku as string) ?? "",
          barcode: (variant.barcode as string) ?? "",
          variantId: (variant.id as string) ?? "",
          imageUrl: ((node.images as { edges: { node: { url: string } }[] })?.edges?.[0]?.node?.url) ?? "",
          seoTitle: ((node.seoTitleMf as { value: string } | null)?.value) ?? "",
          seoDescription: ((node.seoDescMf as { value: string } | null)?.value) ?? "",
          collections: ((node.collections as { edges: { node: { title: string } }[] })?.edges ?? []).map(e => e.node.title),
        };
      });

      return new Response(JSON.stringify({ products, pageInfo, query: searchQuery }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/catalog/update — push endringer (tittel, forfatter, pris) for valgte produkter
    if (path === "catalog/update" && req.method === "POST") {
      interface CatalogChange {
        productId: string;
        title?: string;
        productType?: string;
        vendor?: string;
        variantId?: string;
        price?: string;
      }
      const changes: CatalogChange[] = body.changes || [];
      const results: Array<{ productId: string; success: boolean; error?: string }> = [];

      for (const change of changes) {
        try {
          const { productId, title, productType, vendor, variantId, price } = change;

          // Update title / productType / vendor if provided
          if (title !== undefined || productType !== undefined || vendor !== undefined) {
            const input: Record<string, unknown> = { id: productId };
            if (title !== undefined) input.title = title;
            if (productType !== undefined) input.productType = productType;
            if (vendor !== undefined) input.vendor = vendor;
            const updateResult = await shopifyGraphQL(PRODUCT_UPDATE_MUTATION, { input });
            const { userErrors } = updateResult.data?.productUpdate ?? {};
            if (userErrors?.length) throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
          }

          // Update price if provided
          if (price !== undefined && variantId) {
            const varResult = await shopifyGraphQL(VARIANT_UPDATE_MUTATION, {
              productId,
              variants: [{ id: variantId, price }],
            });
            const { userErrors } = varResult.data?.productVariantsBulkUpdate ?? {};
            if (userErrors?.length) throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
          }

          results.push({ productId, success: true });
        } catch (e) {
          results.push({ productId: change.productId, success: false, error: String(e) });
        }

        await new Promise(r => setTimeout(r, 250));
      }

      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/export-csv
    if (path === "export-csv" && req.method === "POST") {
      const books: BookMetadata[] = body.books || [];
      if (!books.length) return new Response(JSON.stringify({ error: "No books provided" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const csv = booksToShopifyCSV(books);
      return new Response(csv, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="shopify-products-${Date.now()}.csv"`,
        },
      });
    }

    // ── Feed management endpoints ──────────────────────────────────────────────

    // GET /shopify/feeds/list — list all manual collections
    if (path === "feeds/list" && req.method === "GET") {
      const collections = await feedsList();
      return new Response(JSON.stringify(collections), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/get — get collection with products
    if (path === "feeds/get" && req.method === "POST") {
      const { collectionId } = body;
      if (!collectionId) return new Response(JSON.stringify({ error: "collectionId er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const result = await feedGet(collectionId);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/create — create manual collection
    if (path === "feeds/create" && req.method === "POST") {
      const { title } = body;
      if (!title) return new Response(JSON.stringify({ error: "title er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const collection = await feedCreate(title);
      return new Response(JSON.stringify(collection), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/delete — delete collection
    if (path === "feeds/delete" && req.method === "POST") {
      const { collectionId } = body;
      if (!collectionId) return new Response(JSON.stringify({ error: "collectionId er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await feedDelete(collectionId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/add-products — add products to collection
    if (path === "feeds/add-products" && req.method === "POST") {
      const { collectionId, productIds } = body;
      if (!collectionId || !productIds?.length) return new Response(JSON.stringify({ error: "collectionId og productIds er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await feedAddProducts(collectionId, productIds);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/remove-products — remove products from collection
    if (path === "feeds/remove-products" && req.method === "POST") {
      const { collectionId, productIds } = body;
      if (!collectionId || !productIds?.length) return new Response(JSON.stringify({ error: "collectionId og productIds er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await feedRemoveProducts(collectionId, productIds);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/update — update collection (e.g. sortOrder)
    if (path === "feeds/update" && req.method === "POST") {
      const { collectionId, sortOrder } = body;
      if (!collectionId) return new Response(JSON.stringify({ error: "collectionId er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await feedUpdate(collectionId, { sortOrder });
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/reorder — reorder products in collection
    if (path === "feeds/reorder" && req.method === "POST") {
      const { collectionId, moves } = body;
      if (!collectionId || !moves?.length) return new Response(JSON.stringify({ error: "collectionId og moves er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await feedReorderProducts(collectionId, moves);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/build-menu — bygg megameny i Shopify Navigation
    if (path === "build-menu" && req.method === "POST") {
      const menuHandle: string = body.menuHandle || "kategorier";
      const result = await buildMegaMenu(menuHandle);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
