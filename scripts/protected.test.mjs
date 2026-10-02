// node --test scripts/*.test.mjs
// Beskyttede produkter (supabase/functions/_shared/protected.ts, oppgaver/regel-beskyttede-samlinger.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROTECTED_TAGS, isProtected, isProtectedTag, keepProtectedTags, protectedMessage, protectedTag, tagList,
} from "../supabase/functions/_shared/protected.ts";
import { planBookUpdate } from "../supabase/functions/_shared/book-update.ts";
import { cleanBookTags } from "../supabase/functions/_shared/book-tags.ts";
import { planHandleMigration } from "../supabase/functions/_shared/handle-migration.js";
import { planTagCleanup, shouldKeepTag } from "./clean-tags.mjs";

const SPELLINGS = {
  gave: ["gave", "Gave", "GAVE", " gave "],
  lokal: ["lokal", "Lokal", "LOKAL", "  lokal"],
  lokalhistorie: ["lokalhistorie", "Lokalhistorie", "LOKALHISTORIE", " lokalhistorie "],
  lokallitteratur: ["lokallitteratur", "Lokallitteratur", "LOKALLITTERATUR", "lokallitteratur\t"],
};

test("listen er de fire taggene og kan ikke endres", () => {
  assert.deepEqual([...PROTECTED_TAGS], ["gave", "lokal", "lokalhistorie", "lokallitteratur"]);
  assert.throws(() => PROTECTED_TAGS.push("x"));
});

test("hver av de fire taggene er beskyttet i ulike skrivemåter", () => {
  for (const [tag, variants] of Object.entries(SPELLINGS)) {
    for (const v of variants) {
      assert.equal(isProtected(["bkg-3", v]), true, `${tag}: «${v}»`);
      assert.equal(isProtectedTag(v), true);
      assert.equal(protectedTag(["bkg-3", v]), v.trim());
    }
  }
});

test("delvis like tagger er ikke beskyttet", () => {
  for (const t of ["oppgaver", "gaveide", "lokalkunnskap", "Lokallitteratur i Telemark", "gaver", "gavekort", "lokal-", "bkg-4"]) {
    assert.equal(isProtected([t]), false, t);
  }
  assert.equal(isProtected([]), false);
  assert.equal(isProtected(null), false);
  assert.equal(isProtected(undefined), false);
});

test("melding i loggen", () => {
  assert.equal(protectedMessage(["bkg-3", "Lokalhistorie"]), "Hoppet over: beskyttet (tagg: Lokalhistorie)");
});

test("keepProtectedTags legger tilbake beskyttede tagger som mangler", () => {
  assert.deepEqual(keepProtectedTags(["Gave", "Brochmann", "bkg-3"], ["bkg-3"]), ["bkg-3", "Gave"]);
  assert.deepEqual(keepProtectedTags(["Gave"], ["gave"]), ["gave"]);
});

test("tagList: liste eller kommaseparert tekst", () => {
  assert.deepEqual(tagList("gave, bkg-3"), ["gave", "bkg-3"]);
  assert.deepEqual(tagList(["lokal"]), ["lokal"]);
  assert.deepEqual(tagList(null), []);
});

// ── Oppdateringsjobben (og senere bulk, som bruker samme planBookUpdate) ──
const onix = `<ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference"><Product>
<DescriptiveDetail><ProductForm>BB</ProductForm>
<TitleDetail><TitleType>01</TitleType><TitleElement><TitleElementLevel>01</TitleElementLevel><TitleText>Gave</TitleText></TitleElement></TitleDetail>
<Contributor><SequenceNumber>1</SequenceNumber><ContributorRole>A01</ContributorRole><PersonNameInverted>Lokal, Ola</PersonNameInverted></Contributor>
<Language><LanguageRole>01</LanguageRole><LanguageCode>nob</LanguageCode></Language></DescriptiveDetail>
<CollateralDetail><TextContent><TextType>03</TextType><Text>Ny tekst.</Text></TextContent></CollateralDetail>
<PublishingDetail><Publisher><PublisherName>Forlag</PublisherName></Publisher></PublishingDetail>
</Product></ONIXMessage>`;

const product = (tags) => ({
  id: "gid://shopify/Product/1", handle: "9788203461392", title: "Gave", productType: "Lokal, Ola",
  category: null, tags, descriptionHtml: "<p>Gammel tekst.</p>", seoTitleMf: null, seoDescMf: null, seoAuto: null,
  media: { nodes: [{ id: "gid://shopify/MediaImage/9", alt: "x", image: { url: "https://cdn.shopify.com/a.jpg" } }] },
});

