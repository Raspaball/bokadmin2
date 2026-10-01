// node --test scripts/*.test.mjs
// Prisvalg fra ONIX (supabase/functions/_shared/price.ts).
// ONIX 3-utdragene følger strukturen i ONIX 3.1 fra Bokbasen; ONIX 2.1 har
// PriceEffectiveFrom/Until og DefaultCurrencyCode i headeren.
//
// Bokadmin 2.0 har én prisregel: importen (pickValidPrice) og prisjobben
// (pickPriceUpdatePrice + avvisning av 0 eller lavere) skal gi samme pris.
import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePrice, osloToday, pickPriceUpdatePrice, pickValidPrice } from "../supabase/functions/_shared/price.ts";

const TODAY = "20261001";
const YESTERDAY = "20260930";
const TOMORROW = "20261002";

// ── ONIX 3 ──────────────────────────────────────────────────────────────────
const p3 = (type, amount, { currency = "NOK", from, until, countries } = {}) =>
  `<Price>${type ? `<PriceType>${type}</PriceType>` : ""}<PriceAmount>${amount}</PriceAmount>` +
  (countries ? `<Territory><CountriesIncluded>${countries}</CountriesIncluded></Territory>` : "") +
  (currency ? `<CurrencyCode>${currency}</CurrencyCode>` : "") +
  (from ? `<PriceDate><PriceDateRole>14</PriceDateRole><Date dateformat="00">${from}</Date></PriceDate>` : "") +
  (until ? `<PriceDate><PriceDateRole>15</PriceDateRole><Date dateformat="00">${until}</Date></PriceDate>` : "") +
  `</Price>`;
const onix3 = (prices, market = "") =>
  `<ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference" release="3.1"><Header><SenderName>Bokbasen AS</SenderName></Header><Product>` +
  `<ProductSupply>${market ? `<Market><Territory><CountriesIncluded>${market}</CountriesIncluded></Territory></Market>` : ""}` +
  `<SupplyDetail><ProductAvailability>21</ProductAvailability>${prices.join("")}</SupplyDetail></ProductSupply></Product></ONIXMessage>`;

// ── ONIX 2.1 ────────────────────────────────────────────────────────────────
const p2 = (type, amount, { currency, from, until, country } = {}) =>
  `<Price><PriceType>${type}</PriceType>` +
  `<PriceAmount>${amount}</PriceAmount>` +
  (currency ? `<CurrencyCode>${currency}</CurrencyCode>` : "") +
  (country ? `<CountryCode>${country}</CountryCode>` : "") +
  (from ? `<PriceEffectiveFrom>${from}</PriceEffectiveFrom>` : "") +
  (until ? `<PriceEffectiveUntil>${until}</PriceEffectiveUntil>` : "") +
  `</Price>`;
const onix21 = (prices, defaultCurrency) =>
  `<ONIXMessage release="2.1"><Header><FromCompany>Bokbasen</FromCompany>${defaultCurrency ? `<DefaultCurrencyCode>${defaultCurrency}</DefaultCurrencyCode>` : ""}</Header>` +
  `<Product><SupplyDetail><ProductAvailability>21</ProductAvailability>${prices.join("")}</SupplyDetail></Product></ONIXMessage>`;

// Prisen prisjobben ender på: valgt pris, men 0 eller lavere avvises (ingen endring)
const priceJob = (xml) => {
  const p = pickPriceUpdatePrice(xml, TODAY);
  return p !== null && p > 0 ? p : null;
};

