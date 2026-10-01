// node --test scripts/*.test.mjs
// Bokgruppekode fra ONIX (supabase/functions/_shared/onix.js).
// Utdragene er forkortet fra rå ONIX 3.1 fra Bokbasen (hentet 2026-10-01).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBokgruppekode, stripNamespaces } from "../supabase/functions/_shared/onix.js";

const subject = (scheme, code, extra = "") =>
  `<Subject><SubjectSchemeIdentifier>${scheme}</SubjectSchemeIdentifier>${extra}<SubjectCode>${code}</SubjectCode></Subject>`;
const message = (...subjects) =>
  `<?xml version="1.0"?><ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference" release="3.1"><Product><DescriptiveDetail>${subjects.join("")}</DescriptiveDetail></Product></ONIXMessage>`;

test("skjema 37 blant andre skjemaer (Avkledd)", () => {
  const xml = message(subject("37", "312"), subject("38", "39020"), subject("93", "JBFW"), subject("01", "612.6/2", "<SubjectSchemeVersion>23/nor</SubjectSchemeVersion>"));
  assert.equal(extractBokgruppekode(xml), "312");
});

test("38 (varegruppe) og 23 gir ikke bokgruppekode", () => {
  assert.equal(extractBokgruppekode(message(subject("38", "41010"))), null);
  assert.equal(extractBokgruppekode(message(subject("23", "411"))), null);
});

test("Dewey-versjon 23 i SubjectSchemeVersion forveksles ikke med skjema 23 eller 37", () => {
  assert.equal(extractBokgruppekode(message(subject("01", "741.59", "<SubjectSchemeVersion>23/nor</SubjectSchemeVersion>"))), null);
});

test("navneromsprefiks og attributter", () => {
  const xml = `<onix:ONIXMessage xmlns:onix="http://ns.editeur.org/onix/3.1/reference"><onix:Product><onix:Subject datestamp="20260101"><onix:SubjectSchemeIdentifier>37</onix:SubjectSchemeIdentifier><onix:SubjectCode> 430 </onix:SubjectCode></onix:Subject></onix:Product></onix:ONIXMessage>`;
  assert.equal(extractBokgruppekode(xml), "430");
  assert.ok(!stripNamespaces(xml).includes("onix:"));
});

test("ugyldig kode og tom tekst gir null", () => {
  assert.equal(extractBokgruppekode(message(subject("37", "Romaner"))), null);
  assert.equal(extractBokgruppekode(""), null);
  assert.equal(extractBokgruppekode(undefined), null);
});

test("første skjema 37 vinner", () => {
  assert.equal(extractBokgruppekode(message(subject("37", "411"), subject("37", "417"))), "411");
});
