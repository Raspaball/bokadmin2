#!/usr/bin/env node
// scripts/tilgjengelighet-definisjoner.mjs
// Lager metafeltdefinisjonene for tilgjengelighet (pakke C del 1), festet i
// admin og lesbare i Storefront:
//   bok.tilgjengelighet  single_line_text_field, choices = verdiene i
//                        supabase/functions/_shared/availability.ts
//   bok.utgivelsesdato   date
// Settes av tilgjengelighetssjekken og push.
//
// KJØRING (fra prosjektmappa):
//   node scripts/tilgjengelighet-definisjoner.mjs            # vis status (endrer ingenting)
//   node scripts/tilgjengelighet-definisjoner.mjs --create   # lag det som mangler
//
// Kjører bare mot Testbutikk (se scripts/lib/clients.mjs).

import { shopifyGql, testShop, fail } from "./lib/clients.mjs";
import { TILGJENGELIGHET_VALUES } from "../supabase/functions/_shared/availability.ts";

const CREATE = process.argv.includes("--create");
const SHOP = testShop();

const DEFINITIONS = [
  {
    name: "Tilgjengelighet",
    namespace: "bok",
    key: "tilgjengelighet",
    type: "single_line_text_field",
    description: "Fra ONIX-tilgjengelighetskoden (List 65), satt av Bokadmin: tilgjengelig, kommer, midlertidig_utsolgt, utgatt eller ikke_tilgjengelig.",
    validations: [{ name: "choices", value: JSON.stringify(TILGJENGELIGHET_VALUES) }],
  },
  {
    name: "Utgivelsesdato",
    namespace: "bok",
    key: "utgivelsesdato",
    type: "date",
    description: "Utgivelsesdato fra ONIX, satt av Bokadmin.",
    validations: [],
  },
];

const DEFINITION_QUERY = `
query bokDefinition($key: String!) {
  metafieldDefinitions(first: 5, ownerType: PRODUCT, namespace: "bok", key: $key) {
    nodes { id name namespace key pinnedPosition metafieldsCount type { name } access { storefront } validations { name value } }
  }
}`;

const DEFINITION_CREATE = `
mutation bokDefinitionCreate($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id name }
    userErrors { field message code }
  }
}`;

const show = (d) => console.log(`  ${d.namespace}.${d.key} (${d.type.name}) «${d.name}», festet: ${d.pinnedPosition != null}, storefront: ${d.access.storefront}, verdier: ${d.metafieldsCount}${d.validations.length ? `, validering: ${d.validations.map((v) => `${v.name}=${v.value}`).join("; ")}` : ""}`);
const find = async (key) => (await shopifyGql(DEFINITION_QUERY, { key })).metafieldDefinitions.nodes[0];

console.log(`Butikk: ${SHOP}`);
for (const def of DEFINITIONS) {
  const existing = await find(def.key);
  if (existing) {
    console.log("Finnes:");
    show(existing);
    if (existing.type.name !== def.type) fail(`${def.namespace}.${def.key} har typen ${existing.type.name}, ikke ${def.type}. Rett den for hånd.`);
    continue;
  }
  console.log(`Mangler: ${def.namespace}.${def.key}`);
  if (!CREATE) continue;
  const res = await shopifyGql(DEFINITION_CREATE, {
    definition: { ...def, ownerType: "PRODUCT", pin: true, access: { storefront: "PUBLIC_READ" } },
  });
  const errs = res.metafieldDefinitionCreate.userErrors;
  if (errs.length) fail(errs.map((e) => `${e.code}: ${e.message}`).join("; "));
  console.log("Laget:");
  show(await find(def.key));
}
if (!CREATE) console.log("\nKjør med --create for å lage det som mangler.");
