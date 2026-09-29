# Shopify megameny – instruksjon til Shopify AI

## Bakgrunn

Nettbutikken bruker et automatisk Smart Collection-system basert på Forleggerforeningens offisielle bokgruppekoder. Alle produkter er tagget og sortert automatisk. Kolleksjonenes URL-handle følger alltid mønsteret `bkg-{kode}`.

Jeg vil ha et megamenysystem i navigasjonen som reflekterer denne hierarkiske strukturen.

---

## Kolleksjonshierarkiet

Systemet har tre nivåer:

- **Nivå 1 (1 siffer):** Hovednivå — f.eks. handle `bkg-4` = "Skjønnlitteratur"
- **Nivå 2 (2 siffer):** Undernivå — f.eks. handle `bkg-41` = "Norsk skjønnlitteratur, voksne"
- **Nivå 3 (3 siffer):** Spesifikt nivå — f.eks. handle `bkg-417` = "Krim/spenning"

En bok som er krim av en norsk forfatter har alle tre taggene: `bkg-4`, `bkg-41`, `bkg-417`, og dukker derfor opp i alle tre kolleksjonene.

---

## Komplett kolleksjonsoversikt

### bkg-1 — Skolebøker
- bkg-11 — Skolebøker

### bkg-2 — Fagbøker og lærebøker
- bkg-21 — Fagbøker, høyere utdanning
  - bkg-211 — Jus
  - bkg-212 — Økonomi, administrasjon, markedsføring
  - bkg-213 — Helse og sosialfag
  - bkg-214 — Samfunnsvitenskapelige fag
  - bkg-215 — Pedagogikk
  - bkg-216 — Språk og estetiske fag
  - bkg-217 — Religion, historie, litteraturvitenskap, filosofi
  - bkg-218 — Tekniske fag
  - bkg-219 — Naturvitenskapelige fag
- bkg-22 — Fagbøker, yrkesfaglig utdanning
  - bkg-221 — Jus
  - bkg-222 — Økonomi, administrasjon, markedsføring
  - bkg-223 — Helse og sosialfag
  - bkg-224 — Samfunnsvitenskapelige fag
  - bkg-225 — Pedagogikk
  - bkg-226 — Språk og estetiske fag
  - bkg-227 — Religion, historie, litteraturvitenskap, filosofi
  - bkg-228 — Tekniske fag
  - bkg-229 — Naturvitenskapelige fag

### bkg-3 — Sakprosa
- bkg-31 — Sakprosa norsk, voksne
  - bkg-311 — Kultur, religion, kunst
  - bkg-312 — Samfunn, historie
  - bkg-313 — Kropp og sinn
  - bkg-314 — Natur, friluftsliv, sport
  - bkg-315 — Reise og geografi
  - bkg-316 — Mat og drikke
  - bkg-317 — Hobby
  - bkg-318 — Teknikk og populærvitenskap
  - bkg-319 — Memoarer, biografier
- bkg-32 — Sakprosa oversatt, voksne
  - bkg-321 — Kultur, religion, kunst
  - bkg-322 — Samfunn, historie
  - bkg-323 — Kropp og sinn
  - bkg-324 — Natur, friluftsliv, sport
  - bkg-325 — Reise og geografi
  - bkg-326 — Mat og drikke
  - bkg-327 — Hobby
  - bkg-328 — Teknikk, populærvitenskap
  - bkg-329 — Memoarer, biografier
- bkg-33 — Sakprosa norsk, barn og ungdom
  - bkg-331 — Billedbøker
  - bkg-332 — Barn
  - bkg-333 — Junior
  - bkg-334 — Ungdom
- bkg-34 — Sakprosa oversatt, barn og ungdom
  - bkg-341 — Billedbøker
  - bkg-342 — Barn
  - bkg-343 — Junior
  - bkg-344 — Ungdom

### bkg-4 — Skjønnlitteratur
- bkg-41 — Norsk skjønnlitteratur, voksne
  - bkg-411 — Romaner
  - bkg-412 — Noveller
  - bkg-413 — Lyrikk
  - bkg-414 — Skuespill
  - bkg-415 — Essays
  - bkg-416 — Antologier
  - bkg-417 — Krim/spenning
  - bkg-418 — Klassisk litteratur
  - bkg-419 — Sang- og visebøker
