// node --test scripts/*.test.mjs
// Pakke G del 1: gammel automatikk i SEO-feltene (book-seo.ts) og beskrivelsen i Shopify. Eksemplene er hentet fra
// Testbutikk 2026-10-03 (de 7 505 beskrivelsene som ble hoppet over, og de 5 reelt manuelle SEO-tittelene).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEO_DESCRIPTION_MAX, decideSeo, isLegacySeoDescription, isLegacySeoTitle, legacySeo, metaDescription, seoMetafields, shopSeoTitle,
} from "../supabase/functions/_shared/book-seo.ts";
import { bookDescription, canReplaceDescription } from "../supabase/functions/_shared/book-standard.ts";
import { onixText } from "../supabase/functions/_shared/onix.js";

const LONG = "Tre mystiske mord har skjedd ved en arkeologisk utgraving i Egypt. Ofrene er funnet bleke og tappet for blod. Zira tror hun vet hvem morderen er. " +
  "Og det verste av alt: Det kan være hennes skyld! Adam, Tara, Tobias og Zira må reise gjennom det egyptiske landskapet for å finne ut hva som egentlig skjer med de gamle gravene. " +
  "Men noen vil ikke at de skal lykkes, og tiden renner ut. Hvem kan de stole på når alle har noe å skjule?";
const wanted = { title: "NY TITTEL", description: "NY BESKRIVELSE" };

const descDecision = (current, title, text, auto = null) =>
  decideSeo({ title: "", description: current }, wanted, auto, legacySeo(title, text)).description;

// ── Del 1: gammel automatikk i metabeskrivelsen ───────────────────────────────

test("«Kjøp {tittel} hos Bø bok og papir» er gammel automatikk og overskrives", () => {
  assert.equal(descDecision("Kjøp Barnehagefolk. Nr. 3/2022 hos Bø bok og papir", "Barnehagefolk. Nr. 3/2022", ""), "NY BESKRIVELSE");
  // hovedtittelen (før kolon) og punktum på slutten
  assert.equal(descDecision("Kjøp Mikrovaner hos Bø bok og papir.", "Mikrovaner: en enkel måte å få gode vaner", ""), "NY BESKRIVELSE");
  assert.equal(shopSeoTitle("Kjøp X hos Bø bok og papir"), "X");
  assert.equal(shopSeoTitle("Kjøp bøker hos en annen butikk"), null);
});

test("«Kjøp …» med en annen tittel enn boka er en manuell endring", () => {
  assert.equal(descDecision("Kjøp Hamlet hos Bø bok og papir", "Barnehagefolk", ""), null);
});

test("forlagsteksten kuttet på 320 tegn (ren tekst) overskrives", () => {
  const cut = LONG.replace(/\s+/g, " ").slice(0, 320);
  assert.equal(descDecision(cut, "Mordene i Egypt", LONG), "NY BESKRIVELSE");
});

test("forlagsteksten kuttet på 320 tegn med HTML (også midt i en tagg) overskrives", () => {
  const html = "<strong>Tre mystiske mord</strong> har skjedd ved en arkeologisk utgraving i Egypt.<br /><br />Ofrene er funnet bleke og tappet for blod. Zira tror hun vet hvem morderen er. " +
    "<em>Og det verste av alt:</em> Det kan være hennes skyld! Adam, Tara, Tobias og Zira må reise gjennom det egyptiske landskapet for å finne ut hva som egentlig skjer med de gamle gravene. Men noen vil ikke";
  for (const raw of [html.slice(0, 320), html.slice(0, 321) + "<br /", html.slice(0, 318) + "<b"]) {
    assert.ok(raw.length >= 300, String(raw.length));
    assert.equal(descDecision(raw, "Mordene i Egypt", LONG), "NY BESKRIVELSE", raw.slice(-30));
  }
});

test("hele forlagsteksten (også lang, også med HTML) er gammel automatikk", () => {
  assert.equal(descDecision(LONG, "T", LONG), "NY BESKRIVELSE");
  assert.equal(descDecision("<p>" + LONG.replace(/\. /g, ".</p><p>") + "</p>", "T", LONG), "NY BESKRIVELSE");
  assert.equal(descDecision("Utgivelsesår ikke oppgitt i publikasjonen", "T", "Utgivelsesår ikke oppgitt i publikasjonen"), "NY BESKRIVELSE");
});

test("tom beskrivelse overskrives", () => {
  assert.equal(descDecision("", "T", LONG), "NY BESKRIVELSE");
  assert.equal(descDecision(null, "T", LONG), "NY BESKRIVELSE");
  assert.equal(descDecision("   ", "T", LONG), "NY BESKRIVELSE");
});

test("reelt manuelle endringer står (sikringen er beholdt)", () => {
  // Fra Testbutikk: egne tekster, et sitat, en kort merknad, og starten av forlagsteksten som egen setning
  const manual = [
    "Feil utgivelsesår i kolofonen: 2026",
    "Intenst og vakkert",
    "«Debut som sitter fra første setning. ... skjør og vakker far og sønn-roman.»",
    "Tre mystiske mord har skjedd ved en arkeologisk utgraving i Egypt.", // starten, men ikke kuttet på 320
    "Kjøp den beste krimboka denne høsten hos oss!",
  ];
  for (const m of manual) {
    const d = decideSeo({ title: "", description: m }, wanted, null, legacySeo("Mordene i Egypt", LONG));
    assert.equal(d.description, null, m);
    assert.deepEqual(d.notes, ["Metabeskrivelse endret manuelt, ikke overskrevet"], m);
  }
});

test("forrige genererte verdi (bokadmin.seo_auto) overskrives fortsatt", () => {
  assert.equal(descDecision("Generert i går", "T", LONG, { description: "Generert i går" }), "NY BESKRIVELSE");
});

