#!/usr/bin/env node
// scripts/lag-metafelt-definisjoner.mjs  (pakke I del B)
// Lager ALLE metafeltdefinisjonene Bokadmin trenger, med samme innstillinger som i
// Testbutikk (festet rekkefølge, storefront-tilgang, filter og unikhet):
//   bok.isbn (type id, unik) · bok.forfatter · bok.format · bok.sider · bok.utgivelsesaar ·
//   bok.spraak · bok.serie · bok.alder · bok.thema · bok.tilgjengelighet · bok.utgivelsesdato ·
//   bok.bokgruppe · bok.egen_pris · bok.egen_tilgjengelighet · bokadmin.seo_auto (json)
// bok.notat og bok.notat_av (Bokhandlerens notat, metaobjekt) er butikkens egne og lages ikke her.
//
// Lager bare det som mangler, endrer eller sletter aldri en eksisterende definisjon.
// Har en eksisterende definisjon en annen type (særlig bok.isbn som tekst i live), stopper
// skriptet for den og peker på scripts/isbn-definition.mjs (egen prosedyre med sikkerhetskopi).
//
// KJØRING (fra prosjektmappa):
//   node scripts/lag-metafelt-definisjoner.mjs                  # Testbutikk: vis status
//   node scripts/lag-metafelt-definisjoner.mjs --create         # Testbutikk: lag det som mangler
//   node scripts/lag-metafelt-definisjoner.mjs --prove                                           # Testbutikk: lag alle i navnerommet «pakkeitest», les tilbake, slett (rører ikke de ekte)
//   node scripts/lag-metafelt-definisjoner.mjs --live --bekreft-butikk <hele domenet>             # live: status
//   node scripts/lag-metafelt-definisjoner.mjs --live --bekreft-butikk <hele domenet> --create    # live: lag
// Live trenger LIVE_SHOPIFY_SHOP_DOMAIN og LIVE_SHOPIFY_ACCESS_TOKEN (eller _CLIENT_ID/_CLIENT_SECRET)
// i scripts/.env.local. Den eneste skrivingen er metafieldDefinitionCreate.

import { shopifyGql, testShop, enableLive, fail } from "./lib/clients.mjs";
import { TILGJENGELIGHET_VALUES } from "../supabase/functions/_shared/availability.ts";

const PROVE = process.argv.includes("--prove");
const CREATE = process.argv.includes("--create");
if (PROVE && process.argv.includes("--live")) fail("--prove kjøres bare mot Testbutikk.");
if (process.argv.includes("--live")) enableLive({ allowedMutations: ["metafieldDefinitionCreate"] });
const SHOP = testShop();

// Rekkefølgen er festerekkefølgen i produktsiden (som i Testbutikk).
// storefront: PUBLIC_READ = lesbar i temaet; NONE = bare admin.
const D = (key, name, type, o = {}) => ({
  namespace: "bok", key, name, type,
  description: o.description ?? null,
  pin: o.pin ?? true,
  storefront: o.storefront ?? "PUBLIC_READ",
  filterable: o.filterable ?? false,       // adminFilterable
  collectionRule: o.collectionRule ?? false, // smartCollectionCondition
  unique: o.unique ?? false,
  validations: o.validations ?? [],
});

const DEFINITIONS = [
  D("forfatter", "Forfatter", "list.single_line_text_field", { description: "Forfatter(e), fornavn etternavn. Erstatter productType.", filterable: true }),
  D("format", "Format", "single_line_text_field", { description: "Innbundet, heftet, pocket, e-bok, lydbok osv.", filterable: true, collectionRule: true }),
  D("sider", "Sider", "number_integer"),
  D("utgivelsesaar", "Utgivelsesår", "number_integer"),
  D("spraak", "Språk", "single_line_text_field", { filterable: true, collectionRule: true }),
  D("serie", "Serie", "single_line_text_field", { filterable: true }),
  D("alder", "Alder", "single_line_text_field", { description: "Aldersgruppe for barne- og ungdomsbøker.", filterable: true, collectionRule: true }),
  D("thema", "Thema-koder", "list.single_line_text_field", { description: "Thema-emnekoder fra ONIX.", pin: false }),
  D("isbn", "ISBN", "id", { description: "ISBN-13. Unik. Brukes til oppslag fra Bokadmin.", filterable: true, unique: true }),
  D("egen_pris", "Egen pris (Bokadmin endrer ikke prisen)", "boolean", { storefront: "NONE", description: "Kryss av når butikken har satt prisen selv. Prisjobben og push fra Bokadmin lar da prisen stå." }),
  D("tilgjengelighet", "Tilgjengelighet", "single_line_text_field", { description: "Fra ONIX-tilgjengelighetskoden (List 65), satt av Bokadmin: tilgjengelig, kommer, midlertidig_utsolgt, utgatt eller ikke_tilgjengelig.", validations: [{ name: "choices", value: JSON.stringify(TILGJENGELIGHET_VALUES) }] }),
  D("utgivelsesdato", "Utgivelsesdato", "date", { description: "Utgivelsesdato fra ONIX, satt av Bokadmin." }),
  D("egen_tilgjengelighet", "Egen tilgjengelighet (Bokadmin endrer ikke status)", "boolean", { storefront: "NONE", description: "Kryss av når butikken styrer status og salg selv (f.eks. bøker fra andre leverandører). Tilgjengelighetssjekken og push fra Bokadmin lar da status, lagerinnstilling og bok.tilgjengelighet stå." }),
  D("bokgruppe", "Bokgruppe", "single_line_text_field", { storefront: "NONE", description: "Bokgruppekoden fra Bokbasen (ONIX skjema 37), f.eks. 417. Settes av Bokadmin, samme kode som bkg-taggene." }),
  { namespace: "bokadmin", key: "seo_auto", name: "SEO satt av Bokadmin", type: "json", pin: false, storefront: "NONE", filterable: false, collectionRule: false, unique: false, validations: [],
    description: "Hva Bokadmin selv skrev i SEO-tittel og -beskrivelse, så manuelle endringer kjennes igjen og aldri overskrives." },
];

