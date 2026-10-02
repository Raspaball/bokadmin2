// node --test scripts/*.test.mjs
// Statusrapporten før live (pakke E del 4): src/app/utils/statusReport.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shopifyAdminUrl, sortStatusChanges, statusChangesCsv } from "../src/app/utils/statusReport.ts";

const row = (over) => ({
  id: "gid://shopify/Product/15402476601622", handle: "h", title: "B", isbn: "9780349140438", code: "40",
  from: "ACTIVE", to: "DRAFT", tilgjengelighet: "ikke_tilgjengelig", own: false, ...over,
});

test("CSV: BOM, semikolon, norske statuser og lenke til Shopify", () => {
  const csv = statusChangesCsv([row({ title: 'Steve Jobs; "the" biography' })], "testbutikk-9434.myshopify.com");
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const [header, line] = csv.slice(1).split("\r\n");
  assert.equal(header, "Tittel;ISBN;ONIX-kode;Gammel status;Ny status (regelen);Tilgjengelighet;Egen tilgjengelighet;Handle;Shopify");
  assert.equal(line, '"Steve Jobs; ""the"" biography";9780349140438;40;aktiv;utkast;ikke_tilgjengelig;nei;h;https://testbutikk-9434.myshopify.com/admin/products/15402476601622');
});

test("egen tilgjengelighet merkes og sorteres sist; utkast før aktiv", () => {
  const rows = [row({ title: "C", own: true }), row({ title: "A", from: "DRAFT", to: "ACTIVE" }), row({ title: "B" })];
  assert.deepEqual(sortStatusChanges(rows).map((r) => r.title), ["B", "A", "C"]);
  assert.match(statusChangesCsv(rows), /;ja \(endres ikke\);/);
});

test("uten butikkdomene: GID i stedet for lenke, ingen kode → (ingen)", () => {
  assert.equal(shopifyAdminUrl(null, "gid://shopify/Product/1"), null);
  assert.match(statusChangesCsv([row({ code: "" })]), /;\(ingen\);.*;gid:\/\/shopify\/Product\/15402476601622\r\n$/);
});
