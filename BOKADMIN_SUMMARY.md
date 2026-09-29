# Bokadmin — Project Summary (for reuse in other projects)

Snapshot: 2026-09-29, branch `utvikling`. Source of truth is the code in this repo; this file condenses what another project needs to know, with most detail on the **Bokbasen API**, since that is the least documented part publicly.

---

## 1. What Bokadmin is

A Norwegian bookstore admin tool (in production for bobokogpapir.no). It:

1. Pulls book metadata (ONIX XML) from **Bokbasen**, the Norwegian book-trade metadata hub.
2. Stores selected books in a **Supabase** Postgres DB (`books` table = a "work list").
3. Pushes them as products to **Shopify** (Admin GraphQL API 2025-01).
4. Runs background jobs that keep Shopify in sync with Bokbasen: **prices**, **availability → product status**, and **genre collections** (bokgruppekode → Smart Collections + menu).

```
Bokbasen (ONIX over REST, OAuth2 client-credentials)
    → Supabase Edge Functions (Deno) parse XML → JSON
        → Supabase DB (books, jobs, sync_log, …)
            → Shopify Admin GraphQL 2025-01
```

## 2. Tech stack and layout

| Layer | Tech | Where |
|---|---|---|
| Frontend | React + TypeScript + Vite + Tailwind + shadcn/ui | `src/app/` |
| API wrapper | Supabase JS client + `callEdgeFunction()` | `src/app/utils/api.ts` |
| Backend | Supabase Edge Functions (Deno) | `supabase/functions/<name>/index.ts` |
| DB | Supabase Postgres + RLS + pg_cron | `supabase/migrations/` |
| Auth | Supabase Auth (email/password) | `src/app/App.tsx` |

Frontend pages (chosen by a sidebar string in `ContentArea.tsx`): `Import` (ISBN lookup, CSV import, date-range extraction, push to Shopify), `Oppdatering` (price and availability jobs), `Sjangre` (genre collections), `ShopifyKatalog` (catalog browser with inline editing), `Feeder` (manual Shopify collections with drag-and-drop ordering), `Innstillinger` (credentials).

Edge Functions:

| Function | Purpose |
|---|---|
| `bokbasen` | ISBN lookup, multi-ISBN search, date-range export, `enrich-db`, batch format lookup |
| `shopify` | Push single/bulk, catalog, CSV export, Smart Collections, menu builder, feeds |
| `price-update` | Long-running job: Bokbasen price → Shopify variant price |
| `availability-check` | Long-running job: ONIX availability → Shopify ACTIVE/DRAFT/ARCHIVED |
| `sjangre-sync` | Long-running job: fetch bokgruppekode → tag products → create Smart Collections |

Deploy: `supabase functions deploy <name> --no-verify-jwt` (the function decodes the JWT itself).

**Tenancy:** it was built multi-tenant (`user_settings` table with per-user Shopify and Bokbasen credentials, `user_id` on every table, RLS `auth.uid() = user_id`). A pending migration (`20260922000000_revert_to_single_tenant_rls.sql`) moves back to "any authenticated user has full access", because the tool now serves one shop. Credential lookup still works like this: JWT `sub` → `user_settings` row → fallback to env vars (`BOKBASEN_CLIENT_ID`, `BOKBASEN_CLIENT_SECRET`, `BOKBASEN_SUBSCRIPTION`, `SHOPIFY_*`).

---

## 3. Bokbasen API — how it works

### 3.1 What you get and what you don't

- Bokbasen delivers **ONIX XML** (the book-trade standard, EDItEUR). Responses can be ONIX 3.0 or ONIX 2.1 style; the parser handles both, including short-tag variants (`<b067>`) in one place.
- **Lookup is by ISBN only.** There is **no free-text search** by title or author. To look up several ISBNs, loop and make one request per ISBN.
- A **bulk/feed export** exists, filtered by **modification date** (`after=`), not by publication date, and paginated with a `Next` response header.

### 3.2 Authentication (OAuth2 client credentials)

You get a `client_id` and `client_secret` from Bokbasen, plus a **subscription** level (Bokadmin uses `extended`).

```http
POST https://auth.bokbasen.io/oauth/token
Content-Type: application/json

{
  "client_id": "<id>",
  "client_secret": "<secret>",
  "audience": "https://api.bokbasen.io/metadata/",
  "grant_type": "client_credentials"
}
```

