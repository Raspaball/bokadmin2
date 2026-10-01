// node --test scripts/*.test.mjs
// Tilgjengelighetskode og utgivelsesdato fra ONIX (supabase/functions/_shared/onix.js).
// Utdragene er forkortet fra rå ONIX 3.1 fra Bokbasen (hentet 2026-10-01).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAvailabilityCode, extractPublishingDate } from "../supabase/functions/_shared/onix.js";

const pub = (role, date, fmt = "00") =>
  `<PublishingDate><PublishingDateRole>${role}</PublishingDateRole><Date dateformat="${fmt}">${date}</Date></PublishingDate>`;
const market = (role, date) =>
  `<Market><Territory><CountriesIncluded>NO</CountriesIncluded></Territory></Market><MarketPublishingDetail><MarketDate><MarketDateRole>${role}</MarketDateRole><Date dateformat="00">${date}</Date></MarketDate></MarketPublishingDetail>`;
const supply = (avail, extra = "") =>
  `<SupplyDetail><Supplier><SupplierName>Sentraldistribusjon</SupplierName></Supplier>${extra}<ProductAvailability>${avail}</ProductAvailability></SupplyDetail>`;
const product = (...parts) =>
  `<?xml version="1.0"?><ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference" release="3.1"><Product><PublishingDetail>${parts.join("")}</PublishingDetail></Product></ONIXMessage>`;

test("kommende bok (kode 11): dato fra MarketDate 01, ikke SupplyDate 08", () => {
  const xml = product(pub("01", "2026", "05"), market("01", "20261015"),
    supply("11", `<SupplyDate><SupplyDateRole>08</SupplyDateRole><Date dateformat="00">20261019</Date></SupplyDate>`));
  assert.equal(extractAvailabilityCode(xml), "11");
  assert.equal(extractPublishingDate(xml), "2026-10-15");
});

test("utgitt bok (kode 21): rolle 01 er bare årstall, dato fra rolle 11", () => {
  const xml = product(pub("01", "2024", "05"), pub("11", "20240312"), supply("21"));
  assert.equal(extractAvailabilityCode(xml), "21");
  assert.equal(extractPublishingDate(xml), "2024-03-12");
});

test("rolle 01 med hel dato går foran alt annet", () => {
  assert.equal(extractPublishingDate(product(pub("11", "20200101"), pub("01", "20261115"), market("01", "20261201"))), "2026-11-15");
});

test("bare årstall: ingen dato", () => {
  assert.equal(extractPublishingDate(product(pub("01", "1998", "05"), supply("40"))), null);
});

test("ONIX 2.1 PublicationDate som reserve", () => {
  assert.equal(extractPublishingDate("<Product><PublicationDate>20111024</PublicationDate></Product>"), "2011-10-24");
  assert.equal(extractPublishingDate("<Product><PublicationDate>2011</PublicationDate></Product>"), null);
});

test("ugyldig dato og datetime", () => {
  assert.equal(extractPublishingDate(product(pub("01", "20261399"))), null);
  assert.equal(extractPublishingDate(product(pub("11", "20260105T0800"))), "2026-01-05");
});

test("rolle 02 (salgsembargo) brukes ikke", () => {
  assert.equal(extractPublishingDate(product(pub("02", "20261001"))), null);
});

test("tilgjengelighetskode: første SupplyDetail med kode, navnerom og mellomrom", () => {
  assert.equal(extractAvailabilityCode(product(supply("10"), supply("21"))), "10");
  assert.equal(extractAvailabilityCode(`<onix:Product xmlns:onix="x"><onix:SupplyDetail><onix:ProductAvailability> 31 </onix:ProductAvailability></onix:SupplyDetail></onix:Product>`), "31");
  assert.equal(extractAvailabilityCode(product(pub("01", "2026"))), null);
});
