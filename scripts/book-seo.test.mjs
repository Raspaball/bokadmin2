// node --test scripts/*.test.mjs
// SEO-tittel og metabeskrivelse (supabase/functions/_shared/book-seo.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capitalizeStart, cutAtWord, decideSeo, legacySeo, metaDescription, parseSeoAuto, plainOneLine, seoTitle,
} from "../supabase/functions/_shared/book-seo.ts";

const book = (o = {}) => ({ title: "Avkledd", authors: ["Nina Brochmann"], format: "Innbundet", year: 2026, description: "", ...o });

test("tittel: hovedtittel – forfatter (format)", () => {
  assert.equal(seoTitle(book()), "Avkledd – Nina Brochmann (Innbundet)");
  assert.equal(seoTitle(book({ title: "Gleden med skjeden: Alt om underlivet" })), "Gleden med skjeden – Nina Brochmann (Innbundet)");
});

test("tittel: for lang → uten format, så kutt hovedtittelen ved helt ord", () => {
  const t1 = seoTitle(book({ title: "Strikk fra Thorbjørn Egners verden", authors: ["Marte Hasselø"] }));
  assert.equal(t1, "Strikk fra Thorbjørn Egners verden – Marte Hasselø");
  const t2 = seoTitle(book({ title: "En veldig lang tittel som aldri ser ut til å ta slutt i det hele tatt", authors: ["Karl Ove Knausgård"] }));
  assert.ok(t2.length <= 60, t2);
  assert.ok(t2.endsWith(" – Karl Ove Knausgård"));
  assert.ok(!/\s$/.test(t2.split(" – ")[0]));
  // 60 − « – Karl Ove Knausgård» (21) = 39 tegn til hovedtittelen
  assert.equal(t2, "En veldig lang tittel som aldri ser ut – Karl Ove Knausgård");
});

test("tittel: uten forfatter og uten format", () => {
  assert.equal(seoTitle(book({ authors: [] })), "Avkledd (Innbundet)");
  assert.equal(seoTitle(book({ authors: [], format: null })), "Avkledd");
  assert.equal(seoTitle(book({ format: "" })), "Avkledd – Nina Brochmann");
});

test("beskrivelse: prefiks + forlagstekst, høyst 155 tegn, avsnitt blir mellomrom", () => {
  const d = metaDescription(book({ description: "Hva skjer med søtsuget?\n\nGlukoserevolusjonens metode er enkel." }));
  assert.equal(d, "Avkledd av Nina Brochmann (Innbundet, 2026). Hva skjer med søtsuget? Glukoserevolusjonens metode er enkel.");
});

test("beskrivelse: kuttes ved setningsslutt, ellers ved helt ord med …", () => {
  const sentences = "Første setning er her. " + "Andre setning er ganske mye lengre enn den første og går videre og videre. " + "Tredje setning kommer aldri med fordi den er for lang til å få plass.";
  const d1 = metaDescription(book({ description: sentences }));
  assert.ok(d1.length <= 155, String(d1.length));
  assert.ok(d1.endsWith("videre."), d1);
  const words = "ord ".repeat(80).trim();
  const d2 = metaDescription(book({ description: words }));
  assert.ok(d2.length <= 155, String(d2.length));
  assert.ok(d2.endsWith("ord…"), d2);
});

test("beskrivelse: uten forlagstekst, forfatter, format eller år", () => {
  assert.equal(metaDescription(book()), "Avkledd av Nina Brochmann (Innbundet, 2026).");
  assert.equal(metaDescription(book({ authors: [], format: null, year: null })), "Avkledd.");
  assert.equal(metaDescription(book({ year: null })), "Avkledd av Nina Brochmann (Innbundet).");
});

test("HTML og linjeskift fjernes uten sammenlimte ord", () => {
  assert.equal(plainOneLine("<p>søtsuget?</p><p>Glukoserevolusjonens</p>"), "søtsuget? Glukoserevolusjonens");
  assert.equal(plainOneLine("a<br>b\nc"), "a b c");
  assert.equal(cutAtWord("en to tre fire", 9), "en to tre");
});

test("manuelt endret felt overskrives ikke", () => {
  const wanted = { title: "Avkledd – Nina Brochmann (Innbundet)", description: "Ny" };
  const legacy = legacySeo("Avkledd", "Gammel tekst");
  const r = decideSeo({ title: "Min egen tittel", description: "" }, wanted, null, legacy);
  assert.equal(r.title, null);
  assert.equal(r.description, "Ny");
  assert.deepEqual(r.notes, ["SEO-tittel endret manuelt, ikke overskrevet"]);
});

test("oppdateres når feltet er tomt, lik forrige genererte eller lik gammel automatikk", () => {
  const wanted = { title: "T2", description: "D2" };
  const legacy = legacySeo("Avkledd", "Gammel  tekst\nher");
  assert.equal(decideSeo({ title: "", description: null }, wanted, null, legacy).title, "T2");
  assert.equal(decideSeo({ title: "T1", description: "D1" }, wanted, parseSeoAuto('{"title":"T1","description":"D1"}'), legacy).description, "D2");
  const r = decideSeo({ title: "Avkledd", description: "Gammel tekst her" }, wanted, null, legacy);
  assert.equal(r.title, "T2");
  assert.equal(r.description, "D2");
  assert.equal(decideSeo({ title: "T2", description: "D2" }, wanted, null, legacy).title, null);
});

test("gammel automatikk: tittel og 320 tegn", () => {
  assert.equal(legacySeo("X", "a".repeat(400)).description.length, 320);
  assert.equal(parseSeoAuto("ikke json"), null);
});

test("beskrivelse: forlagsteksten beholdes som den er, med stor forbokstav hvis den starter med liten", () => {
  const solaris = { title: "Solaris", authors: ["Astrid Munkebye"], format: "Innbundet", year: 2022 };
  assert.equal(
    metaDescription({ ...solaris, description: "inneholder engasjerende aktiviteter og lek." }),
    "Solaris av Astrid Munkebye (Innbundet, 2022). Inneholder engasjerende aktiviteter og lek.",
  );
  // tittelen i teksten fjernes ikke
  assert.equal(
    metaDescription({ ...solaris, description: "Solaris inneholder en rekke aktiviteter." }),
    "Solaris av Astrid Munkebye (Innbundet, 2022). Solaris inneholder en rekke aktiviteter.",
  );
  // varemerker med stor bokstav inni og tall/tegn røres ikke
  assert.equal(capitalizeStart("iPRAKSIS Håndbok er en bok"), "iPRAKSIS Håndbok er en bok");
  assert.equal(capitalizeStart("2022 var et år"), "2022 var et år");
  assert.equal(capitalizeStart("«sitat» står her"), "«sitat» står her");
  assert.equal(capitalizeStart("eins pust er"), "Eins pust er");
  assert.equal(capitalizeStart(""), "");
});