Response: `{ "access_token": "...", "expires_in": <seconds>, ... }`.

Bokadmin **caches the token in memory** per `clientId:clientSecret` and refreshes it 60 s before expiry:

```ts
const expiry = Date.now() + (data.expires_in - 60) * 1000;
```

Send it as `Authorization: Bearer <token>` on every API call.

> ⚠️ **Inconsistency in the codebase:** `sjangre-sync` uses a different variant: `https://login.bokbasen.io/oauth/token`, form-encoded body, `audience: "https://api.bokbasen.io/"`, and endpoint `https://api.bokbasen.io/onix/v2/{isbn}`. **Use the variant above** (`auth.bokbasen.io` + audience `…/metadata/` + `/metadata/export/onix/v2`). All the other functions use it, and it is listed as the canonical one.

### 3.3 Endpoints

Base: `https://api.bokbasen.io/metadata`

**Single ISBN**

```http
GET /export/onix/v2/{isbn}
Authorization: Bearer <token>
```

- Returns ONIX XML for one product. A non-2xx status means not found or no access.
- This one call is the source for **everything**: metadata, price, availability and genre code. The price and availability jobs call it once per product.

**Bulk export (feed, cursor-paginated)**

```http
GET /export/onix/v2?subscription=extended&pagesize=50&after=YYYYMMDDHHMMSS
GET /export/onix/v2?subscription=extended&pagesize=50&next=<token>
```

- First request: `after=<timestamp>` (e.g. `20260101000000`). This filters on **last modified**, ascending.
- Read the **`Next` response header**. Pass it as `next=` on the following request, without `after`.
- Stop when `Next` is missing, when it equals the previous token, or on 404.
- The response contains many `<Product>` blocks, so split them and parse each one.
- To get "books **published** between X and Y", Bokadmin uses `after=X` as a rough lower bound and then **filters client-side on publication date**. Because this is a modification-date feed, you may page through a lot of irrelevant products. Bokadmin fetches 3 pages (150 books) per call. The frontend loops and stops after 5 batches in a row with no matches.

### 3.4 ONIX parsing: fields and rules

Bokadmin parses with regex after removing namespaces and prefixes (`xmlns…`, `onix:`). This is crude but has held up in production. For a new project, a real XML parser is cleaner, but keep these **selection rules**:

| Field | ONIX source | Rule |
|---|---|---|
| **ISBN** | `ProductIdentifier` | `ProductIDType` **15** = ISBN-13 (preferred), **02** = ISBN-10 |
| **Title** | `DescriptiveDetail/TitleDetail` with `TitleType=01` | Remove `<Collection>` blocks first, otherwise you get the series title. Prefer `TitleElementLevel=01`. Use `TitlePrefix + TitleWithoutPrefix`, else `TitleText`. Append `": " + Subtitle` |
| **Author(s)** | `Contributor` with `ContributorRole=A01` | `PersonName` → `PersonNameInverted` → `NamesBeforeKey + KeyNames`. Join with `", "` |
| **Publisher** | `PublisherName` | — |
| **Publication date** | `PublishingDate` with `PublishingDateRole=01` → `Date` | Fallback `PublicationDate` (ONIX 2). Format `YYYY`, `YYYYMM` or `YYYYMMDD` |
| **Format** | `ProductForm` (ONIX List 150) | See 3.5 |
| **Description** | ONIX 3 `TextContent/TextType`, ONIX 2 `OtherText/TextTypeCode` | Don't take the first block. Priority for ONIX 3: 03 → 02 → 01. For ONIX 2: 03 → 01 → 02. Then any text that is not a review (06, 07, 08, 11–14) |
| **Cover image** | ONIX 3 `SupportingResource` with `ResourceContentType=01` → `ResourceLink` | ONIX 2 fallback: `MediaFile` with `MediaFileTypeCode=04` → `MediaFileLink` |
| **Price** | `Price/PriceType` + `PriceAmount` | See 3.6. Don't take the first block |
| **Availability** | `SupplyDetail/ProductAvailability` (ONIX List 65) | First `SupplyDetail` with a value. See 3.7 |
| **Bokgruppekode** | `Subject` with `SubjectSchemeIdentifier=37` → `SubjectCode` | Norwegian 1–3 digit genre code. ⚠️ `sjangre-sync` looks for scheme **23** instead. Check against real XML (`?raw=true`) before relying on either |
| **Varegruppe** | `Subject` with scheme **38** | Norwegian product group |
| **Children's genre** | scheme 93 (Thema) `YF*`/`YN*`, or scheme 10 (BISAC) `JUV*` | Fiction vs. non-fiction for children and young adults |
| **Series** | `Collection` with `CollectionType=10` | `TitleOfSeries` or `TitleText` |
| **Weight** | `Measure` with `MeasureType=08` | `Measurement` (grams) |

