// node --test scripts/*.test.mjs
// Prisvalg fra ONIX (supabase/functions/_shared/price.ts). Utdragene følger
// strukturen i ONIX 3.1 fra Bokbasen (navnerom fjernet).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickImportPrice, pickPriceUpdatePrice } from "../supabase/functions/_shared/price.ts";

const price = (type, amount) =>
  `<Price>${type ? `<PriceType>${type}</PriceType>` : ""}<PriceAmount>${amount}</PriceAmount><Tax><TaxType>01</TaxType><TaxRatePercent>0</TaxRatePercent></Tax><CurrencyCode>NOK</CurrencyCode></Price>`;
const onix = (...prices) =>
  `<ONIXMessage release="3.1"><Product><ProductSupply><SupplyDetail><ProductAvailability>21</ProductAvailability>${prices.join("")}</SupplyDetail></ProductSupply></Product></ONIXMessage>`;

test("bare 01", () => {
  const xml = onix(price("01", "349"));
  assert.equal(pickImportPrice(xml), 349);
  assert.equal(pickPriceUpdatePrice(xml), 349);
});

test("både 02 og 04 med ulike beløp: import tar 02, prisjobben 04", () => {
  const xml = onix(price("02", "399"), price("04", "449"));
  assert.equal(pickImportPrice(xml), 399);
  assert.equal(pickPriceUpdatePrice(xml), 449);
  // Rekkefølgen i XML endrer ikke prisjobbens valg
  assert.equal(pickPriceUpdatePrice(onix(price("04", "449"), price("02", "399"))), 449);
});

test("bare 03: import faller tilbake til første beløp", () => {
  const xml = onix(price("03", "299"));
  assert.equal(pickImportPrice(xml), 299);
  assert.equal(pickPriceUpdatePrice(xml), 299);
});

test("ingen type", () => {
  const xml = onix(price(null, "199"));
  assert.equal(pickImportPrice(xml), 199);
  assert.equal(pickPriceUpdatePrice(xml), 199);
});

test("beløp 0 velges av begge; prisjobben avviser det selv (<= 0)", () => {
  const xml = onix(price("04", "0"));
  assert.equal(pickImportPrice(xml), 0);
  assert.equal(pickPriceUpdatePrice(xml), 0);
});

test("ingen pris gir null", () => {
  assert.equal(pickImportPrice(onix()), null);
  assert.equal(pickPriceUpdatePrice(onix()), null);
});
