// node --test scripts/*.test.mjs
// Prisvalg fra ONIX (supabase/functions/_shared/price.ts). Utdragene følger
// strukturen i ONIX 3.1 fra Bokbasen (navnerom fjernet).
//
// Bokadmin 2.0 har én prisregel: importen (pickValidPrice) og prisjobben
// (pickPriceUpdatePrice + avvisning av 0 eller lavere) skal gi samme pris.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPriceUpdatePrice, pickValidPrice } from "../supabase/functions/_shared/price.ts";

const price = (type, amount) =>
  `<Price>${type ? `<PriceType>${type}</PriceType>` : ""}<PriceAmount>${amount}</PriceAmount><Tax><TaxType>01</TaxType><TaxRatePercent>0</TaxRatePercent></Tax><CurrencyCode>NOK</CurrencyCode></Price>`;
const onix = (...prices) =>
  `<ONIXMessage release="3.1"><Product><ProductSupply><SupplyDetail><ProductAvailability>21</ProductAvailability>${prices.join("")}</SupplyDetail></ProductSupply></Product></ONIXMessage>`;

// Prisen prisjobben ender på: valgt pris, men 0 eller lavere avvises (ingen endring)
const priceJob = (xml) => {
  const p = pickPriceUpdatePrice(xml);
  return p !== null && p > 0 ? p : null;
};

const cases = [
  ["bare 01", onix(price("01", "349")), 349],
  ["02 og 04 med ulike beløp: fastprisen (04) vinner", onix(price("02", "399"), price("04", "449")), 449],
  ["04 før 02 i XML: fortsatt 04", onix(price("04", "449"), price("02", "399")), 449],
  ["bare 03", onix(price("03", "299")), 299],
  ["01 og 03: 03 vinner", onix(price("01", "349"), price("03", "329")), 329],
  ["ingen type", onix(price(null, "199")), 199],
  ["beløp 0 godtas ikke", onix(price("04", "0")), null],
  ["negativt beløp godtas ikke", onix(price("04", "-10")), null],
  ["ingen pris", onix(), null],
];

for (const [name, xml, expected] of cases) {
  test(name, () => {
    assert.equal(pickValidPrice(xml), expected, "import");
    assert.equal(priceJob(xml), expected, "prisjobb");
  });
}

test("pickPriceUpdatePrice returnerer 0 slik at prisjobben kan logge avvisningen", () => {
  assert.equal(pickPriceUpdatePrice(onix(price("04", "0"))), 0);
});
