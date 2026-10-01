#!/usr/bin/env node
// scripts/egen-pris-definition.mjs
// Lager metafeltdefinisjonen bok.egen_pris (boolean, «Egen pris (Bokadmin endrer
// ikke prisen)»), festet slik at feltet vises på produktsiden i Shopify admin.
// Når feltet er true, endrer prisjobben, push og godkjenning ikke prisen
// (se supabase/functions/_shared/price-lock.ts).
//
// KJØRING (fra prosjektmappa):
//   node scripts/egen-pris-definition.mjs            # vis status (endrer ingenting)
//   node scripts/egen-pris-definition.mjs --create   # lag definisjonen hvis den mangler
//
// Kjører bare mot Testbutikk (se scripts/lib/clients.mjs).

import { shopifyGql, testShop, fail } from "./lib/clients.mjs";

const CREATE = process.argv.includes("--create");
const SHOP = testShop();

const DEFINITION_QUERY = `
query bokEgenPrisDefinition {
  metafieldDefinitions(first: 5, ownerType: PRODUCT, namespace: "bok", key: "egen_pris") {
    nodes { id name namespace key description pinnedPosition metafieldsCount type { name } }
  }
}`;

const DEFINITION_CREATE = `
mutation bokEgenPrisCreate($definition: MetafieldDefinitionInput!) {
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
  if (existing.type.name !== "boolean") fail("Definisjonen har en annen type enn boolean. Rett den for hånd.");
  process.exit(0);
}
console.log("Definisjonen bok.egen_pris finnes ikke.");
if (!CREATE) { console.log("Kjør med --create for å lage den."); process.exit(0); }

const res = await shopifyGql(DEFINITION_CREATE, {
  definition: {
    name: "Egen pris (Bokadmin endrer ikke prisen)",
    namespace: "bok",
    key: "egen_pris",
    type: "boolean",
    ownerType: "PRODUCT",
    description: "Kryss av når butikken har satt prisen selv. Prisjobben og push fra Bokadmin lar da prisen stå.",
    pin: true,
  },
});
const errs = res.metafieldDefinitionCreate.userErrors;
if (errs.length) fail(errs.map((e) => `${e.code}: ${e.message}`).join("; "));
const created = (await shopifyGql(DEFINITION_QUERY)).metafieldDefinitions.nodes[0];
console.log("Laget:");
show(created);
