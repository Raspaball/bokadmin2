import test from "node:test";
import assert from "node:assert/strict";
import { checkShopAllowed, SAFE_SHOPS } from "../supabase/functions/_shared/shop-guard.js";

const NOW = Date.parse("2026-11-01T08:00:00Z");
const LIVE = "bo-bok-og-papir.myshopify.com";
const inHours = (h) => new Date(NOW + h * 3600e3).toISOString();

test("Testbutikk er alltid tillatt", () => {
  assert.deepEqual(checkShopAllowed({ domain: SAFE_SHOPS[0], now: NOW }), { ok: true, live: false });
  assert.equal(checkShopAllowed({ domain: "TESTBUTIKK-9434.myshopify.com", now: NOW }).ok, true);
});
test("tomt domene stoppes", () => {
  assert.equal(checkShopAllowed({ domain: "", now: NOW }).ok, false);
  assert.equal(checkShopAllowed({ domain: undefined, now: NOW }).ok, false);
});
test("live uten bekreftelse stoppes", () => {
  const r = checkShopAllowed({ domain: LIVE, now: NOW });
  assert.equal(r.ok, false); assert.equal(r.live, true); assert.match(r.reason, /LIVE_SHOP_CONFIRMED/);
});
test("bekreftelse for en annen butikk stoppes", () => {
  assert.equal(checkShopAllowed({ domain: LIVE, confirmed: "testbutikk-9434.myshopify.com", until: inHours(2), now: NOW }).ok, false);
  assert.equal(checkShopAllowed({ domain: LIVE, confirmed: "bo-bok-og-papir", until: inHours(2), now: NOW }).ok, false);
});
test("bekreftet, men uten tidsvindu", () => {
  const r = checkShopAllowed({ domain: LIVE, confirmed: LIVE, now: NOW });
  assert.equal(r.ok, false); assert.match(r.reason, /LIVE_SHOP_UNTIL/);
  assert.equal(checkShopAllowed({ domain: LIVE, confirmed: LIVE, until: "i morgen", now: NOW }).ok, false);
});
test("utløpt vindu stoppes", () => {
  const r = checkShopAllowed({ domain: LIVE, confirmed: LIVE, until: inHours(-1), now: NOW });
  assert.equal(r.ok, false); assert.match(r.reason, /utløpt/);
});
test("vindu over 24 timer stoppes", () => {
  assert.equal(checkShopAllowed({ domain: LIVE, confirmed: LIVE, until: inHours(25), now: NOW }).ok, false);
});
test("bekreftet og innenfor vinduet er tillatt", () => {
  const r = checkShopAllowed({ domain: LIVE, confirmed: ` ${LIVE.toUpperCase()} `, until: inHours(6), now: NOW });
  assert.equal(r.ok, true); assert.equal(r.live, true); assert.equal(r.expiresAt, inHours(6));
});