**Text cleanup** (descriptions are often HTML inside CDATA, or entity-encoded HTML):

1. Unwrap CDATA and decode `&lt;`/`&gt;` into real tags.
2. Before stripping tags, mark `<br>` as a line break and `</p>`, `</li>`, `</div>`, `</hN>` as paragraph breaks.
3. Collapse raw `\r\n\t` to spaces. These come from XML formatting and carry no meaning.
4. Decode named entities (`&laquo;` → «, `&ndash;`, `&hellip;`, and so on) and numeric entities (`&#NNN;`, `&#xHH;`).
5. Remove soft hyphens and zero-width characters (U+00AD, U+200B–U+200D).
6. Allow at most 2 newlines in a row.

**Debugging tip:** Bokadmin's `GET /bokbasen/isbn/{isbn}?raw=true` returns the raw ONIX. Always look at real XML before writing a parser rule.

### 3.5 Formats (ONIX List 150, `ProductForm`)

| Code | Label |
|---|---|
| BA | Paperback |
| BB | Innbundet (hardcover) |
| BC | Heftet |
| **BD** | **Løsblad** (loose-leaf) |
| **BE** | **Spiralbundet** (spiral-bound) |
| BH | Pekebok (board book) |
| AC / AJ / AN | Audio (CD / download) |
| EB / ED | E-book / downloadable |

`BD` is **not** spiral-bound. That mix-up was a real bug here. Bokadmin excludes non-book media (film, hardware, licences and so on) in the parser, and the user filters by format in the UI.

### 3.6 Price (ONIX List 58) — Norwegian fixed-price law

Norway has had a book fixed-price law since 1 January 2024, and Bokbasen sends fixed-price codes. Books have 0% VAT, so the amounts excluding and including VAT are equal. **Loop over all `<Price>` blocks and pick by priority:**

1. **04**: fixed price incl. VAT (legally binding, highest priority)
2. **03**: fixed price excl. VAT
3. **02**: recommended retail price incl. VAT
4. **01**: recommended retail price excl. VAT
5. Fallback: any block that has an amount

Reject prices ≤ 0. The job logs these and does not write them to the shop. Reference: https://ns.editeur.org/onix/nb/58 and Bokbasen's page "Fixed prices in Onix from Bokbasen".

> Note: the `bokbasen/` lookup function still uses the older rule (first block with 01/02). `price-update` has the correct priority. Reuse the `price-update` version.

### 3.7 Availability (ONIX List 65) → shop status

| Shopify status | Codes | Meaning |
|---|---|---|
| **ACTIVE** | 20, 21, 22, 23 | available, in stock, to order, POD |
| **ARCHIVED** | 43, 46, 49 | only the truly permanent ones: no longer supplied, withdrawn, recalled |
| **DRAFT** | everything else | 01, 09–12 (not yet published); 30–34 (temporarily unavailable or reprinting); 40–42; **44** (order direct, *not* permanent); **45** (not sold separately, *not* permanent); 47, 48, 50–52; 97–99 (unknown) |

Canonical mapping: `src/app/utils/availabilityCodes.ts`. Reference: https://ns.editeur.org/onix/nb/65

### 3.8 Rate and throughput

- Bokadmin makes parallel calls **10 at a time**, with a 100–150 ms pause between batches. This has not caused throttling.
- A single lookup takes about 1–2 s. In a 45 s Edge Function window you can process about 30–45 ISBNs. This limit shapes the whole job architecture (section 4).
- If you get a 401 in the middle of a job, drop the cached token and fetch a new one.

---

