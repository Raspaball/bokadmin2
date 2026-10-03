// node --test scripts/*.test.mjs
// Pakke G del 4a: format «Annet» står ikke i SEO-tittelen, og lagres ikke som bok.format
// (Loggbok-bøkene og Ayotzinapa). Finnes «Annet» fra før, slettes metafeltet.
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
setProtectedMembers([]);
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookSeo, seoTitle } from "../supabase/functions/_shared/book-seo.ts";
import { bookMetafields } from "../supabase/functions/_shared/book-standard.ts";
import { shownFormat } from "../supabase/functions/_shared/book-format.ts";
import { planBookUpdate } from "../supabase/functions/_shared/book-update.ts";

const c = (role, nameXml, seq) =>
  `<Contributor>${seq ? `<SequenceNumber>${seq}</SequenceNumber>` : ""}<ContributorRole>${role}</ContributorRole><NameType>04</NameType>${nameXml}</Contributor>`;
const norge = c("Z03", "<CorporateName>Norge</CorporateName>", 1);

test("format «Annet» vises ikke i SEO-tittel eller metabeskrivelse og lagres ikke som bok.format", () => {
  assert.equal(shownFormat("Annet"), "");
  assert.equal(shownFormat("Heftet"), "Heftet");
  assert.equal(seoTitle({ title: "Loggbok", authors: ["Per Hansen"], format: "Annet" }), "Loggbok – Per Hansen");
  assert.equal(seoTitle({ title: "Ayotzinapa", authors: [], format: "Annet" }), "Ayotzinapa");
  assert.equal(bookSeo({ title: "Loggbok", authors: ["Per Hansen"], format: "Annet", year: 2020, description: "" }).description, "Loggbok av Per Hansen (2020).");
  const f = { authors: [], institutions: [], authorRole: null, format: "Annet", productType: "Bok", category: "", pages: null, year: 2020, language: null, series: null, age: null, thema: [], bokgruppe: null };
  assert.ok(!bookMetafields(f).some((m) => m.key === "format"));
  assert.ok(bookMetafields({ ...f, format: "Heftet" }).some((m) => m.key === "format" && m.value === "Heftet"));
});

test("planBookUpdate: bok.format «Annet» slettes og settes ikke; SEO og alt-tekst uten «Norge»", () => {
  const onixAnnet = `<ONIXMessage><Product><DescriptiveDetail><ProductForm>DB</ProductForm><TitleDetail><TitleType>01</TitleType><TitleElement><TitleElementLevel>01</TitleElementLevel><TitleText>Loggbok</TitleText></TitleElement></TitleDetail>${norge}</DescriptiveDetail></Product></ONIXMessage>`;
  const base = { id: "gid://shopify/Product/1", handle: "loggbok-9788202913786", title: "Loggbok", tags: [], productType: "Bok", category: { id: "gid://shopify/TaxonomyCategory/me-1-3" },
    mf_format: { value: "Annet" }, mf_forfatter: { value: '["Norge"]' },
    media: { nodes: [{ id: "gid://shopify/MediaImage/1", alt: "Omslag: Loggbok av Norge", image: { url: "https://cdn.shopify.com/s/files/x/loggbok-9788202913786-omslag.jpg?v=1" } }] },
    seoTitleMf: { value: "Loggbok – Norge (Annet)" }, seoAuto: { value: JSON.stringify({ title: "Loggbok – Norge (Annet)" }) } };
  const plan = planBookUpdate(base, onixAnnet);
  assert.deepEqual(plan.metafieldDeletes.map((d) => d.key).sort(), ["forfatter", "format"]);
  assert.ok(!plan.metafields.some((m) => m.key === "format"));
  assert.equal(plan.metafields.find((m) => m.key === "title_tag").value, "Loggbok");
  assert.equal(plan.cover.change.alt, "Omslag: Loggbok");
});
