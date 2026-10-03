// node --test scripts/*.test.mjs
// Pakke G del 4b: bok.utgivelsesaar og bok.utgivelsesdato fra samme kilde (_shared/onix.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPublicationYear, extractPublishingDate } from "../supabase/functions/_shared/onix.js";

const onixWithDates = (...blocks) => `<ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference"><Product><DescriptiveDetail/><PublishingDetail>${blocks.join("")}</PublishingDetail></Product></ONIXMessage>`;
const pd = (role, date, fmt) => `<PublishingDate><PublishingDateRole>${role}</PublishingDateRole><Date dateformat="${fmt}">${date}</Date></PublishingDate>`;

test("Syn og segn 2-2023: året følger datoen (2023), ikke PublishingDate 01 (2022)", () => {
  const xml = onixWithDates(pd("01", "2022", "05"), pd("11", "20230525", "00"));
  assert.equal(extractPublishingDate(xml), "2023-05-25");
  assert.equal(extractPublicationYear(xml), 2023);
});

test("utgivelsesår: kommende bok (MarketDate), bare årstall, og ONIX 2.1", () => {
  const upcoming = onixWithDates(pd("01", "2025", "05")).replace("</PublishingDetail>", '<MarketPublishingDetail><MarketDate><MarketDateRole>01</MarketDateRole><Date dateformat="00">20260709</Date></MarketDate></MarketPublishingDetail></PublishingDetail>');
  assert.equal(extractPublishingDate(upcoming), "2026-07-09");
  assert.equal(extractPublicationYear(upcoming), 2026);
  const yearOnly = onixWithDates(pd("01", "2021", "05"));
  assert.equal(extractPublishingDate(yearOnly), null);
  assert.equal(extractPublicationYear(yearOnly), 2021);
  assert.equal(extractPublicationYear("<Product><PublicationDate>20111024</PublicationDate></Product>"), 2011);
  // hel dato i rolle 01 gir både dato og år
  assert.equal(extractPublicationYear(onixWithDates(pd("01", "20240102", "00"), pd("11", "20190101", "00"))), 2024);
});
