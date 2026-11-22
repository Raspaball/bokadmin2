// supabase/functions/_shared/onix-book.ts
// ONIX → BookMetadata (det Import-siden og «Bokbasen ny» viser og lagrer i `books`).
// Flyttet uendret fra bokbasen/index.ts 22.11.2026, slik at bokbasen/ og bokbasen-ny/
// bruker samme tolker. Reglene (pris, forfatter, format, tilgjengelighet) ligger fortsatt
// i onix.js, price.ts og book-format.ts.

import {
  extractAvailabilityCode, extractBokgruppekode, extractContributors, extractDescription, extractProductForm,
  extractPublishingDate, extractTitle, onixText,
} from "./onix.js";
import { bookFormat } from "./book-format.ts";
import { chooseValidPrice } from "./price.ts";

// ── ONIX XML parser ──────────────────────────────────────────────────────────

// Parse multiple <Product> blocks from a single ONIX response
export function parseOnixMulti(xmlText: string): BookMetadata[] {
  const cleaned = xmlText.replace(/\s+xmlns[^"]*"[^"]*"/g, "").replace(/<(\w+:)/g, "<").replace(/<\/(\w+:)/g, "</");
  const products = [...cleaned.matchAll(/<Product[\s\S]*?<\/Product>/gi)];
  const results: BookMetadata[] = [];
  for (const p of products) {
    // Extract ISBN from ProductIdentifier (IDType 15 = ISBN-13, 02 = ISBN-10)
    let isbn = "";
    const ids = [...p[0].matchAll(/<ProductIdentifier[\s\S]*?<\/ProductIdentifier>/gi)];
    for (const id of ids) {
      const idType = id[0].match(/<ProductIDType[^>]*>(.*?)<\/ProductIDType>/i)?.[1]?.trim();
      const idVal = id[0].match(/<IDValue[^>]*>(.*?)<\/IDValue>/i)?.[1]?.trim();
      if (idType === "15" && idVal) { isbn = idVal; break; }
      if (idType === "02" && idVal && !isbn) isbn = idVal;
    }
    if (!isbn) continue;
    const parsed = parseOnix(p[0], isbn);
    if (parsed) results.push(parsed);
  }
  return results;
}

export function parseOnix(xmlText: string, isbn: string): BookMetadata | null {
  // Strip namespaces for easier parsing
  const xml = xmlText.replace(/\s+xmlns[^"]*"[^"]*"/g, "").replace(/<(\w+:)/g, "<").replace(/<\/(\w+:)/g, "</");
  // Ren tekst fra et ONIX-felt: felles regel i _shared/onix.js (onixText)
  const stripText = onixText;

  const get = (tag: string) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return m ? stripText(m[1]) : "";
  };

  const getAll = (tag: string) => {
    const matches = [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))];
    return matches.map(m => m[1].replace(/<[^>]+>/g, "").trim());
  };

  // Tittel og forlagstekst: felles lesing i _shared/onix.js (flyttet uendret dit i pakke B)
  const title = extractTitle(xml);
  const description = extractDescription(xml);

  // Publisher
  const publisher = get("PublisherName");

  // Year — prefer PublishingDateRole 01, fall back to PublicationDate
  let year = "";
  let publicationDate = ""; // Full date string YYYYMMDD or YYYY
  const pubDates = [...xml.matchAll(/<PublishingDate[\s\S]*?<\/PublishingDate>/gi)];
  for (const pd of pubDates) {
    const role = pd[0].match(/<PublishingDateRole[^>]*>(\d+)<\/PublishingDateRole>/i);
    const date = pd[0].match(/<Date[^>]*>(\d+)<\/Date>/i);
    if (role?.[1] === "01" && date?.[1]) {
      const raw = date[1];
      const y = raw.length >= 4 ? raw.slice(0, 4) : raw;
      if (parseInt(y) <= new Date().getFullYear()) {
        year = y;
        publicationDate = raw;
      }
      break;
    }
  }
  if (!year) {
    const pubDate = get("PublicationDate");
    if (pubDate) {
      year = pubDate.slice(0, 4);
      publicationDate = pubDate;
    }
  }

  // Format
  const formCode = get("ProductForm").toUpperCase();
  // Excluded formats: non-book media, hardware, film, licenses, microfiche, misc physical
  // Note: AB (CD-lydbok), AI (Strømmet lydbok), DA (Lydfil), EB (E-bok) are ALLOWED
  // — filtering by format is handled in the frontend Import component
  const excludedFormats = new Set(["00","AC","AD","AE","AF","AG","AH","AJ","AK","AL","AM","AN","AO","AZ","DE","DF","DJ","DK","DL","DM","DN","DO","DZ","EA","EC","ED","FA","FC","FD","FE","FF","FZ","LA","LB","LC","MA","MB","MC","MZ","VA","VF","VI","VJ","VK","VL","VM","VN","VO","VP","VQ","VZ"]);
  if (formCode && excludedFormats.has(formCode)) return null;

  const formatMap: Record<string, string> = {
    // Bøker
    BA: "Paperback", BB: "Innbundet", BC: "Heftet", BD: "Løsblad",
    BE: "Spiralbundet", BF: "Pamflett", BG: "Skinninnbundet", BH: "Pekebokbok",
    BI: "Tøybok", BJ: "Badebok", BK: "Aktivitetsbok", BL: "Glidebundet",
    BM: "Storbok", BN: "Hefte (del av serie)", BO: "Utbrettsbok", BP: "Skumbok",
    BZ: "Annet bokformat",
    // Lyd
    AA: "Lyd", AB: "Lydkassett", AC: "CD-lydbok", AD: "DAT",
    AE: "Lydplate", AF: "Lydbånd", AG: "MiniDisc", AH: "CD-Extra",
    AI: "DVD-lyd", AJ: "Nedlastbar lydfil", AK: "Lydspiller",
    AL: "SD-kort lyd", AM: "LP", AN: "Nedlastbar/online lydfil",
    AO: "Online lydfil", AZ: "Annet lydformat",
    // Digitalt
    DA: "Digitalt (fysisk)", DB: "CD-ROM", DC: "CD-i", DI: "DVD-ROM",
    EA: "Digitalt (elektronisk)", EB: "E-bok", EC: "Online digital", ED: "Nedlastbar digital",
    // Kart
    CA: "Kart", CB: "Falset kart", CC: "Flatt kart", CD: "Rullet kart", CE: "Globus",
    // Sammensatt
    SA: "Sammensatt produkt", SB: "Sammensatt (boks)", SC: "Sammensatt (kassett)",
  };
  const format = formatMap[formCode] || formCode;
  // bok.format og productType etter den godkjente listen (_shared/book-format.ts).
  // `format` over er fortsatt etiketten importfilteret på Import-siden bruker.
  const { form: pf, details: pfd } = extractProductForm(xml);
  const { format: bookFormatLabel, productType } = bookFormat(pf, pfd);

  // Forfatterne som liste «Fornavn Etternavn» i rekkefølge (A01, ellers første
  // bidragsyter med rollen i authorRole). Felles lesing i _shared/onix.js.
  const { authors, role: authorRole } = extractContributors(xml);

  // Pris: samme regel som prisjobben (NOK, Norge, gyldig i dag), 0 eller lavere gir null (se _shared/price.ts)
  const { price, reason: priceReason } = chooseValidPrice(xml);

  // Image URL — ONIX 3: <SupportingResource> with ResourceContentType 01
  // ONIX 2: <MediaFile> with MediaFileTypeCode 04 (front cover)
  // Use (?![A-Za-z]) lookaheads to avoid matching longer tag names (e.g. ResourceLinkTypeCode,
  // MediaFileLinkTypeCode) that share the same prefix.
  let imageUrl = "";
  const resources = [...xml.matchAll(/<SupportingResource[\s\S]*?<\/SupportingResource>/gi)];
  for (const r of resources) {
    const type = r[0].match(/<ResourceContentType(?![A-Za-z])[^>]*>(.*?)<\/ResourceContentType>/i)?.[1];
    if (type === "01") {
      const link = r[0].match(/<ResourceLink(?![A-Za-z])[^>]*>(.*?)<\/ResourceLink>/i)?.[1];
      if (link) { imageUrl = link; break; }
    }
  }
  // ONIX 2.1 fallback: <MediaFile> with <MediaFileTypeCode>04</MediaFileTypeCode>
  if (!imageUrl) {
    const mediaFiles = [...xml.matchAll(/<MediaFile[\s\S]*?<\/MediaFile>/gi)];
    for (const mf of mediaFiles) {
      const type = mf[0].match(/<MediaFileTypeCode[^>]*>(.*?)<\/MediaFileTypeCode>/i)?.[1];
      if (type === "04") {
        const link = mf[0].match(/<MediaFileLink(?![A-Za-z])[^>]*>(.*?)<\/MediaFileLink>/i)?.[1];
        if (link) { imageUrl = link; break; }
      }
    }
  }

  // Subjects — single pass for all subject-based fields
  let genre = "";
  const bokgruppekode = extractBokgruppekode(xml) ?? "";  // skjema 37, se _shared/onix.js
  let varegruppe = "";     // SubjectSchemeIdentifier 38 = Norsk varegruppe
  const subjects = [...xml.matchAll(/<Subject[\s\S]*?<\/Subject>/gi)];
  for (const s of subjects) {
    const scheme = s[0].match(/<SubjectSchemeIdentifier[^>]*>(.*?)<\/SubjectSchemeIdentifier>/i)?.[1];
    const code = s[0].match(/<SubjectCode[^>]*>(.*?)<\/SubjectCode>/i)?.[1] || "";
    if (scheme === "38" && code) varegruppe = code;
    if (!genre) {
      if (scheme === "93") {
        if (code.startsWith("YF")) genre = "Barn og ungdom/Skjønnlitteratur";
        else if (code.startsWith("YN")) genre = "Barn og ungdom/Sakprosa";
      } else if (scheme === "10" && code.startsWith("JUV")) {
        genre = code.toUpperCase().includes("NONFICTION") ? "Barn og ungdom/Sakprosa" : "Barn og ungdom/Skjønnlitteratur";
      }
    }
  }

  // Series name (CollectionType 10) — kept in bokgruppe field
  let bokgruppe = "";
  const collections = [...xml.matchAll(/<Collection[\s\S]*?<\/Collection>/gi)];
  for (const c of collections) {
    const ctype = c[0].match(/<CollectionType[^>]*>(.*?)<\/CollectionType>/i)?.[1];
    if (ctype === "10") {
      bokgruppe =
        c[0].match(/<TitleOfSeries[^>]*>(.*?)<\/TitleOfSeries>/i)?.[1]?.trim() ||
        c[0].match(/<TitleText[^>]*>(.*?)<\/TitleText>/i)?.[1]?.trim() || "";
      if (bokgruppe) break;
    }
  }

  // Weight (MeasureType 08)
  let vekt = "";
  const measures = [...xml.matchAll(/<Measure[\s\S]*?<\/Measure>/gi)];
  for (const m of measures) {
    const mtype = m[0].match(/<MeasureType[^>]*>(.*?)<\/MeasureType>/i)?.[1];
    if (mtype === "08") {
      vekt = m[0].match(/<Measurement[^>]*>(.*?)<\/Measurement>/i)?.[1]?.trim() || "";
      break;
    }
  }

  // Tilgjengelighet (ONIX List 65) og hel utgivelsesdato: felles lesing i _shared/onix.js.
  // publishingDate (YYYY-MM-DD) settes som bok.utgivelsesdato ved push. Den finnes
  // også for kommende bøker, i motsetning til year/publicationDate over.
  const availability = extractAvailabilityCode(xml) ?? "";
  const publishingDate = extractPublishingDate(xml);

  if (!title) return null;

  return {
    isbn,
    title,
    // Visningstekst. Handle og bok.forfatter bruker listen (authors).
    author: authors.join(", "),
    authors,
    authorRole,
    bookFormat: bookFormatLabel,
    productType,
    publisher,
    year,
    publicationDate: publicationDate || null,
    format,
    price,
    priceReason,
    description,
    imageUrl,
    genre,
    bokgruppe,
    bokgruppekode,
    varegruppe,
    vekt: vekt ? parseFloat(vekt) : null,
    availability: availability || null,
    publishingDate,
  };
}

export interface BookMetadata {
  isbn: string;
  title: string;
  author: string;
  authors: string[]; // «Fornavn Etternavn» i rekkefølge (extractContributors)
  authorRole: string | null; // A01, eller rollen til første bidragsyter når A01 mangler
  bookFormat: string; // bok.format (Innbundet, Heftet, Pocket …)
  productType: string; // Bok / Lydbok / E-bok
  publisher: string;
  year: string;
  publicationDate: string | null;
  format: string;
  price: number | null;
  priceReason: string | null; // årsak når price er null (choosePrice), f.eks. «ingen NOK-pris»
  description: string;
  imageUrl: string;
  genre: string;
  bokgruppe: string;
  bokgruppekode: string;
  varegruppe: string;
  vekt: number | null;
  availability: string | null;
  publishingDate: string | null; // YYYY-MM-DD (extractPublishingDate)
}
