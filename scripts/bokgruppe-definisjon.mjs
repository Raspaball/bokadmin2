#!/usr/bin/env node
// scripts/bokgruppe-definisjon.mjs
// Lager metafeltdefinisjonen bok.bokgruppe (enkel tekstlinje, «Bokgruppe»), festet
// slik at feltet vises på produktsiden i Shopify admin. Verdien er bokgruppekoden
// (f.eks. 417), den samme som bkg-taggene. Settes av push, «Oppdater eksisterende
// bøker» og sjangersynken (pakke F del 2.4), slik at samlingene senere kan bytte
// regel fra tagg til metafelt. Se supabase/functions/_shared/bokgruppe.ts.
//
// KJØRING (fra prosjektmappa):
//   node scripts/bokgruppe-definisjon.mjs            # vis status (endrer ingenting)
//   node scripts/bokgruppe-definisjon.mjs --create   # lag definisjonen hvis den mangler
//
// Kjører bare mot Testbutikk (se scripts/lib/clients.mjs).

import { shopifyGql, testShop, fail } from "./lib/clients.mjs";

const CREATE = process.argv.includes("--create");
const SHOP = testShop();

const DEFINITION_QUERY = `
query bokBokgruppeDefinition {
  metafieldDefinitions(first: 5, ownerType: PRODUCT, namespace: "bok", key: "bokgruppe") {
    nodes { id name namespace key description pinnedPosition metafieldsCount type { name } }
  }
}`;

const DEFINITION_CREATE = `
mutation bokBokgruppeCreate($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id name pinnedPosition type { name } }
    userErrors { field message code }
  }
}`;

const show = (d) => console.log(`  ${d.namespace}.${d.key} (${d.type.name}) «${d.name}», festet: ${d.pinnedPosition != null}, verdier: ${d.metafieldsCount}`);

const existing = (await shopifyGql(DEFINITION_QUERY)).metafieldDefinitions.nodes[0];
console.log(`Butikk: ${SHOP}`);
if (existing) {
  console.log("Definisjonen finnes:");
  show(existing);
  if (existing.type.name !== "single_line_text_field") fail("Definisjonen har en annen type enn single_line_text_field. Rett den for hånd.");
  process.exit(0);
}
console.log("Definisjonen bok.bokgruppe finnes ikke.");
if (!CREATE) { console.log("Kjør med --create for å lage den."); process.exit(0); }

const res = await shopifyGql(DEFINITION_CREATE, {
  definition: {
    name: "Bokgruppe",
    namespace: "bok",
    key: "bokgruppe",
    type: "single_line_text_field",
    ownerType: "PRODUCT",
    description: "Bokgruppekoden fra Bokbasen (ONIX skjema 37), f.eks. 417. Settes av Bokadmin, samme kode som bkg-taggene.",
    pin: true,
  },
});
const errs = res.metafieldDefinitionCreate.userErrors;
if (errs.length) fail(errs.map((e) => `${e.code}: ${e.message}`).join("; "));
const created = (await shopifyGql(DEFINITION_QUERY)).metafieldDefinitions.nodes[0];
console.log("Laget:");
show(created);
