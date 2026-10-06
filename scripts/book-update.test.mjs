// node --test scripts/*.test.mjs
// Jobben «Oppdater eksisterende bøker» (pakke B del 8, _shared/book-update.ts).
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
// Ingen produkter i beskyttede samlinger her (medlemskap testes i protected.test.mjs)
setProtectedMembers([]);
import { test } from "node:test";
import assert from "node:assert/strict";
import { countPlan, emptyBookUpdateCounts, loadBookUpdateCounts, planBookUpdate, summarizeBookUpdate } from "../supabase/functions/_shared/book-update.ts";
import { bookSeo } from "../supabase/functions/_shared/book-seo.ts";

const onix = `<ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference"><Product>
<DescriptiveDetail><ProductForm>BB</ProductForm>
<TitleDetail><TitleType>01</TitleType><TitleElement><TitleElementLevel>01</TitleElementLevel><TitleText>Avkledd</TitleText><Subtitle>den syke historien</Subtitle></TitleElement></TitleDetail>
<Contributor><SequenceNumber>1</SequenceNumber><ContributorRole>A01</ContributorRole><PersonNameInverted>Brochmann, Nina</PersonNameInverted></Contributor>
<Language><LanguageRole>01</LanguageRole><LanguageCode>nob</LanguageCode></Language>
<Extent><ExtentType>00</ExtentType><ExtentValue>288</ExtentValue><ExtentUnit>03</ExtentUnit></Extent>
<Subject><SubjectSchemeIdentifier>93</SubjectSchemeIdentifier><SubjectCode>JBFW</SubjectCode></Subject></DescriptiveDetail>
<CollateralDetail><TextContent><TextType>03</TextType><Text>Første avsnitt.&lt;br&gt;&lt;br&gt;Andre avsnitt.</Text></TextContent></CollateralDetail>
<PublishingDetail><Publisher><PublisherName>Gyldendal</PublisherName></Publisher><PublishingDate><PublishingDateRole>01</PublishingDateRole><Date dateformat="05">2026</Date></PublishingDate></PublishingDetail>
</Product></ONIXMessage>`;

const oldProduct = () => ({
  id: "gid://shopify/Product/1",
  handle: "avkledd-nina-brochmann-9788203461392",
  title: "Avkledd: den syke historien",
  productType: "",
  category: null,
  tags: ["Avkledd: den syke historien", "bkg-3", "Brochmann", "folio-test", "Nina"],
  descriptionHtml: "<p>Første avsnitt.Andre avsnitt.</p>",
  seoTitleMf: { value: "Avkledd: den syke historien" },
  seoDescMf: null,
  seoAuto: null,
  media: { nodes: [{ id: "gid://shopify/MediaImage/9", alt: "Avkledd: den syke historien", image: { url: "https://cdn.shopify.com/s/files/1/0/files/jpg.jpg?v=1" } }] },
  mf_forfatter: { value: "[\"Nina Brochmann\"]" },
});

test("gammelt produkt: alle feltene fra del 1–7 rettes, pris/status/handle/tittel røres ikke", () => {
  const plan = planBookUpdate(oldProduct(), onix);
  const fields = plan.changes.map((c) => c.field).sort();
  assert.deepEqual(fields, [
    "bok.format", "bok.sider", "bok.spraak", "bok.thema", "bok.utgivelsesaar",
    "category", "coverAlt", "coverFilename", "description", "productType", "seoDescription", "seoTitle", "tags",
  ]);
  assert.deepEqual(plan.product, {
    productType: "Bok",
    category: "gid://shopify/TaxonomyCategory/me-1-3",
    descriptionHtml: "<p>Første avsnitt.</p>\n<p>Andre avsnitt.</p>",
    tags: ["bkg-3", "folio-test"],
  });
  for (const k of ["price", "status", "handle", "title"]) assert.equal(k in plan.product, false, k);
  assert.deepEqual(plan.cover, { mediaId: "gid://shopify/MediaImage/9", change: { alt: "Omslag: Avkledd av Nina Brochmann", filename: "avkledd-nina-brochmann-9788203461392-omslag.jpg" } });
  assert.ok(plan.metafields.some((m) => m.namespace === "bokadmin" && m.key === "seo_auto"));
  assert.ok(!plan.metafields.some((m) => m.key === "forfatter"), "forfatter er allerede riktig");
});

test("produkt som allerede følger standarden: ingen endringer", () => {
  const p = oldProduct();
  const once = planBookUpdate(p, onix);
  const seo = bookSeo({ title: p.title, authors: ["Nina Brochmann"], format: "Innbundet", year: 2026, description: "Første avsnitt.\n\nAndre avsnitt." });
  const done = {
    ...p, ...once.product, category: { id: once.product.category },
    seoTitleMf: { value: seo.title }, seoDescMf: { value: seo.description }, seoAuto: { value: JSON.stringify(seo) },
    media: { nodes: [{ id: "gid://shopify/MediaImage/9", alt: once.cover.change.alt, image: { url: `https://cdn.shopify.com/s/files/1/0/files/${once.cover.change.filename}?v=2` } }] },
  };
  for (const m of once.metafields.filter((m) => m.namespace === "bok")) done[`mf_${m.key}`] = { value: m.value };
  const again = planBookUpdate(done, onix);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.product, {});
});

