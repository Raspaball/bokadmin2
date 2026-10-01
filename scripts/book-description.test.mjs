// node --test scripts/*.test.mjs
// Forlagstekst som HTML og reservebeskrivelse (pakke B del 6, _shared/book-standard.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { onixText } from "../supabase/functions/_shared/onix.js";
import {
  bookDescription, canReplaceDescription, descriptionFingerprint, descriptionHtml, fallbackDescription,
} from "../supabase/functions/_shared/book-standard.ts";

const f = { authors: ["Nina Brochmann"], format: "Innbundet", pages: 288, year: 2026 };

test("avsnitt og linjeskift fra ONIX blir <p> og <br>, ingen sammenlimte setninger", () => {
  const text = onixText("Hva med søtsuget?&lt;br&gt;&lt;br&gt;Glukoserevolusjonens metode&lt;br&gt;er enkel.");
  assert.equal(text, "Hva med søtsuget?\n\nGlukoserevolusjonens metode\ner enkel.");
  assert.equal(descriptionHtml(text), "<p>Hva med søtsuget?</p>\n<p>Glukoserevolusjonens metode<br>er enkel.</p>");
});

test("HTML-koding av & og <", () => {
  assert.equal(descriptionHtml("Ørbeck & Co <3"), "<p>Ørbeck &amp; Co &lt;3</p>");
  assert.equal(descriptionHtml("   "), "");
});

test("reservebeskrivelse: alt med, og det som mangler utelates", () => {
  assert.equal(fallbackDescription("Avkledd: den syke historien", f, "Gyldendal"), "Avkledd av Nina Brochmann. Innbundet, 288 sider, utgitt 2026 på Gyldendal.");
  assert.equal(fallbackDescription("Kart", { authors: [], format: "Kart", pages: null, year: 2001 }, ""), "Kart. Kart, utgitt 2001.");
  assert.equal(fallbackDescription("X", { authors: [], format: "Annet", pages: null, year: null }, null), "X.");
  assert.equal(fallbackDescription("X", { authors: ["A B"], format: null, pages: null, year: null }, "Forlag"), "X av A B. På Forlag.");
});

test("bookDescription bruker forlagsteksten, ellers reserven", () => {
  assert.deepEqual(bookDescription("Tekst.", "Avkledd", f, "Gyldendal"), { html: "<p>Tekst.</p>", fallback: false });
  assert.equal(bookDescription("", "Avkledd", f, "Gyldendal").fallback, true);
});

test("jobben erstatter bare tom tekst, samme tekst med annen formatering, eller egen reserve", () => {
  const wanted = bookDescription("Hva med søtsuget?\n\nGlukoserevolusjonens metode er enkel.", "X", f);
  assert.equal(canReplaceDescription("", wanted), true);
  assert.equal(canReplaceDescription("<p>Hva med søtsuget?Glukoserevolusjonens metode er enkel.</p>", wanted), true);
  assert.equal(canReplaceDescription("<p>Bokhandlerens egen tekst.</p>", wanted), false);
  assert.equal(canReplaceDescription("<p>Avkledd av Nina Brochmann.</p>", wanted, "<p>Avkledd av Nina Brochmann.</p>"), true);
  assert.equal(descriptionFingerprint("<p>a &amp; b</p>"), "a&b");
});