- bkg-42 — Oversatt skjønnlitteratur, voksne
  - bkg-421 — Romaner
  - bkg-422 — Noveller
  - bkg-423 — Lyrikk
  - bkg-424 — Skuespill
  - bkg-425 — Essays
  - bkg-426 — Antologier
  - bkg-427 — Krim/spenning
  - bkg-428 — Klassisk litteratur
  - bkg-429 — Sang- og visebøker
- bkg-43 — Norsk skjønnlitteratur, barn og ungdom
  - bkg-431 — Billedbøker
  - bkg-432 — Romaner barn
  - bkg-433 — Romaner junior
  - bkg-434 — Romaner ungdom
  - bkg-435 — Antologier
  - bkg-436 — Klassisk litteratur
  - bkg-437 — Sang, viser, dikt
  - bkg-438 — Noveller
- bkg-44 — Oversatt skjønnlitteratur, barn og ungdom
  - bkg-441 — Billedbøker
  - bkg-442 — Romaner barn
  - bkg-443 — Romaner junior
  - bkg-444 — Romaner ungdom
  - bkg-445 — Antologier
  - bkg-446 — Klassisk litteratur
  - bkg-447 — Sang, viser, dikt
  - bkg-448 — Noveller

### bkg-5 — Billigbøker
- bkg-50 — Billigbøker
  - bkg-501 — Norsk sakprosa for voksne
  - bkg-502 — Norsk skjønnlitteratur for voksne
  - bkg-503 — Oversatt sakprosa for voksne
  - bkg-504 — Oversatt skjønnlitteratur for voksne
  - bkg-505 — Norsk sakprosa for barn og ungdom
  - bkg-506 — Norsk skjønnlitteratur for barn og ungdom
  - bkg-507 — Oversatt sakprosa for barn og ungdom
  - bkg-508 — Oversatt skjønnlitteratur for barn og ungdom

### bkg-6 — Verk
- bkg-60 — Verk
  - bkg-601 — Skjønnlitterære verk for voksne
  - bkg-602 — Sakprosaverk for voksne
  - bkg-603 — Skjønnlitterære verk for barn og unge
  - bkg-604 — Sakprosaverk for barn og unge
  - bkg-605 — Leksikale verk for voksne
  - bkg-606 — Leksikale verk for barn og unge

### bkg-7 — Kommisjonsbøker, lover, forskningsrapporter
- bkg-70 — Kommisjonsbøker og tilsvarende
  - bkg-701 — Tidsskrifter
  - bkg-702 — Grunnskolen/Videregående skole
  - bkg-703 — Lærebøker for høyere utdanning
  - bkg-704 — Lærebøker til voksenopplæring
  - bkg-705 — Fagbøker for profesjonsmarkedet
  - bkg-706 — Skjønnlitteratur/sakprosa for voksne
  - bkg-707 — Skjønnlitteratur/sakprosa for barn
  - bkg-708 — Lover, forskrifter og forskningsrapporter
  - bkg-709 — Sammensatte bokprodukter

### bkg-8 — Lydbøker og elektroniske innholdsprodukter
- bkg-81 — E-bøker, forbrukermarkedet
  - bkg-811 — E-bok norsk sakprosa, voksne
  - bkg-812 — E-bok norsk skjønnlitteratur, voksne
  - bkg-813 — E-bok oversatt sakprosa, voksne
  - bkg-814 — E-bok oversatt skjønnlitteratur, voksne
  - bkg-815 — E-bok norsk sakprosa, barn og ungdom
  - bkg-816 — E-bok norsk skjønnlitteratur, barn og ungdom
  - bkg-817 — E-bok oversatt sakprosa, barn og ungdom
  - bkg-818 — E-bok oversatt skjønnlitteratur, barn og ungdom