test("oppdateringsjobben: beskyttet produkt får ingen endringer", () => {
  for (const variants of Object.values(SPELLINGS)) {
    const plan = planBookUpdate(product(["bkg-3", variants[1]]), onix);
    assert.deepEqual(plan.product, {});
    assert.deepEqual(plan.metafields, []);
    assert.equal(plan.cover, null);
    assert.deepEqual(plan.changes, []);
    assert.equal(plan.notes[0], `Hoppet over: beskyttet (tagg: ${variants[1]})`);
  }
});

test("oppdateringsjobben: produkt med «oppgaver» behandles som vanlig", () => {
  const plan = planBookUpdate(product(["oppgaver"]), onix);
  assert.ok(plan.changes.length > 0);
  assert.ok(plan.product.productType);
});

// ── Taggrydding ──
test("cleanBookTags fjerner aldri de fire taggene, selv når de er lik tittel eller forfatter", () => {
  const r = cleanBookTags(["Gave", "Lokal", "Ola", "LOKALHISTORIE", "lokallitteratur", "Lokal, Ola"],
    { title: "Gave", authors: ["Ola Lokal"], authorTexts: ["Lokal, Ola", "Lokalhistorie", "Lokallitteratur"] }, ["bkg-3"]);
  for (const t of ["Gave", "Lokal", "LOKALHISTORIE", "lokallitteratur"]) assert.ok(r.tags.includes(t), t);
  assert.ok(!r.removed.some(isProtectedTag));
  assert.deepEqual(r.removed.sort(), ["Lokal, Ola", "Ola"]);
});

test("clean-tags.mjs: beholder de fire taggene i alle skrivemåter og rører ikke beskyttede produkter", () => {
  for (const v of Object.values(SPELLINGS).flat()) assert.equal(shouldKeepTag(v), true, v);
  assert.equal(shouldKeepTag("oppgaver"), false);
  const p = planTagCleanup(["Lokalhistorie", "Brochmann", "Nina"]);
  assert.equal(p.protected, "Lokalhistorie");
  assert.deepEqual(p.removed, []);
  const q = planTagCleanup(["oppgaver", "bkg-3", "Brochmann"]);
  assert.equal(q.protected, null);
  assert.deepEqual(q.kept, ["bkg-3"]);
  assert.deepEqual(q.removed, ["oppgaver", "Brochmann"]);
});

// ── Handle-migrering (bulk: planen er det som blir JSONL-fila) ──
test("handle-migrering: beskyttede produkter kommer aldri med i planen", () => {
  const prod = (id, isbn, tags) => ({
    id: `gid://shopify/Product/${id}`, handle: isbn, title: "Det hende i Telemark", productType: "Nilsen, Kari",
    status: "ACTIVE", tags, variants: { nodes: [{ barcode: isbn, sku: isbn }] },
  });
  const r = planHandleMigration([
    prod(1, "9788293891604", ["Lokalhistorie"]),
    prod(2, "9788293891611", [" gave "]),
    prod(3, "9788293891628", ["LOKAL"]),
    prod(4, "9788293891635", ["lokallitteratur"]),
    prod(5, "9788293891642", ["oppgaver"]),
  ]);
  assert.equal(r.skipped.beskyttet, 4);
  assert.deepEqual(r.plan.map((p) => p.id), ["gid://shopify/Product/5"]);
});

// ── Alle steder som skriver til Shopify sjekker taggene ──
test("alle skrivere bruker protected.ts", () => {
  const files = {
    "supabase/functions/book-update/index.ts": 1,
    "supabase/functions/price-update/index.ts": 2, // jobben + godkjenning
    "supabase/functions/availability-check/index.ts": 1,
    "supabase/functions/sjangre-sync/index.ts": 1,
    "supabase/functions/shopify/index.ts": 5, // push, samlingstagging, tilbakeføring, katalogredigering, CSV
    "supabase/functions/_shared/handle-migration.js": 1,
    "scripts/clean-tags.mjs": 1,
    "scripts/migrate-handles.mjs": 2, // utføring + angre
    "scripts/isbn-definition.mjs": 2,
  };
  for (const [file, min] of Object.entries(files)) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(src, /from "[./a-z_-]*protected\.ts"/, file);
    const uses = (src.match(/protectedTag\(/g) ?? []).length;
    assert.ok(uses >= min, `${file}: ${uses} kall til protectedTag, ventet minst ${min}`);
  }
});
