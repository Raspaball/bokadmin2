// supabase/functions/bokbasen/index.ts
// Deploy: supabase functions deploy bokbasen

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { type BokbasenCredentials, getBokbasenCredentials, getBokbasenToken } from "../_shared/bokbasen-auth.ts";
import { extractAvailabilityCode, extractBokgruppekode, extractContributors, extractProductForm, extractPublishingDate } from "../_shared/onix.js";
import { bookFormat } from "../_shared/book-format.ts";
import { chooseValidPrice } from "../_shared/price.ts";

const BOKBASEN_API_BASE = "https://api.bokbasen.io/metadata";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function getUserIdFromJWT(authHeader: string): string | null {
  try {
    const token = authHeader.replace("Bearer ", "");
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

// ── ONIX XML parser ──────────────────────────────────────────────────────────

// Parse multiple <Product> blocks from a single ONIX response
function parseOnixMulti(xmlText: string): BookMetadata[] {
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

function parseOnix(xmlText: string, isbn: string): BookMetadata | null {
  // Strip namespaces for easier parsing
  const xml = xmlText.replace(/\s+xmlns[^"]*"[^"]*"/g, "").replace(/<(\w+:)/g, "<").replace(/<\/(\w+:)/g, "</");
  const stripText = (value: string): string => {
    // 1. Extract CDATA
    let s = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");

    // 2. Decode &lt;/&gt; so entity-encoded HTML becomes real tags for stripping
    s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">");

    // 3. Mark semantic breaks with control-char placeholders BEFORE stripping tags.
    //    \x01 = line break (<br>), \x02 = paragraph break (</p> </li> etc.)
    //    Raw \n/\r in source are XML/HTML source-formatting, NOT semantic — convert to space later.
    s = s
      .replace(/<br\s*\/?>/gi, "\x01")
      .replace(/<\/(p|li|div|h[1-6])>/gi, "\x02")
      .replace(/<[^>]+>/g, "");

    // 4. Source-formatting whitespace (XML line wraps) → single space.
    //    Only the placeholder \x01/\x02 chars carry semantic break info.
    s = s.replace(/[\r\n\t]+/g, " ");

    // 5. Decode named HTML entities (most common typographic chars for Norwegian books)
    s = s
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&nbsp;/gi, " ")
      .replace(/&shy;/gi, "")        // soft hyphen — remove
      .replace(/&zwj;/gi, "")        // zero-width joiner — remove
      .replace(/&zwnj;/gi, "")       // zero-width non-joiner — remove
      .replace(/&laquo;/gi, "«")
      .replace(/&raquo;/gi, "»")
      .replace(/&ldquo;/gi, "\u201C")
      .replace(/&rdquo;/gi, "\u201D")
      .replace(/&lsquo;/gi, "\u2018")
      .replace(/&rsquo;/gi, "\u2019")
      .replace(/&ndash;/gi, "–")
      .replace(/&mdash;/gi, "—")
      .replace(/&hellip;/gi, "…")
      .replace(/&bull;/gi, "•")
      .replace(/&middot;/gi, "·")
      .replace(/&infin;/gi, "∞")
      .replace(/&copy;/gi, "©")
      .replace(/&reg;/gi, "®")
      .replace(/&trade;/gi, "™")
      .replace(/&euro;/gi, "€");

    // 6. Decode numeric HTML entities (&#NNN; and &#xHHH;)
    s = s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
        try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
      })
      .replace(/&#([0-9]+);/g, (_, n) => {
        try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ""; }
      });

    // 7. Remove invisible/control characters that may have been decoded (soft hyphens etc.)
    s = s.replace(/\u00AD/g, "").replace(/\u200B/g, "").replace(/\u200C/g, "").replace(/\u200D/g, "");

    // 8. Restore semantic breaks, clean up whitespace
    return s
      .replace(/\x01/g, "\n")        // <br> → newline
      .replace(/\x02/g, "\n\n")      // </p> etc. → paragraph break
      .replace(/ {2,}/g, " ")        // collapse multiple spaces
      .replace(/ ?\n ?/g, "\n")      // trim spaces around newlines
      .replace(/\n{3,}/g, "\n\n")    // max 2 consecutive newlines
      .trim();
  };

  const get = (tag: string) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return m ? stripText(m[1]) : "";
  };

  const getAll = (tag: string) => {
    const matches = [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))];
    return matches.map(m => m[1].replace(/<[^>]+>/g, "").trim());
  };

  // Title — find product title from DescriptiveDetail TitleDetail TitleType=01,
  // preferring product-level TitleElement (TitleElementLevel=01).
  // Collection blocks are stripped to avoid matching series titles.
  let title = "";
  const ddMatch = xml.match(/<DescriptiveDetail[\s\S]*?<\/DescriptiveDetail>/i);
  if (ddMatch) {
    const ddStripped = ddMatch[0].replace(/<Collection[\s\S]*?<\/Collection>/gi, "");
    const titleDetails = [...ddStripped.matchAll(/<TitleDetail[\s\S]*?<\/TitleDetail>/gi)];
    for (const td of titleDetails) {
      const ttype = td[0].match(/<TitleType[^>]*>(.*?)<\/TitleType>/i)?.[1]?.trim();
      if (ttype !== "01") continue;

      const titleElements = [...td[0].matchAll(/<TitleElement[\s\S]*?<\/TitleElement>/gi)];
      if (titleElements.length) {
        for (const te of titleElements) {
          const level = te[0].match(/<TitleElementLevel[^>]*>(.*?)<\/TitleElementLevel>/i)?.[1]?.trim();
          if (level && level !== "01") continue;
          const prefix = stripText(te[0].match(/<TitlePrefix[^>]*>([\s\S]*?)<\/TitlePrefix>/i)?.[1] || "");
          const withoutPrefix = stripText(te[0].match(/<TitleWithoutPrefix[^>]*>([\s\S]*?)<\/TitleWithoutPrefix>/i)?.[1] || "");
          const titleText = stripText(te[0].match(/<TitleText[^>]*>([\s\S]*?)<\/TitleText>/i)?.[1] || "");
          const subtitle = stripText(te[0].match(/<Subtitle[^>]*>([\s\S]*?)<\/Subtitle>/i)?.[1] || "");
          const baseTitle = (prefix && withoutPrefix)
            ? `${prefix} ${withoutPrefix}`
            : (withoutPrefix || titleText);
          const fullTitle = [baseTitle, subtitle].filter(Boolean).join(": ");
          if (fullTitle) {
            title = fullTitle;
            break;
          }
        }
      }

      if (!title) {
        const titleText = stripText(td[0].match(/<TitleText[^>]*>([\s\S]*?)<\/TitleText>/i)?.[1] || "");
        const subtitle = stripText(td[0].match(/<Subtitle[^>]*>([\s\S]*?)<\/Subtitle>/i)?.[1] || "");
        title = [titleText, subtitle].filter(Boolean).join(": ");
      }

      if (title) {
        break;
      }
    }
  }
  if (!title) {
    const fallbackTitle = get("TitleText");
    const fallbackSubtitle = get("Subtitle");
    title = [fallbackTitle, fallbackSubtitle].filter(Boolean).join(": ");
  }

  // Description — choose best text by type priority (not first block):
  // ONIX 3 TextContent: prefer 03, then 02, then 01
  // ONIX 2 OtherText: prefer 03, then 01, then 02
  let description = "";
  const TEXT_RE = /<Text(?![A-Za-z])[^>]*>([\s\S]*?)<\/Text>/i;
  const ONIX3_DESC_PRIORITY = ["03", "02", "01"];
  const ONIX2_DESC_PRIORITY = ["03", "01", "02"];

  const pickBestText = (blocks: { type: string; text: string }[], priority: string[]) => {
    for (const wanted of priority) {
      const hit = blocks.find(b => b.type === wanted && b.text);
      if (hit) return hit.text;
    }
    const nonReview = blocks.find(b => b.text && !["06", "07", "08", "11", "12", "13", "14"].includes(b.type));
    return nonReview?.text || blocks.find(b => b.text)?.text || "";
  };

  const textContentBlocks = [...xml.matchAll(/<TextContent[\s\S]*?<\/TextContent>/gi)];
  if (textContentBlocks.length) {
    const candidates: { type: string; text: string }[] = [];
    for (const block of textContentBlocks) {
      const type = block[0].match(/<TextType(?![A-Za-z])[^>]*>(.*?)<\/TextType>/i)?.[1]?.trim() || "";
      const textEl = block[0].match(TEXT_RE)?.[1] || "";
      const text = stripText(textEl);
      if (text) candidates.push({ type, text });
    }
    description = pickBestText(candidates, ONIX3_DESC_PRIORITY);
  }

  if (!description) {
    const otherTextBlocks = [...xml.matchAll(/<OtherText[\s\S]*?<\/OtherText>/gi)];
    if (otherTextBlocks.length) {
      const candidates: { type: string; text: string }[] = [];
      for (const block of otherTextBlocks) {
        const type = block[0].match(/<TextTypeCode[^>]*>(.*?)<\/TextTypeCode>/i)?.[1]?.trim() || "";
        const textEl = block[0].match(TEXT_RE)?.[1] || "";
        const text = stripText(textEl);
        if (text) candidates.push({ type, text });
      }
      description = pickBestText(candidates, ONIX2_DESC_PRIORITY);
    }
  }

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

