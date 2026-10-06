// node --test scripts/*.test.mjs
// Pakke H: utgivelsesår og utgivelsesdato (resolvePublication i _shared/onix.js), reglene 1–5.
// Fixturene er forkortet fra rå ONIX 3.1 fra Bokbasen (06.10.2026). Er de fulle filene i
// scripts/out/onix-gjennomgang/ til stede (git-ignorert), kontrolleres de samme ISBN-ene mot dem også.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { extractPublicationYear, extractPublishingDate, resolvePublication } from "../supabase/functions/_shared/onix.js";

const pd = (role, date) => `<PublishingDate><PublishingDateRole>${role}</PublishingDateRole><Date dateformat="00">${date}</Date></PublishingDate>`;
const md = (date) => `<MarketPublishingDetail><MarketDate><MarketDateRole>01</MarketDateRole><Date dateformat="00">${date}</Date></MarketDate></MarketPublishingDetail>`;
const avail = (code) => `<ProductSupply><SupplyDetail><ProductAvailability>${code}</ProductAvailability></SupplyDetail></ProductSupply>`;
const prod = (...parts) => `<Product><PublishingDetail>${parts.join("")}</PublishingDetail></Product>`;
const msg = (...products) => `<ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference">${products.join("")}</ONIXMessage>`;
const both = (xml) => [extractPublicationYear(xml), extractPublishingDate(xml)];

test("Getting to Yes 9781847940933: to poster, rolle 01 = 2012, rolle 11 = 2018 og 2017 → 2012, ingen dato", () => {
  const xml = msg(prod(pd("01", "2012"), pd("11", "20180105")) + avail(40), prod(pd("01", "2012"), pd("11", "20170421")) + avail(40));
  assert.deepEqual(both(xml), [2012, null]);
  const r = resolvePublication(xml);
  assert.equal(r.rule, 3);
  assert.equal(r.check, true);
  assert.equal(r.products, 2);
});

test("Avgrunnen 9788202509064: rolle 01 = 2016, rolle 11 = 20151218 (1 år) → 2015-12-18", () => {
  const xml = msg(prod(pd("01", "2016"), pd("11", "20151218")) + avail(21));
  assert.deepEqual(both(xml), [2015, "2015-12-18"]);
  assert.equal(resolvePublication(xml).rule, 2);
});

test("Ultraløping 9788230368428: rolle 01 = 2025, rolle 11 = 20260109 → 2026-01-09", () => {
  assert.deepEqual(both(msg(prod(pd("01", "2025"), pd("11", "20260109")) + avail(40))), [2026, "2026-01-09"]);
});

test("Dysfagi 9788213024006: rolle 01 = 2005, rolle 11 = 20180419 → 2005, ingen dato", () => {
  const xml = msg(prod(pd("01", "2005"), pd("11", "20180419")) + avail(97));
  assert.deepEqual(both(xml), [2005, null]);
  assert.equal(resolvePublication(xml).check, true);
});

test("regel 1: kommende bok (10–12) med MarketDate 01 gir dato og år, også mot rolle 01 og 11", () => {
  const xml = msg(prod(pd("01", "2024"), pd("11", "20240101"), md("20261015")) + avail(11));
  assert.deepEqual(both(xml), [2026, "2026-10-15"]);
  assert.equal(resolvePublication(xml).rule, 1);
  // ikke kommende: MarketDate gir ikke regel 1
  assert.notEqual(resolvePublication(msg(prod(pd("01", "2026"), md("20261015")) + avail(21))).rule, 1);
});

test("regel 2: samme år og ett år fra hverandre → dato og år fra datoen", () => {
  assert.deepEqual(both(msg(prod(pd("01", "2022"), pd("11", "20220610")))), [2022, "2022-06-10"]);
  assert.deepEqual(both(msg(prod(pd("01", "2023"), pd("11", "20221230")))), [2022, "2022-12-30"]);
  assert.deepEqual(both(msg(prod(pd("01", "2022"), pd("11", "20230102")))), [2023, "2023-01-02"]);
});