const QUERY = `
query def($ns: String!, $key: String!) {
  metafieldDefinitions(first: 3, ownerType: PRODUCT, namespace: $ns, key: $key) {
    nodes { id name namespace key pinnedPosition metafieldsCount validationStatus type { name }
      access { storefront } capabilities { uniqueValues { enabled } } }
  }
}`;
const MUTATION = `
mutation defCreate($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id name }
    userErrors { field message code }
  }
}`;

function definitionInput(d) {
  const capabilities = {};
  if (d.unique) capabilities.uniqueValues = { enabled: true };
  if (d.filterable) capabilities.adminFilterable = { enabled: true };
  if (d.collectionRule) capabilities.smartCollectionCondition = { enabled: true };
  return {
    name: d.name, namespace: d.namespace, key: d.key, type: d.type, ownerType: "PRODUCT",
    ...(d.description ? { description: d.description } : {}),
    ...(d.validations.length ? { validations: d.validations } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    access: { storefront: d.storefront },
    pin: d.pin,
  };
}

if (PROVE) {
  // Lager hver definisjon med nøyaktig samme input i navnerommet pakkeitest, sammenligner med det
  // Shopify lagret og sletter dem igjen. Rører ikke bok.* eller bokadmin.*.
  const READ = `query($id: ID!) { node(id: $id) { ... on MetafieldDefinition { type { name } pinnedPosition access { storefront } validations { name value }
    capabilities { adminFilterable { enabled } smartCollectionCondition { enabled } uniqueValues { enabled } } } } }`;
  const DELETE = `mutation($id: ID!) { metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: true) { deletedDefinitionId userErrors { message } } }`;
  const enabledTo = (c, k) => !!c?.[k]?.enabled;
  let bad = 0;
  for (const d of DEFINITIONS) {
    const test = { ...d, namespace: "pakkeitest" };
    const res = (await shopifyGql(MUTATION, { definition: definitionInput(test) })).metafieldDefinitionCreate;
    if (res.userErrors.length) { bad++; console.log(`FEIL  ${d.namespace}.${d.key}: ${res.userErrors.map((e) => e.message).join("; ")}`); continue; }
    const got = (await shopifyGql(READ, { id: res.createdDefinition.id })).node;
    const diffs = [];
    if (got.type.name !== d.type) diffs.push(`type ${got.type.name}`);
    if (got.access.storefront !== d.storefront) diffs.push(`storefront ${got.access.storefront}`);
    if ((got.pinnedPosition != null) !== d.pin) diffs.push(`festet ${got.pinnedPosition}`);
    if (enabledTo(got.capabilities, "adminFilterable") !== d.filterable) diffs.push("filter");
    if (enabledTo(got.capabilities, "smartCollectionCondition") !== d.collectionRule) diffs.push("samlingsregel");
    if (enabledTo(got.capabilities, "uniqueValues") !== d.unique) diffs.push("unik");
    if (d.validations.length && JSON.stringify(got.validations.map((v) => [v.name, v.value])) !== JSON.stringify(d.validations.map((v) => [v.name, v.value]))) diffs.push("validering");
    if (diffs.length) bad++;
    console.log(`${diffs.length ? "AVVIK" : "ok   "} ${d.namespace}.${d.key} (${d.type})${diffs.length ? ": " + diffs.join(", ") : ""}`);
    const del = (await shopifyGql(DELETE, { id: res.createdDefinition.id })).metafieldDefinitionDelete;
    if (del.userErrors.length) console.log(`  kunne ikke slette prøvedefinisjonen: ${del.userErrors[0].message}`);
  }
  console.log(`
Prøve ferdig: ${DEFINITIONS.length - bad} av ${DEFINITIONS.length} ok.`);
  process.exit(bad ? 1 : 0);
} else {
  console.log(`Butikk: ${SHOP}${CREATE ? "  (--create: lager det som mangler)" : "  (bare status)"}\n`);
  let missing = 0, created = 0, wrong = 0;
  for (const d of DEFINITIONS) {
    const id = `${d.namespace}.${d.key}`;
    const found = (await shopifyGql(QUERY, { ns: d.namespace, key: d.key })).metafieldDefinitions.nodes[0];
    if (found) {
      const ok = found.type.name === d.type;
      console.log(`${ok ? "finnes " : "FEIL TYPE"} ${id} (${found.type.name})${ok ? "" : ` skulle vært ${d.type}${d.key === "isbn" ? " — bruk scripts/isbn-definition.mjs" : ""}`}, verdier: ${found.metafieldsCount}`);
      if (!ok) wrong++;
      continue;
    }
    missing++;
    if (!CREATE) { console.log(`mangler ${id} (${d.type})`); continue; }
    const res = (await shopifyGql(MUTATION, { definition: definitionInput(d) })).metafieldDefinitionCreate;
    if (res.userErrors.length) fail(`${id}: ${res.userErrors.map((e) => `${e.code}: ${e.message}`).join("; ")}`);
    created++;
    console.log(`laget   ${id} (${d.type})`);
  }
  console.log(`\n${DEFINITIONS.length} definisjoner: ${missing - created} mangler, ${created} laget, ${wrong} med feil type.`);
  if (wrong) process.exit(2);
  if (missing && !CREATE) console.log("Kjør med --create for å lage det som mangler.");
}
