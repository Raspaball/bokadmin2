// node --test scripts/*.test.mjs
// Bokfeltene (pakke B del 2): _shared/onix.js, _shared/book-format.ts og
// _shared/book-standard.ts. Utdragene er forkortet fra rå ONIX 3.1 fra Bokbasen.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractAudienceAge, extractLanguage, extractPages, extractProductForm, extractPublicationYear, extractSeries, extractThema,
} from "../supabase/functions/_shared/onix.js";
import { bookFormat, CATEGORY_IDS, CATEGORY_NAMES } from "../supabase/functions/_shared/book-format.ts";
import { bookFieldsFromOnix, bookMetafields, sameMetafieldValue } from "../supabase/functions/_shared/book-standard.ts";

const product = (...parts) => `<ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference"><Product><DescriptiveDetail>${parts.join("")}</DescriptiveDetail></Product></ONIXMessage>`;
const extent = (type, value, unit = "03") => `<Extent><ExtentType>${type}</ExtentType><ExtentValue>${value}</ExtentValue><ExtentUnit>${unit}</ExtentUnit></Extent>`;
const lang = (role, code) => `<Language><LanguageRole>${role}</LanguageRole><LanguageCode>${code}</LanguageCode></Language>`;
const collection = (type, title, part) =>
  `<Collection><CollectionType>${type}</CollectionType><TitleDetail><TitleType>01</TitleType><TitleElement><TitleElementLevel>02</TitleElementLevel><TitleText>${title}</TitleText></TitleElement>${part ? `<TitleElement><TitleElementLevel>01</TitleElementLevel><PartNumber>${part}</PartNumber></TitleElement>` : ""}</TitleDetail></Collection>`;
const age = (...pv) => `<AudienceRange><AudienceRangeQualifier>17</AudienceRangeQualifier>${pv.map(([p, v]) => `<AudienceRangePrecision>${p}</AudienceRangePrecision><AudienceRangeValue>${v}</AudienceRangeValue>`).join("")}</AudienceRange>`;
const subject = (scheme, code) => `<Subject><SubjectSchemeIdentifier>${scheme}</SubjectSchemeIdentifier><SubjectCode>${code}</SubjectCode></Subject>`;

test("format: koder fra rådataene og den godkjente listen", () => {
  const f = (form, ...d) => [bookFormat(form, d).format, bookFormat(form, d).productType];
  assert.deepEqual(f("BB"), ["Innbundet", "Bok"]);
  assert.deepEqual(f("BB", "B502"), ["Innbundet", "Bok"]);
  assert.deepEqual(f("BC"), ["Heftet", "Bok"]);
  assert.deepEqual(f("BC", "B113"), ["Pocket", "Bok"]);
  assert.deepEqual(f("BC", "B114"), ["Pocket", "Bok"]);
  assert.deepEqual(f("BC", "B115"), ["Kartonert", "Bok"]);
  assert.deepEqual(f("BC", "B116"), ["Kartonert", "Bok"]);
  assert.deepEqual(f("BC", "B611"), ["Heftet", "Bok"]);
  assert.deepEqual(f("BE"), ["Spiral", "Bok"]);
  assert.deepEqual(f("BC", "B313"), ["Spiral", "Bok"]);
  assert.deepEqual(f("BH"), ["Pappbok", "Bok"]);
  assert.deepEqual(f("AJ", "A103"), ["Lydbok", "Lydbok"]);
  assert.deepEqual(f("AB"), ["Lydbok", "Lydbok"]);
  assert.deepEqual(f("ED", "E101"), ["E-bok", "E-bok"]);
  assert.deepEqual(f("EB"), ["Annet", "E-bok"]);
  assert.deepEqual(f("CB"), ["Kart", "Bok"]);
  assert.deepEqual(f("DB"), ["Annet", "Bok"]);
  assert.deepEqual(f(null), ["Annet", "Bok"]);
  assert.equal(bookFormat("AJ").category, CATEGORY_IDS.Lydbok);
  assert.equal(CATEGORY_IDS.Bok, "gid://shopify/TaxonomyCategory/me-1-3");
});

test("kategori: Print Books, Audiobooks, E-Books ut fra formatet", () => {
  assert.equal(bookFormat("BB").category, "gid://shopify/TaxonomyCategory/me-1-3");
  assert.equal(bookFormat("AJ", ["A103"]).category, "gid://shopify/TaxonomyCategory/me-1-1");
  assert.equal(bookFormat("ED", ["E101"]).category, "gid://shopify/TaxonomyCategory/me-1-2");
  assert.equal(bookFormat("CB").category, CATEGORY_IDS.Bok);
  assert.equal(CATEGORY_NAMES.Lydbok, "Media > Books > Audiobooks");
});