interface BookMetadata {
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

// ── Route handlers ───────────────────────────────────────────────────────────

// GET /bokbasen/isbn/:isbn — fetch full metadata for one ISBN
// Add ?raw=true to get raw ONIX XML for debugging
async function handleIsbnFetch(isbn: string, credentials: BokbasenCredentials | null, raw = false): Promise<Response> {
  const token = await getBokbasenToken(credentials);
  const res = await fetch(`${BOKBASEN_API_BASE}/export/onix/v2/${isbn}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return new Response(JSON.stringify({ error: `Bokbasen returned ${res.status}` }), {
      status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const xml = await res.text();
  if (raw) {
    return new Response(xml, {
      headers: { ...corsHeaders, "Content-Type": "application/xml" },
    });
  }
  const metadata = parseOnix(xml, isbn);
  if (!metadata) {
    return new Response(JSON.stringify({ error: "Could not parse ONIX or format excluded" }), {
      status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(metadata), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// GET /bokbasen/search?q=...&field=isbn|title|author — search Bokbasen
// Note: Bokbasen ONIX export API only supports ISBN lookup, not free-text search.
// For title/author, we return an informative error. For ISBN, we support
// single ISBN and comma/space-separated multi-ISBN queries.
async function handleSearch(query: string, field: string, credentials: BokbasenCredentials | null): Promise<Response> {
  if (field !== "isbn") {
    return new Response(JSON.stringify({
      error: "Bokbasen API støtter kun ISBN-oppslag. Bruk ISBN-feltet for å søke.",
      results: [],
      total: 0,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Support single or multiple ISBNs (comma/space/newline separated)
  const isbns = query
    .split(/[,;\s\n]+/)
    .map(s => s.replace(/[^0-9Xx]/g, ""))
    .filter(s => s.length >= 10);

  if (isbns.length === 0) {
    return new Response(JSON.stringify({ error: "Ingen gyldige ISBN funnet i søket", results: [], total: 0 }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Single ISBN — use direct fetch
  if (isbns.length === 1) {
    return handleIsbnFetch(isbns[0], credentials);
  }

  // Multiple ISBNs — fetch each and return array
  const results: BookMetadata[] = [];
  for (const isbn of isbns) {
    try {
      const token = await getBokbasenToken(credentials);
      const res = await fetch(`${BOKBASEN_API_BASE}/export/onix/v2/${isbn}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parseOnix(xml, isbn);
      if (parsed) results.push(parsed);
    } catch (_) {
      // Skip failed ISBNs
    }
  }