## 4. Long-running job pattern (Supabase Edge Functions)

Edge Functions time out (~45 s is used as the budget), so jobs run in **pulses**:

- A `jobs` row holds `status` (`running`/`paused`/`completed`/`failed`), `cursor`, `config` (JSON with counters and `mode`), and `user_id`.
- `processBatch(jobId)` reads the job, fetches one Shopify page (250 products, query `status:active OR status:draft OR status:archived`, **otherwise you only get ACTIVE products**) and processes products until the time budget runs out. It then saves state and sets `paused`.
- **On timeout, save the start cursor of the current page, not `page.endCursor`.** Saving `endCursor` silently skipped about 200 of every 250 products; this was a real bug. Re-processing is idempotent because each product compares values before writing.
- **pg_cron** calls `/<fn>/resume-paused` every minute with the anon key. That endpoint must pick up **any** paused job. It must not filter to `user_id IS NULL`, or user-owned jobs never finish once the browser tab is closed.
- Errors: HTTP 401/403 → `failed` (no endless retry loop). Other errors → `paused` (retried by the next pulse).
- Cancel: `POST /cancel/:jobId` sets the job to `failed` with message "Avbrutt av bruker". The loop checks the DB status every iteration.
- Endpoints: `/start`, `/status/:id`, `/cancel/:id`, `/resume/:id`, `/resume-paused`, `/active`, `/recent`.
- `mode: "analyze" | "update"`: analyze only logs differences to `sync_log` and writes nothing. It is shown as a "dry run" button in the UI.
- `scheduled_tasks` table + pg_cron `run-scheduled-tasks` gives daily runs. A new task with `next_run_at = NULL` runs within about 1 minute.

## 5. Shopify integration (brief)

- API 2025-01: use `productVariantsBulkUpdate` (`productVariantUpdate` has been removed). SKU and weight live on `InventoryItem`. `ProductInput.seo` is **silently ignored**, so use `metafieldsSet` with `global.title_tag` / `global.description_tag`.
- Mapping: ISBN → handle, SKU and barcode · author → `productType` · publisher → `vendor` · tags = `bkg-N`, `bkg-NN`, `bkg-NNN` (the genre hierarchy).
- Only add an image if the product doesn't already have one, to avoid duplicates on re-push.
- GraphQL wrapper retries on `THROTTLED` with backoff (1 s / 2 s / 4 s).
- **Genre system:** bokgruppekode `417` → tags `bkg-4`, `bkg-41`, `bkg-417` → one Smart Collection per tag (rule `TAG = bkg-…`). The full code-to-name map is `COLLECTION_NAMES` in `shopify/index.ts`. The menu builder puts the hierarchy under "Nettbutikk", up to 3 levels deep (Shopify's limit). Collections with more than 5,000 products lose storefront filters, so the hierarchy keeps collections small.
- Tokens are Custom App `shpat_` tokens. They are permanent (no refresh), but they break if the app is reinstalled.
- `pushOneBook` in a loop doesn't scale to a full catalog (~17k products). For that, the right tool is Bulk Operations (`bulkOperationRunMutation` + staged upload).

## 6. Lessons worth carrying over

1. **Never take the first matching XML block** for price, description or title. Pick by code priority.
2. Keep ONIX code lists (58, 65, 150, subject schemes) in **one shared module**. Deno functions can't import from `src/`, so they keep a copy with a comment pointing to the canonical file.
3. Look at raw ONIX (`?raw=true`) before writing parser rules. Publishers fill fields in inconsistently.
4. Bokbasen's feed is by **modification date**. Don't assume it can give you "new releases" directly.
5. Design jobs as idempotent, resumable pulses from day one, with an analyze-only mode.
6. Consolidate the Bokbasen client (one auth URL, one endpoint, one parser). Bokadmin grew three slightly different copies, and the differences caused bugs.

## 7. References

- ONIX code lists (Norwegian): https://ns.editeur.org/onix/nb/ (List 58 price type, 65 availability, 150 product form, 27 subject scheme)
- Bokbasen API docs: https://bokbasen.jira.com/wiki/spaces/api/
- Bokbasen fixed prices: https://bokbasen.jira.com/wiki/spaces/api/pages/3049947145/Fixed+prices+in+Onix+from+Bokbasen