test("regel 3: to år eller mer fra hverandre → rolle 01, ingen dato, kontrolliste", () => {
  const r = resolvePublication(msg(prod(pd("01", "2022"), pd("11", "20240601"))));
  assert.deepEqual([r.year, r.date, r.rule, r.check, r.role01Year, r.role11Date], [2022, null, 3, true, 2022, "2024-06-01"]);
});

test("regel 4: bare én av dem", () => {
  assert.deepEqual(both(msg(prod(pd("01", "2021")))), [2021, null]);
  assert.deepEqual(both(msg(prod(pd("11", "20190305")))), [2019, "2019-03-05"]);
  assert.equal(resolvePublication(msg(prod(pd("01", "2021")))).rule, 4);
  assert.deepEqual(both(msg(prod(""))), [null, null]);
  assert.deepEqual(both("<Product><PublicationDate>20111024</PublicationDate></Product>"), [2011, "2011-10-24"]);
  assert.deepEqual(both("<Product><PublicationDate>2011</PublicationDate></Product>"), [2011, null]);
});

test("regel 5: flere Product — året flest har (likt: det laveste), tidligste dato som passer", () => {
  // 2012 i to poster, 2015 i én → 2012; ingen dato passer (2017, 2018, 2013 → 2013 passer!)
  const xml = msg(prod(pd("01", "2012"), pd("11", "20180105")), prod(pd("01", "2012"), pd("11", "20130421")), prod(pd("01", "2015"), pd("11", "20161111")));
  assert.deepEqual(both(xml), [2013, "2013-04-21"]);
  // likt antall: det laveste året
  assert.equal(resolvePublication(msg(prod(pd("01", "2020")), prod(pd("01", "2018")))).year, 2018);
  // tidligste dato blant de som passer
  assert.deepEqual(both(msg(prod(pd("01", "2010"), pd("11", "20110301")), prod(pd("01", "2010"), pd("11", "20100501")))), [2010, "2010-05-01"]);
});

test("full dato i rolle 01 brukes som dato", () => {
  assert.deepEqual(both(msg(prod(pd("01", "20240102"), pd("11", "20190101")))), [2024, "2024-01-02"]);
});

const real = (isbn) => { const f = `scripts/out/onix-gjennomgang/${isbn}.xml`; return existsSync(f) ? readFileSync(f, "utf8") : null; };
for (const [isbn, year, date] of [["9781847940933", 2012, null], ["9788202509064", 2015, "2015-12-18"], ["9788230368428", 2026, "2026-01-09"], ["9788213024006", 2005, null]]) {
  test(`rå ONIX ${isbn} → ${year}, ${date ?? "ingen dato"}`, { skip: real(isbn) === null }, () => {
    assert.deepEqual(both(real(isbn)), [year, date]);
  });
}

import { availabilityRule, describeAvailabilityChanges, planAvailability } from "../supabase/functions/_shared/availability.ts";

test("tilgjengelighet: usikker dato sletter en bok.utgivelsesdato som står (også med egen tilgjengelighet)", () => {
  const rule = availabilityRule("21");
  const product = { status: "ACTIVE", tilgjengelighet: { value: "tilgjengelig" }, utgivelsesdato: { value: "2018-01-05" } };
  const plan = planAvailability(product, rule, null, true);
  assert.deepEqual(plan.changes, { deleteDate: { from: "2018-01-05" } });
  assert.match(describeAvailabilityChanges(plan.changes), /utgivelsesdato 2018-01-05 slettes/);
  const own = planAvailability({ ...product, status: "DRAFT", egenTilgjengelighet: { value: "true" } }, rule, null, true);
  assert.deepEqual(own.changes, { deleteDate: { from: "2018-01-05" } });
  // uten usikker dato (bare årstall) og uten metafelt: ingenting å slette
  assert.deepEqual(planAvailability(product, rule, null, false).changes, {});
  assert.deepEqual(planAvailability({ ...product, utgivelsesdato: null }, rule, null, true).changes, {});
  // en sikker dato settes som før
  assert.deepEqual(planAvailability(product, rule, "2018-03-01", false).changes, { utgivelsesdato: { from: "2018-01-05", to: "2018-03-01" } });
});
