// Vanlig push (shopify/push-bulk) av bøkene i en meta-fil. node push.mjs <meta.json> <ut.json> [utelat-isbn,...]
import { readFileSync, writeFileSync } from "node:fs";
const BASE = "https://chwpqwblqummlufqdefe.supabase.co/functions/v1/";
const ANON = readFileSync("scripts/out/fn.mjs","utf8").match(/ANON = "([^"]+)"/)[1];
const [metaf, outf, skip = ""] = process.argv.slice(2);
const books = JSON.parse(readFileSync(metaf,"utf8")).map(x => x.meta).filter(m => m?.isbn && !skip.split(",").includes(m.isbn));
const results = [];
for (let i = 0; i < books.length; i += 3) {
  const r = await fetch(BASE + "shopify/push-bulk", { method: "POST", headers: { Authorization: `Bearer ${ANON}`, apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ books: books.slice(i, i + 3) }) });
  const j = await r.json().catch(() => null);
  if (!j?.results) { console.log("feil", r.status, JSON.stringify(j).slice(0, 300)); break; }
  results.push(...j.results);
}
writeFileSync(outf, JSON.stringify(results, null, 1));
for (const x of results) console.log(x.isbn, x.success, x.created ? "NY" : "eksisterte", x.status ?? "", x.handle ?? "", x.error ?? "", [x.priceNote,x.availabilityNote,x.seoNote,x.descriptionNote,x.tagNote,x.warning,x.skipNote].filter(Boolean).join(" | "));