test("ProductForm og ProductFormDetail leses", () => {
  assert.deepEqual(extractProductForm(product("<ProductForm>BC</ProductForm><ProductFormDetail>B113</ProductFormDetail>")), { form: "BC", details: ["B113"] });
});

test("sider: 00 før 07 før 08, bare enhet 03", () => {
  assert.equal(extractPages(product(extent("08", 300), extent("00", 288))), 288);
  assert.equal(extractPages(product(extent("08", 300))), 300);
  assert.equal(extractPages(product(extent("09", 540, "05"))), null);
  assert.equal(extractPages(product()), null);
});

test("utgivelsesår fra PublishingDate 01, ellers PublicationDate", () => {
  assert.equal(extractPublicationYear(product("<PublishingDate><PublishingDateRole>01</PublishingDateRole><Date dateformat=\"05\">2026</Date></PublishingDate>")), 2026);
  assert.equal(extractPublicationYear("<Product><PublicationDate>20111024</PublicationDate></Product>"), 2011);
  assert.equal(extractPublicationYear(product()), null);
});

test("språk: rolle 01 som norsk navn", () => {
  assert.equal(extractLanguage(product(lang("02", "swe"), lang("01", "nob"))), "Bokmål");
  assert.equal(extractLanguage(product(lang("01", "nno"))), "Nynorsk");
  assert.equal(extractLanguage(product(lang("01", "xyz"))), "xyz");
  assert.equal(extractLanguage(product(lang("02", "eng"))), null);
});

test("serie: type 10 før 20, ikke 11, med nummer", () => {
  assert.equal(extractSeries(product(collection("11", "Cap-serien"), collection("10", "Ingrid Winter", "5"))), "Ingrid Winter (5)");
  assert.equal(extractSeries(product(collection("20", "Matt Scudder", "12"))), "Matt Scudder (12)");
  assert.equal(extractSeries(product(collection("11", "Pekebok"))), null);
  assert.equal(extractSeries(product(collection("10", "Kaldt blod"))), "Kaldt blod");
});

test("alder fra AudienceRange 17", () => {
  assert.equal(extractAudienceAge(product(age(["03", 6], ["04", 9]))), "6–9 år");
  assert.equal(extractAudienceAge(product(age(["03", 9], ["04", 12]), age(["03", 12], ["04", 16]))), "9–16 år");
  assert.equal(extractAudienceAge(product(age(["03", 12]))), "fra 12 år");
  assert.equal(extractAudienceAge(product(age(["01", 5]))), "5 år");
  assert.equal(extractAudienceAge(product(subject("98", "5AG"))), null);
});

test("thema: skjema 93–99, uten 37/38", () => {
  assert.deepEqual(extractThema(product(subject("37", "312"), subject("93", "YBCS"), subject("98", "5AG"), subject("93", "YBCS"), subject("01", "839.82"))), ["YBCS", "5AG"]);
});

test("metafeltene: typer, lister som JSON, tomme felt utelates", () => {
  const f = bookFieldsFromOnix(product(
    `<Contributor><SequenceNumber>1</SequenceNumber><ContributorRole>A01</ContributorRole><PersonNameInverted>Lunde, Maja</PersonNameInverted></Contributor>`,
    "<ProductForm>BB</ProductForm>", extent("00", 162), lang("01", "nob"), collection("10", "Årstidskvartetten", "4"), age(["03", 6], ["04", 12]), subject("93", "YBCS"),
  ));
  const m = Object.fromEntries(bookMetafields(f).map((x) => [x.key, [x.type, x.value]]));
  assert.deepEqual(m.forfatter, ["list.single_line_text_field", "[\"Maja Lunde\"]"]);
  assert.deepEqual(m.format, ["single_line_text_field", "Innbundet"]);
  assert.deepEqual(m.sider, ["number_integer", "162"]);
  assert.deepEqual(m.serie, ["single_line_text_field", "Årstidskvartetten (4)"]);
  assert.deepEqual(m.alder, ["single_line_text_field", "6–12 år"]);
  assert.deepEqual(m.thema, ["list.single_line_text_field", "[\"YBCS\"]"]);
  assert.equal(m.utgivelsesaar, undefined);
  assert.equal(f.productType, "Bok");
});

test("sammenligning av metafeltverdier", () => {
  assert.equal(sameMetafieldValue("[\"A\", \"B\"]", "[\"A\",\"B\"]", "list.single_line_text_field"), true);
  assert.equal(sameMetafieldValue("162", "162", "number_integer"), true);
  assert.equal(sameMetafieldValue(null, "162", "number_integer"), false);
  assert.equal(sameMetafieldValue("[\"B\",\"A\"]", "[\"A\",\"B\"]", "list.single_line_text_field"), false);
});