test("manuelt endret SEO-tittel og egen beskrivelse står", () => {
  const p = { ...oldProduct(), seoTitleMf: { value: "Bokhandlerens favoritt" }, descriptionHtml: "<p>Vår egen tekst.</p>" };
  const plan = planBookUpdate(p, onix);
  assert.ok(!plan.changes.some((c) => c.field === "seoTitle" || c.field === "description"));
  assert.ok(plan.notes.includes("SEO-tittel endret manuelt, ikke overskrevet"));
  assert.ok(plan.notes.some((n) => n.startsWith("Beskrivelsen er en annen tekst")));
});

test("sammendrag og tellinger over pulser", () => {
  const c = emptyBookUpdateCounts();
  countPlan(c, "a", planBookUpdate(oldProduct(), onix));
  c.skippedNoIsbn = 22;
  const reloaded = loadBookUpdateCounts(JSON.parse(JSON.stringify(c)));
  assert.equal(reloaded.changed, 1);
  assert.equal(reloaded.fields.productType.count, 1);
  assert.equal(reloaded.fields.productType.examples[0], "a: (tom) → Bok");
  const s = summarizeBookUpdate(reloaded, "analyze");
  assert.ok(s.startsWith("1 ville blitt endret, 0 uendret, hoppet over 22 (22 uten ISBN, 0 uten ONIX, 0 ikke bok, 0 beskyttet, 0 DUPLIKAT), 0 feil. Felt:"), s);
});

// ── Pakke H del 3: bøker uten forlagstekst ───────────────────────────────────
const onixNoText = onix.replace(/<CollateralDetail>.*<\/CollateralDetail>\n/s, "");
const FALLBACK = "<p>Avkledd av Nina Brochmann. Innbundet, 288 sider, utgitt 2026.</p>";
const autoOf = (plan) => JSON.parse(plan.metafields.find((m) => m.key === "seo_auto").value);

test("uten forlagstekst og tom beskrivelse (også <p></p>): faktatekst, lagret som generert i seo_auto.body", () => {
  for (const empty of ["", "<p></p>", null]) {
    const plan = planBookUpdate({ ...oldProduct(), descriptionHtml: empty }, onixNoText);
    assert.equal(plan.product.descriptionHtml, FALLBACK, String(empty));
    assert.equal(autoOf(plan).body, FALLBACK);
  }
});

test("metabeskrivelsen er «Tittel av Forfatter (format, år).» uten forlagstekst", () => {
  const plan = planBookUpdate({ ...oldProduct(), descriptionHtml: "" }, onixNoText);
  const d = plan.metafields.find((m) => m.key === "description_tag");
  assert.equal(d.value, "Avkledd av Nina Brochmann (Innbundet, 2026).");
});

test("en eksisterende tekst overskrives aldri av faktateksten", () => {
  const plan = planBookUpdate({ ...oldProduct(), descriptionHtml: "<p>Butikkens egen tekst.</p>" }, onixNoText);
  assert.equal("descriptionHtml" in plan.product, false);
  assert.ok(!plan.changes.some((c) => c.field === "description"));
  const a = plan.metafields.find((m) => m.key === "seo_auto");
  assert.ok(!a || autoOf(plan).body === undefined);
});

test("generert tekst byttes ut når forlagsteksten kommer, og body fjernes", () => {
  const p = { ...oldProduct(), descriptionHtml: FALLBACK, seoAuto: { value: JSON.stringify({ body: FALLBACK }) } };
  const plan = planBookUpdate(p, onix);
  assert.equal(plan.product.descriptionHtml, "<p>Første avsnitt.</p>\n<p>Andre avsnitt.</p>");
  assert.equal(autoOf(plan).body, undefined);
});

test("generert tekst som ikke lenger stemmer med feltene oppdateres (stor forskjell: gammel form med forlag)", () => {
  const old = "<p>Avkledd av Nina Brochmann. Innbundet, 288 sider, utgitt 2026 på Gyldendal.</p>";
  const plan = planBookUpdate({ ...oldProduct(), descriptionHtml: old }, onixNoText);
  assert.equal(plan.product.descriptionHtml, FALLBACK);
});

test("faktateksten er stabil: ingen ny endring ved neste kjøring", () => {
  const first = planBookUpdate({ ...oldProduct(), descriptionHtml: "" }, onixNoText);
  const after = { ...oldProduct(), descriptionHtml: FALLBACK, seoAuto: { value: first.metafields.find((m) => m.key === "seo_auto").value },
    seoDescMf: { value: first.metafields.find((m) => m.key === "description_tag").value } };
  const again = planBookUpdate(after, onixNoText);
  assert.ok(!again.changes.some((c) => c.field === "description"));
  assert.ok(!again.metafields.some((m) => m.key === "seo_auto"));
});