// ── SEO-tittel ────────────────────────────────────────────────────────────────

test("SEO-tittel: tittelen og hovedtittelen er gammel automatikk, egne titler står", () => {
  const legacy = legacySeo("Markens grøde: en sykkeltur gjennom Norges Donald-historie", "");
  assert.equal(isLegacySeoTitle("Markens grøde", legacy), true);
  assert.equal(isLegacySeoTitle("Markens grøde: en sykkeltur gjennom Norges Donald-historie", legacy), true);
  assert.equal(isLegacySeoTitle("Kjøp Markens grøde hos Bø bok og papir", legacy), true);
  assert.equal(isLegacySeoTitle("", legacy), true);
  // De fem reelt manuelle i Testbutikk (serie, rolle- og forfatternavn)
  for (const t of ["Markus Heger", "Ravn-serien", "Edelmot", "Naia Thulin", "Harinder Singh"]) {
    assert.equal(isLegacySeoTitle(t, legacySeo("Skriket", "")), false, t);
  }
  const d = decideSeo({ title: "Markens grøde", description: "" }, wanted, null, legacy);
  assert.equal(d.title, "NY TITTEL");
});

test("isLegacySeoDescription uten tekst å sammenligne med", () => {
  assert.equal(isLegacySeoDescription("Noe helt eget", legacySeo("T", "")), false);
});

// ── seo_auto: bare det som ble skrevet ────────────────────────────────────────

test("seo_auto har bare feltene som ble skrevet; en manuell verdi blir aldri «forrige genererte»", () => {
  const d = decideSeo({ title: "Tittelen", description: "Min egen beskrivelse" }, wanted, null, legacySeo("Tittelen", LONG));
  assert.equal(d.title, "NY TITTEL");
  assert.equal(d.description, null);
  assert.deepEqual(JSON.parse(d.auto), { title: "NY TITTEL" });
  const mf = seoMetafields("gid://p/1", d);
  assert.deepEqual(mf.map((m) => m.key), ["title_tag", "seo_auto"]);
  // Neste kjøring med ny ønsket verdi: beskrivelsen er fortsatt manuell
  const d2 = decideSeo({ title: "NY TITTEL", description: "Min egen beskrivelse" }, { title: "NY TITTEL 2", description: "NY 2" }, JSON.parse(d.auto), legacySeo("Tittelen", LONG));
  assert.equal(d2.title, "NY TITTEL 2");
  assert.equal(d2.description, null);
  // Ingenting å skrive: ingen seo_auto
  const none = decideSeo({ title: "NY TITTEL", description: "NY BESKRIVELSE" }, wanted, null, legacySeo("T", ""));
  assert.equal(none.auto, null);
  assert.deepEqual(seoMetafields("gid://p/1", none), []);
});

// ── Metabeskrivelse: høyst 155 tegn, uten HTML, med smakebit ──────────────────

test("metabeskrivelsen er høyst 155 tegn, uten HTML, og har en smakebit av forlagsteksten", () => {
  const html = "<p><strong>Tre mystiske mord</strong> har skjedd.</p><p>Ofrene er funnet bleke &amp; tappet for blod. Zira tror hun vet hvem morderen er.</p>" + "<br />".repeat(2) + LONG;
  for (const title of ["Mordene i Egypt", "En veldig lang tittel som aldri ser ut til å ta slutt i det hele tatt: med undertittel", "X"]) {
    for (const authors of [["Arne Lindmo"], ["Norge"], []]) {
      for (const format of ["Innbundet", "Annet", null]) {
        const d = metaDescription({ title, authors, format, year: 2026, description: html });
        assert.ok(d.length <= SEO_DESCRIPTION_MAX, `${d.length}: ${d}`);
        assert.ok(!/[<>]/.test(d), d);
        assert.ok(!d.includes("Annet"), d);
        assert.ok(!d.includes("Norge"), d);
      }
    }
  }
  const d = metaDescription({ title: "Mordene i Egypt", authors: ["Arne Lindmo"], format: "Heftet", year: 2025, description: LONG });
  assert.ok(d.startsWith("Mordene i Egypt av Arne Lindmo (Heftet, 2025). Tre mystiske mord"), d);
});

// ── Beskrivelsen i Shopify (de 829 «annen tekst enn forlagsteksten») ───────────

test("dobbeltkodede entiteter i ONIX («f&amp;oslash;dsel», «&amp;amp;») blir riktige tegn", () => {
  assert.equal(onixText("Flora er tappet for krefter etter en hard f&amp;oslash;dsel, men g&amp;aring;r bra"), "Flora er tappet for krefter etter en hard fødsel, men går bra");
  assert.equal(onixText("Henrik &amp;amp; Suzannah"), "Henrik & Suzannah");
  assert.equal(onixText("Henrik &amp; Suzannah og &lt;b&gt;fet&lt;/b&gt;"), "Henrik & Suzannah og fet");
  assert.equal(onixText("Ukjent &unknown; entitet"), "Ukjent &unknown; entitet");
});

test("beskrivelsen kan erstattes når bare tegnsettingen er annerledes (sitattegn, tankestrek)", () => {
  const wanted = bookDescription("Reisen fra ”erlik” til \"pi\" – og tilbake.", "T", { authors: [], format: "Heftet", pages: null, year: null });
  assert.equal(canReplaceDescription("<p>Reisen fra ”” til \"pi\" og tilbake.</p>", wanted), false); // ordet «erlik» mangler: en annen tekst
  assert.equal(canReplaceDescription("<p>Reisen fra \"erlik\" til «pi» - og tilbake</p>", wanted), true);
  assert.equal(canReplaceDescription("<p>En helt egen tekst skrevet av butikken.</p>", wanted), false);
});
