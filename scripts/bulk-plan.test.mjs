// node --test scripts/*.test.mjs
// Pakke H del 1: planfasen i små porsjoner (hopp til byte-posisjon, selvjustering, stopp etter fem forsøk).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { streamJsonlFrom } from "../supabase/functions/_shared/shopify-bulk.ts";
import { BulkProductAssembler } from "../supabase/functions/_shared/book-bulk.ts";
import { beginPlanSlice, PLAN_CHUNK_MIN, PLAN_CHUNK_START, PLAN_MAX_ATTEMPTS } from "../supabase/functions/_shared/bulk-job.ts";

const N = 53;
const lines = [];
for (let i = 0; i < N; i++) {
  lines.push(JSON.stringify({ id: `gid://shopify/Product/${i}`, handle: `bok-æøå-${i}`, tags: [] }));
  lines.push(JSON.stringify({ id: `gid://shopify/ProductVariant/${i}`, __typename: "ProductVariant", __parentId: `gid://shopify/Product/${i}`, sku: `${i}` }));
  lines.push(JSON.stringify({ id: `gid://shopify/Metafield/${i}`, __parentId: `gid://shopify/Product/${i}`, key: "isbn" }));
}
const body = Buffer.from(lines.join("\n") + "\n");

async function withServer(range, fn) {
  const server = createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (range && m) {
      res.writeHead(206);
      res.end(body.subarray(Number(m[1])));
    } else { res.writeHead(200); res.end(body); }
  });
  await new Promise((r) => server.listen(0, r));
  try { await fn(`http://127.0.0.1:${server.address().port}/f.jsonl`); } finally { server.close(); }
}

// Leser hele fila i porsjoner på `size` slik readPlanSlice gjør det
async function readAll(url, size) {
  const seen = [];
  let planIndex = 0, planByte = 0;
  while (planIndex < N) {
    const to = Math.min(N, planIndex + size);
    const a = new BulkProductAssembler((i) => i >= planIndex && i < to, false, planIndex);
    let stopAt = null;
    const end = await streamJsonlFrom(url, planByte, (line, start) => { a.add(line); if (a.count > to) { stopAt = start; return true; } });
    for (const p of a.products) { seen.push(p.handle); assert.equal(p.variants.nodes.length, 1); }
    planIndex = to; planByte = stopAt ?? end;
  }
  return seen;
}
const expected = Array.from({ length: N }, (_, i) => `bok-æøå-${i}`);

for (const range of [true, false]) {
  test(`porsjoner dekker hele fila uten hull eller doble (Range ${range ? "støttes" : "ignoreres"})`, async () => {
    await withServer(range, async (url) => {
      for (const size of [1, 7, 10, 52, 53, 150]) assert.deepEqual(await readAll(url, size), expected, `size ${size}`);
    });
  });
}

test("første og andre forsøk bruker samme størrelse, så halveres den", () => {
  const s = { planIndex: 300 };
  assert.equal(beginPlanSlice(s).size, PLAN_CHUNK_START);
  assert.equal(beginPlanSlice(s).size, PLAN_CHUNK_START); // 2. forsøk
  assert.equal(beginPlanSlice(s).size, PLAN_CHUNK_START / 2); // 3. forsøk = to feil
  assert.equal(beginPlanSlice(s).size, 37);
  assert.equal(beginPlanSlice(s).size, 18);
  const stuck = beginPlanSlice(s); // 6. forsøk = etter fem
  assert.ok(stuck.stuck?.includes("feilet 5 ganger"));
  assert.ok(PLAN_MAX_ATTEMPTS === 5 && PLAN_CHUNK_MIN <= 18);
});

test("fullført porsjon nullstiller tellingen; ny planIndex starter på nytt", () => {
  const s = { planIndex: 0 };
  beginPlanSlice(s); beginPlanSlice(s);
  s.attempt = undefined; s.planIndex = 150; // lagret ferdig
  assert.equal(beginPlanSlice(s).size, PLAN_CHUNK_START);
  assert.equal(s.attempt.n, 1);
  s.planIndex = 300; // annen porsjon, markøren gjelder ikke
  assert.equal(beginPlanSlice(s).size, PLAN_CHUNK_START);
  assert.equal(s.attempt.n, 1);
});

test("størrelsen går aldri under minimum", () => {
  const s = { planIndex: 5, chunk: 12 };
  for (let i = 0; i < 4; i++) beginPlanSlice(s);
  assert.equal(s.chunk, PLAN_CHUNK_MIN);
});