const cases = [
  // [navn, xml, forventet pris, forventet årsak]
  // Prioritet (uendret fra prisjobben i gamle Bokadmin)
  ["3: bare 01", onix3([p3("01", "349")]), 349],
  ["3: 02 og 04 med ulike beløp: 04 vinner", onix3([p3("02", "399"), p3("04", "449")]), 449],
  ["3: bare 03", onix3([p3("03", "299")]), 299],
  ["3: ingen type", onix3([p3(null, "199")]), 199],
  ["3: beløp 0 godtas ikke", onix3([p3("04", "0")]), null],
  // Valuta
  ["3: NOK og EUR med samme type: NOK", onix3([p3("04", "39", { currency: "EUR" }), p3("04", "449")]), 449],
  ["3: bare EUR: ingen NOK-pris", onix3([p3("04", "39", { currency: "EUR" })]), null, "ingen NOK-pris"],
  ["3: EUR 04 og NOK 02: NOK 02 (aldri annen valuta som reserve)", onix3([p3("04", "39", { currency: "EUR" }), p3("02", "399")]), 399],
  ["3: uten CurrencyCode: regnes som NOK", onix3([p3("04", "449", { currency: null })]), 449],
  // Dato
  ["3: 04 fra i morgen mot 02 nå: 02", onix3([p3("04", "449", { from: TOMORROW }), p3("02", "399")]), 399],
  ["3: 04 utløpt i går mot 01 uten datoer: 01", onix3([p3("04", "449", { until: YESTERDAY }), p3("01", "349")]), 349],
  ["3: 04 til og med i dag gjelder", onix3([p3("04", "449", { until: TODAY }), p3("02", "399")]), 449],
  ["3: to 04 med ulike startdatoer: nyest start", onix3([p3("04", "399", { from: "20250101" }), p3("04", "449", { from: "20260601" }), p3("04", "499", { from: TOMORROW })]), 449],
  ["3: bare utløpt 04: ingen gyldig pris i dag", onix3([p3("04", "449", { until: YESTERDAY })]), null, "ingen gyldig pris i dag"],
  // Territorium
  ["3: territorium uten NO i Price", onix3([p3("04", "449", { countries: "SE DK" })]), null, "ingen pris for Norge"],
  ["3: territorium med NO i Price", onix3([p3("04", "449", { countries: "SE NO" })]), 449],
  ["3: Market uten NO", onix3([p3("04", "449")], "SE"), null, "ingen pris for Norge"],
  ["3: Market med NO (som hos Bokbasen)", onix3([p3("04", "449")], "NO"), 449],
  ["3: Price-territorium overstyrer Market", onix3([p3("04", "449", { countries: "NO" })], "SE"), 449],
  // Ingen godkjent pris
  ["3: ingen pris", onix3([]), null, "ingen pris"],
  ["3: ingen godkjent (EUR og utløpt NOK)", onix3([p3("04", "39", { currency: "EUR" }), p3("04", "449", { until: YESTERDAY })]), null, "ingen gyldig pris i dag"],
  // ONIX 2.1
  ["2.1: NOK og EUR med samme type: NOK", onix21([p2("04", "39", { currency: "EUR" }), p2("04", "449", { currency: "NOK" })]), 449],
  ["2.1: bare EUR: ingen NOK-pris", onix21([p2("04", "39", { currency: "EUR" })]), null, "ingen NOK-pris"],
  ["2.1: DefaultCurrencyCode NOK i headeren", onix21([p2("04", "449")], "NOK"), 449],
  ["2.1: DefaultCurrencyCode EUR i headeren", onix21([p2("04", "39")], "EUR"), null, "ingen NOK-pris"],
  ["2.1: CurrencyCode i Price overstyrer headeren", onix21([p2("04", "449", { currency: "NOK" })], "EUR"), 449],
  ["2.1: 04 fra i morgen mot 02 nå: 02", onix21([p2("04", "449", { from: TOMORROW }), p2("02", "399")], "NOK"), 399],
  ["2.1: 04 utløpt i går mot 01 uten datoer: 01", onix21([p2("04", "449", { until: YESTERDAY }), p2("01", "349")], "NOK"), 349],
  ["2.1: to 04 med ulike startdatoer: nyest start", onix21([p2("04", "399", { from: "20250101" }), p2("04", "449", { from: "20260601" })], "NOK"), 449],
  ["2.1: CountryCode uten NO", onix21([p2("04", "449", { country: "SE" })], "NOK"), null, "ingen pris for Norge"],
  ["2.1: CountryCode NO", onix21([p2("04", "449", { country: "NO" })], "NOK"), 449],
];

for (const [name, xml, expected, reason] of cases) {
  test(name, () => {
    assert.equal(pickValidPrice(xml, TODAY), expected, "import");
    assert.equal(priceJob(xml), expected, "prisjobb");
    if (reason) assert.equal(choosePrice(xml, TODAY).reason, reason, "årsak");
  });
}

test("pickPriceUpdatePrice returnerer 0 slik at prisjobben kan logge avvisningen", () => {
  assert.equal(pickPriceUpdatePrice(onix3([p3("04", "0")]), TODAY), 0);
});

test("osloToday bruker Europe/Oslo", () => {
  // 30.09 kl. 22:30 UTC er 1. oktober kl. 00:30 i Oslo (sommertid)
  assert.equal(osloToday(new Date("2026-09-30T22:30:00Z")), "20261001");
  assert.equal(osloToday(new Date("2026-09-30T21:30:00Z")), "20260930");
});
