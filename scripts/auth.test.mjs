// node --test scripts/*.test.mjs
// Brukeridentitet i Edge Functions skal alltid verifiseres (supabase/functions/_shared/auth.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";

const root = new URL("../supabase/functions/", import.meta.url);
const functions = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(new URL(`${d.name}/index.ts`, root)))
  .map((d) => d.name);

test("ingen funksjon leser brukeren rett fra tokenet", () => {
  for (const f of functions) {
    const src = readFileSync(new URL(`${f}/index.ts`, root), "utf8");
    assert.doesNotMatch(src, /atob\(/, `${f}: atob() — bruk getCaller() fra _shared/auth.ts`);
    assert.doesNotMatch(src, /getUserIdFromJWT|getEmailFromJWT/, f);
    assert.doesNotMatch(src, /body\.user_id as string/, `${f}: user_id fra body uten kontroll`);
  }
});

test("funksjoner som bruker brukeren, henter den med getCaller()", () => {
  for (const f of ["availability-check", "bokbasen", "book-update", "price-update", "shopify", "sjangre-sync"]) {
    const src = readFileSync(new URL(`${f}/index.ts`, root), "utf8");
    assert.match(src, /await getCaller\(req\)/, f);
  }
});

test("auth.ts verifiserer med auth.getUser", () => {
  const src = readFileSync(new URL("_shared/auth.ts", root), "utf8");
  assert.match(src, /auth\.getUser\(token\)/);
});
