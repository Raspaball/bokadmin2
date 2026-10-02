// node --test scripts/*.test.mjs
// Beskyttede produkter (supabase/functions/_shared/protected.ts, oppgaver/regel-beskyttede-samlinger.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROTECTED_COLLECTION_HANDLES, PROTECTED_COLLECTION_MISSING, PROTECTED_MEMBERS_NOT_LOADED, PROTECTED_TAGS, PROTECTED_VENDOR_WORDS,
  isFatalJobError, isProtected, isProtectedCollection, isProtectedTag, keepProtectedTags, loadProtectedMembers,
  protectedMessage, protectedProduct, protectedProductMessage, protectedTag, protectedVendor, setProtectedMembers, tagList,
} from "../supabase/functions/_shared/protected.ts";
import { bulkCoverLine, bulkUpdateLine } from "../supabase/functions/_shared/book-bulk.ts";
import { availabilityBulkLines } from "../supabase/functions/_shared/availability-bulk.ts";
import { availabilityRule, planAvailability } from "../supabase/functions/_shared/availability.ts";
import { decideDuplicate } from "../supabase/functions/_shared/duplicates.ts";

// Standard i fila: ingen produkter i beskyttede samlinger (testene under setter egne lister)
setProtectedMembers([]);
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

// ── Alle steder som skriver til Shopify sjekker produktet (tagg, leverandør, samling) ──
test("alle skrivere bruker protectedProduct og laster samlingslista", () => {
  const files = {
    "supabase/functions/book-update/index.ts": 1,
    "supabase/functions/price-update/index.ts": 2, // jobben + godkjenning
    "supabase/functions/availability-check/index.ts": 1,
    "supabase/functions/sjangre-sync/index.ts": 1,
    "supabase/functions/shopify/index.ts": 5, // push, samlingstagging, tilbakeføring, katalogredigering, CSV
    "supabase/functions/_shared/handle-migration.js": 1,
    "supabase/functions/_shared/book-update.ts": 1,
    "supabase/functions/_shared/book-bulk.ts": 2,
    "supabase/functions/_shared/availability-bulk.ts": 1,
    "supabase/functions/_shared/duplicates.ts": 1,
    "scripts/clean-tags.mjs": 1,
    "scripts/migrate-handles.mjs": 2, // utføring + angre
    "scripts/isbn-definition.mjs": 2,
    "scripts/duplicates.mjs": 1,
  };
  // Disse kjører mot Shopify og må hente produktene i de beskyttede samlingene selv
  const loaders = [
    "supabase/functions/book-update/index.ts", "supabase/functions/price-update/index.ts",
    "supabase/functions/availability-check/index.ts", "supabase/functions/sjangre-sync/index.ts",
    "supabase/functions/shopify/index.ts", "supabase/functions/_shared/bulk-job.ts",
    "scripts/clean-tags.mjs", "scripts/migrate-handles.mjs", "scripts/isbn-definition.mjs", "scripts/duplicates.mjs",
  ];
  const src = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  for (const [file, min] of Object.entries(files)) {
    assert.match(src(file), /from "[./a-z_-]*protected\.ts"/, file);
    const uses = (src(file).match(/protectedProduct\(/g) ?? []).length;
    assert.ok(uses >= min, `${file}: ${uses} kall til protectedProduct, ventet minst ${min}`);
  }
  for (const file of loaders) {
    assert.match(src(file), /ensureProtectedMembers\(|loadProtectedMembers\(/, `${file} laster ikke samlingslista`);
  }
});

// ── Wrendale: leverandør og manuell samling (tillegg 02.10.2026) ──
const WRENDALE_ID = "gid://shopify/Product/900";
const members = new Map([[WRENDALE_ID, "wrendale"]]);

test("lister: leverandørordet wrendale og samlingen wrendale, faste i koden", () => {
  assert.deepEqual([...PROTECTED_VENDOR_WORDS], ["wrendale"]);
  assert.deepEqual([...PROTECTED_COLLECTION_HANDLES], ["wrendale"]);
  assert.throws(() => PROTECTED_VENDOR_WORDS.push("x"));
  assert.throws(() => PROTECTED_COLLECTION_HANDLES.push("x"));
});

test("leverandør: inneholder «wrendale» uten hensyn til store/små bokstaver", () => {
  for (const v of ["Wrendale Design ltd", "WRENDALE", "wrendale designs", " Wrendale "]) {
    assert.equal(protectedVendor(v), v.trim(), v);
    assert.equal(protectedProduct({ id: "gid://shopify/Product/1", tags: [], vendor: v }, new Map()), `leverandør: ${v.trim()}`);
  }
  for (const v of ["Gyldendal Norsk Forlag AS", "Wren Books", "", null, undefined]) assert.equal(protectedVendor(v), null, String(v));
});

test("samling: produkt i wrendale er beskyttet; andre er det ikke", () => {
  assert.equal(protectedProduct({ id: WRENDALE_ID, tags: ["bkg-3"], vendor: "Gyldendal" }, members), "samling: wrendale");
  assert.equal(protectedProductMessage({ id: WRENDALE_ID, tags: [] }, members), "Hoppet over: beskyttet (samling: wrendale)");
  assert.equal(protectedProduct({ id: "gid://shopify/Product/1", tags: ["oppgaver"], vendor: "Gyldendal" }, members), null);
  // Tagg går foran leverandør og samling i meldingen
  assert.equal(protectedProduct({ id: WRENDALE_ID, tags: ["Gave"], vendor: "Wrendale Design ltd" }, members), "tagg: Gave");
});

test("uten lastet samlingsliste stopper sjekken (heller stopp enn å endre et beskyttet produkt)", () => {
  setProtectedMembers(null);
  try {
    // Tagg og leverandør avgjøres uten lista
    assert.equal(protectedProduct({ id: "x", tags: ["lokal"] }), "tagg: lokal");
    assert.equal(protectedProduct({ id: "x", tags: [], vendor: "Wrendale Design ltd" }), "leverandør: Wrendale Design ltd");
    assert.throws(() => protectedProduct({ id: "x", tags: [], vendor: "Gyldendal" }), { message: PROTECTED_MEMBERS_NOT_LOADED });
  } finally {
    setProtectedMembers([]);
  }
});

test("loadProtectedMembers: henter alle sider, og stopper når samlingen mangler", async () => {
  const pages = [
    { nodes: [{ id: "gid://shopify/Product/1" }, { id: "gid://shopify/Product/2" }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    { nodes: [{ id: "gid://shopify/Product/3" }], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  const calls = [];
  const m = await loadProtectedMembers(async (_q, v) => {
    calls.push(v);
    return { collectionByIdentifier: { id: "gid://shopify/Collection/9", handle: v.handle, products: pages[v.after ? 1 : 0] } };
  });
  assert.deepEqual(calls, [{ handle: "wrendale", after: null }, { handle: "wrendale", after: "c1" }]);
  assert.deepEqual([...m.keys()], ["gid://shopify/Product/1", "gid://shopify/Product/2", "gid://shopify/Product/3"]);
  // Lista brukes nå uten å sendes inn
  assert.equal(protectedProduct({ id: "gid://shopify/Product/3", tags: [] }), "samling: wrendale");
  await assert.rejects(() => loadProtectedMembers(async () => ({ collectionByIdentifier: null })), (e) => e.message.startsWith(PROTECTED_COLLECTION_MISSING));
  assert.equal(isFatalJobError(`Error: ${PROTECTED_COLLECTION_MISSING} «wrendale». Jobben stopper`), true);
  assert.equal(isFatalJobError("Shopify HTTP 401: x"), true);
  assert.equal(isFatalJobError("fetch failed"), false);
  setProtectedMembers([]);
});

test("samlingen selv: wrendale, og smarte samlinger med regel på en beskyttet tagg", () => {
  assert.equal(isProtectedCollection({ handle: "wrendale" }), true);
  assert.equal(isProtectedCollection({ handle: "Wrendale" }), true);
  assert.equal(isProtectedCollection({ handle: "gaveartikler", ruleSet: { rules: [{ column: "TAG", relation: "EQUALS", condition: "gave" }] } }), true);
  assert.equal(isProtectedCollection({ handle: "lokalhistorie", ruleSet: { rules: [{ column: "TAG", relation: "EQUALS", condition: "LOKALHISTORIE" }] } }), true);
  assert.equal(isProtectedCollection({ handle: "bkg-417", ruleSet: { rules: [{ column: "TAG", relation: "EQUALS", condition: "bkg-417" }] } }), false);
  assert.equal(isProtectedCollection({ handle: "jul", ruleSet: { rules: [{ column: "TITLE", relation: "CONTAINS", condition: "gave" }] } }), false);
  assert.equal(isProtectedCollection({ handle: "nyheter" }), false);
});

test("Wrendale i jobbene: ingen linjer i bulk, ingen plan, ingen handle, ikke automatisk duplikat", () => {
  setProtectedMembers(members);
  try {
    const byVendor = { id: "gid://shopify/Product/901", handle: "wrendale-kopp", title: "Kopp", tags: [], vendor: "Wrendale Design ltd", variants: { nodes: [{ id: "v1" }] } };
    const byMember = { id: WRENDALE_ID, handle: "9788293891604", title: "Bok i samlingen", tags: [], vendor: "Gyldendal", variants: { nodes: [{ id: "v2", barcode: "9788293891604", sku: "9788293891604" }] } };
    const plan = { product: { productType: "Bok" }, metafields: [{ ownerId: "x", namespace: "bok", key: "format", type: "single_line_text_field", value: "Heftet" }], cover: { mediaId: "m", change: { alt: "a" } }, changes: [{ field: "productType", from: "", to: "Bok" }], notes: [] };
    for (const p of [byVendor, byMember]) {
      assert.equal(bulkUpdateLine(p, plan), null, p.handle);
      assert.equal(bulkCoverLine(p, plan), null, p.handle);
      const rule = availabilityRule("40");
      const ap = planAvailability({ status: "ACTIVE", variant: { inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }, rule, null);
      assert.deepEqual(availabilityBulkLines(p, rule, null, ap), { variant: null, product: null }, p.handle);
      assert.match(planBookUpdate(p, "<Product><ProductForm>BC</ProductForm></Product>").notes[0], /^Hoppet over: beskyttet/);
    }
    const r = planHandleMigration([{ ...byMember, productType: "Nilsen, Kari", status: "ACTIVE" }]);
    assert.equal(r.skipped.beskyttet, 1);
    assert.deepEqual(r.plan, []);
    const d = decideDuplicate([
      { ...byMember, status: "ACTIVE", createdAt: "2024-01-01T00:00:00Z", orders: 0 },
      { id: "gid://shopify/Product/2", handle: "dup", title: "Dup", status: "ACTIVE", createdAt: "2025-01-01T00:00:00Z", tags: [], orders: 0 },
    ]);
    assert.equal(d.automatic, false);
    assert.match(d.reason, /samling: wrendale/);
    assert.equal(planTagCleanup(["Brochmann"], byVendor).protected, "leverandør: Wrendale Design ltd");
  } finally {
    setProtectedMembers([]);
  }
});