  return new Response(JSON.stringify({ results, total: results.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// GET /bokbasen/date-range?from=YYYY-MM-DD&to=YYYY-MM-DD — fetch books published in date range
async function handleDateRange(from: string, to: string, credentials: BokbasenCredentials | null): Promise<Response> {
  // Convert YYYY-MM-DD to comparable YYYYMMDD strings for filtering
  const fromCompare = from.replace(/-/g, "");  // e.g. "20050101"
  const toCompare = to.replace(/-/g, "");      // e.g. "20061231"

  // Bokbasen's "after" param filters by modification date, not publication date.
  // We use it as a rough lower bound, then filter by actual publication date below.
  const afterTs = fromCompare + "000000";

  const token = await getBokbasenToken(credentials);
  const subscription = credentials?.subscription || "extended";
  const pageSize = 50;
  const maxPages = 100; // 5 000 books max; returns truncated=true if hit

  const allResults: BookMetadata[] = [];
  let nextToken: string | null = null;
  let page = 0;
  let truncated = false;
  let totalFetched = 0;

  while (page < maxPages) {
    const params = new URLSearchParams({
      subscription,
      pagesize: String(pageSize),
    });
    if (nextToken) {
      params.set("next", nextToken);
    } else {
      params.set("after", afterTs);
    }

    const res = await fetch(`${BOKBASEN_API_BASE}/export/onix/v2?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      // 404 or empty means no more data
      if (res.status === 404) break;
      return new Response(JSON.stringify({ error: `Bokbasen returned ${res.status}` }), {
        status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const xml = await res.text();
    const parsed = parseOnixMulti(xml);
    totalFetched += parsed.length;

    // Filter by publication date — only include books published within [from, to]
    for (const book of parsed) {
      const pd = book.publicationDate || book.year || "";
      // Normalize to 8 chars for comparison: "2005" → "20050101", "200506" → "20050601"
      let normalized = pd.replace(/-/g, "");
      if (normalized.length === 4) normalized += "0101";
      else if (normalized.length === 6) normalized += "01";
      else if (normalized.length < 4) continue;  // Not enough data to filter
      normalized = normalized.slice(0, 8);

      if (normalized >= fromCompare && normalized <= toCompare) {
        allResults.push(book);
      }
    }

    // Check for next page token in response headers
    const newNextToken = res.headers.get("Next") || res.headers.get("next");
    if (!newNextToken || newNextToken === nextToken) break; // No more pages
    nextToken = newNextToken;
    page++;

    if (page >= maxPages) {
      truncated = true;
      break;
    }
  }

  return new Response(JSON.stringify({
    results: allResults,
    total: allResults.length,
    totalFetched,
    pages: page + 1,
    truncated,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// POST /bokbasen/enrich-db — fetch bokgruppekode from Bokbasen for all DB books missing it
async function handleEnrichDb(credentials: BokbasenCredentials | null, userId: string | null): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Fetch all ISBNs in our DB that lack bokgruppekode
  const scopeFilter = userId
    ? `&user_id=eq.${encodeURIComponent(userId)}`
    : "&user_id=is.null";
  const listRes = await fetch(
    `${supabaseUrl}/rest/v1/books?select=isbn&bokgruppekode=is.null${scopeFilter}`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
  );
  if (!listRes.ok) throw new Error(`Supabase list failed: ${await listRes.text()}`);
  const missing: { isbn: string }[] = await listRes.json();

  const total = missing.length;
  let updated = 0, failed = 0, noData = 0;

  // Process in batches of 10 (parallel Bokbasen calls)
  const batchSize = 10;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(async ({ isbn }) => {
        const token = await getBokbasenToken(credentials);
        const res = await fetch(`${BOKBASEN_API_BASE}/export/onix/v2/${isbn}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Bokbasen ${res.status}`);
        const xml = await res.text();
        const metadata = parseOnix(xml, isbn);
        if (!metadata?.bokgruppekode) throw new Error("no_data");
        return { isbn, bokgruppekode: metadata.bokgruppekode, varegruppe: metadata.varegruppe };
      })
    );

    // Write successful enrichments back to Supabase
    for (const result of results) {
      if (result.status === "fulfilled") {
        const { isbn, bokgruppekode, varegruppe } = result.value;
        const updateScope = userId
          ? `isbn=eq.${encodeURIComponent(isbn)}&user_id=eq.${encodeURIComponent(userId)}`
          : `isbn=eq.${encodeURIComponent(isbn)}&user_id=is.null`;
        const patch = await fetch(
          `${supabaseUrl}/rest/v1/books?${updateScope}`,
          {
            method: "PATCH",
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ bokgruppekode, varegruppe }),
          }
        );
        patch.ok ? updated++ : failed++;
      } else {
        const msg = String((result as PromiseRejectedResult).reason);
        msg.includes("no_data") ? noData++ : failed++;
      }
    }

    if (i + batchSize < missing.length) {
      await new Promise(r => setTimeout(r, 150));
    }
  }

  return new Response(JSON.stringify({ total, updated, noData, failed }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Main handler ─────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/bokbasen\/?/, "");
    const userId = getUserIdFromJWT(req.headers.get("Authorization") ?? "");
    const credentials = await getBokbasenCredentials(userId);

    // /bokbasen/isbn/9788202693985  (add ?raw=true to get raw ONIX XML)
    const isbnMatch = path.match(/^isbn\/([0-9Xx]+)$/i);
    if (isbnMatch) {
      const raw = url.searchParams.get("raw") === "true";
      return await handleIsbnFetch(isbnMatch[1].replace(/[^0-9Xx]/g, ""), credentials, raw);
    }

    // POST /bokbasen/enrich-db — enrich all books in DB with bokgruppekode from Bokbasen
    if (path === "enrich-db" && req.method === "POST") {
      return await handleEnrichDb(credentials, userId);
    }

    // /bokbasen/date-range?from=2026-01-01&to=2026-01-31
    if (path === "date-range" || path.startsWith("date-range?")) {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      if (!from || !to) return new Response(JSON.stringify({ error: "Missing 'from' and/or 'to' query params (YYYY-MM-DD)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      return await handleDateRange(from, to, credentials);
    }

    // /bokbasen/search?q=hamsun&field=author
    if (path === "search" || path.startsWith("search?")) {
      const q = url.searchParams.get("q") || "";
      const field = url.searchParams.get("field") || "title";
      if (!q) return new Response(JSON.stringify({ error: "Missing query param 'q'" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      return await handleSearch(q, field, credentials);
    }

    // POST /bokbasen/formats — batch ISBN → format lookup
    if (path === "formats" && req.method === "POST") {
      const body = await req.json();
      const isbns: string[] = (body.isbns || []).map((s: string) => s.replace(/[^0-9Xx]/g, "")).filter((s: string) => s.length >= 10);
      if (isbns.length === 0) {
        return new Response(JSON.stringify({ formats: {} }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const FORMAT_MAP: Record<string, string> = {
        BA: "Paperback", BB: "Innbundet", BC: "Heftet", BD: "Løsblad",
        BE: "Spiralbundet", BF: "Pamflett", BG: "Skinninnbundet", BH: "Pekebokbok",
        BI: "Tøybok", BJ: "Badebok", BK: "Aktivitetsbok", BL: "Glidebundet",
        BM: "Storbok", BN: "Hefte", BO: "Utbrettsbok", BP: "Skumbok", BZ: "Annet bokformat",
        AA: "Lyd", AB: "Lydkassett", AC: "CD-lydbok", AJ: "Nedlastbar lydfil",
        AI: "DVD-lyd", AN: "Nedlastbar/online lydfil", AO: "Online lydfil", AM: "LP",
        DA: "Digitalt", DB: "CD-ROM", DI: "DVD-ROM",
        EA: "Digitalt", EB: "E-bok", EC: "Online digital", ED: "Nedlastbar digital",
        CA: "Kart", SA: "Sammensatt produkt",
      };

      const formats: Record<string, string> = {};
      const token = await getBokbasenToken(credentials);

      // Process in batches of 10 to avoid overloading Bokbasen
      const batchSize = 10;
      for (let i = 0; i < isbns.length; i += batchSize) {
        const batch = isbns.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (isbn) => {
            const res = await fetch(`${BOKBASEN_API_BASE}/export/onix/v2/${isbn}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return null;
            const xml = await res.text();
            const codeMatch = xml.match(/<ProductForm[^>]*>([^<]+)<\/ProductForm>/i);
            const code = codeMatch?.[1]?.trim().toUpperCase() || null;
            if (code) {
              formats[isbn] = FORMAT_MAP[code] || code;
            }
          })
        );
        // Small delay between batches
        if (i + batchSize < isbns.length) {
          await new Promise(r => setTimeout(r, 100));
        }
      }

      return new Response(JSON.stringify({ formats }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