- bkg-85 — E-bøker
  - bkg-851 — E-bok norsk sakprosa, voksne
  - bkg-852 — E-bok norsk skjønnlitteratur, voksne
  - bkg-853 — E-bok oversatt sakprosa, voksne
  - bkg-854 — E-bok oversatt skjønnlitteratur, voksne
  - bkg-855 — E-bok norsk sakprosa, barn og ungdom
  - bkg-856 — E-bok norsk skjønnlitteratur, barn og ungdom
  - bkg-857 — E-bok oversatt sakprosa, barn og ungdom
  - bkg-858 — E-bok oversatt skjønnlitteratur, barn og ungdom
- bkg-88 — Lydbøker
  - bkg-881 — Lydbok norsk sakprosa, voksne
  - bkg-882 — Lydbok norsk skjønnlitteratur, voksne
  - bkg-883 — Lydbok oversatt sakprosa, voksne
  - bkg-884 — Lydbok oversatt skjønnlitteratur, voksne
  - bkg-885 — Lydbok norsk sakprosa, barn og ungdom
  - bkg-886 — Lydbok norsk skjønnlitteratur, barn og ungdom
  - bkg-887 — Lydbok oversatt sakprosa, barn og ungdom
  - bkg-888 — Lydbok oversatt skjønnlitteratur, barn og ungdom

### bkg-9 — Annen litteratur
- bkg-91 — Norske serieromaner
- bkg-92 — Oversatte underholdningsromaner
- bkg-93 — Utenlandsk sakprosa
  - bkg-931 — Sakprosa på originalspråket, voksen
  - bkg-932 — Ordbøker og undervisningsmateriell på originalspråket
  - bkg-933 — Reise og geografi på originalspråket
  - bkg-934 — Sakprosa på originalspråket, barn og ungdom
- bkg-94 — Utenlandsk skjønnlitteratur
  - bkg-941 — Skjønnlitteratur på originalspråket, voksen
  - bkg-942 — Krim og spenning på originalspråket, voksen
  - bkg-943 — Fantasy/SF på originalspråket, voksen
  - bkg-944 — Skjønnlitteratur på originalspråket, barn og ungdom

---

## Teknisk informasjon om butikken

- **Shopify-butikk:** `<butikk>.myshopify.com`
- **Shopify Admin GraphQL API-versjon:** `2025-01`
- **Kolleksjons-URL-format:** `/collections/bkg-{kode}` — f.eks. `/collections/bkg-417`
- **Kolleksjonstype:** Smart Collections (automatiske, basert på tag-regler)
- **Tag-regel per kolleksjon:** `Product tag is equal to bkg-{kode}`
- **Navigasjonsmeny:** redigeres via Shopify Admin → Online Store → Navigation

Relevante GraphQL-operasjoner (API 2025-01):
```graphql
# Hente en kolleksjon på handle
query {
  collectionByHandle(handle: "bkg-417") {
    id title handle
  }
}

# Opprette/oppdatere navigasjonsmeny
mutation menuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
  menuCreate(title: $title, handle: $handle, items: $items) {
    menu { id title handle }
    userErrors { field message }
  }
}
```

---

## Instruksjon til Shopify AI

Sett opp en megameny i navigasjonen som følger hierarkiet over. Reglene er:

1. **Toppnivå i menyen** = de mest relevante bkg-1-siffer-kolleksjonene (typisk 3, 4, 8 — Sakprosa, Skjønnlitteratur, Lydbøker/E-bøker — pluss eventuelt andre etter butikkens sortiment)
2. **Første undermeny (kolonner)** = bkg-2-siffer-kolleksjonene under hvert toppnivå
3. **Lenker i hver kolonne** = bkg-3-siffer-kolleksjonene under hvert undernivå
4. Alle lenker peker til kolleksjonssiden med handle `bkg-{kode}` — f.eks. `/collections/bkg-417`
5. Kolleksjonsnavnet brukes som lenketekst — f.eks. "Krim/spenning"

Kolleksjonene eksisterer allerede i Shopify (butikk: `<butikk>.myshopify.com`) og er fylt med produkter automatisk via tag-regler. Bruk Shopify Admin GraphQL API versjon `2025-01` for eventuelle API-kall.
