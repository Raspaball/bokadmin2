# Rydd tagger (taggjobben tag_cleanup): status

Oppdrag 09.10.2026 (Eirik). Del A i planen for opprydding av tagger og metafelt. Metafeltjobben (del B) er ikke bygget.
Merk: planfila `claude/plan-opprydding-tagger-og-metafelt.md` ligger ikke i repoet; arbeidet bygger på oppgaveteksten.

## Regel
- Beholdes: `bkg-` + 1–3 sifre, og gave, lokal, lokalhistorie, lokallitteratur (hel tagg, uten store/små bokstaver).
- Fjernes: alt annet. Ingen tagger legges til.
- Aldri med: beskyttede produkter, produkter uten ISBN, duplikat-ISBN. Gjelder også ikke-bøker med ISBN.

## Bygd (09.10.2026, ikke deployet)
- `tagsToRemove()` / `isKeptTag()` i `_shared/book-tags.ts` (+ `scripts/tag-cleanup.test.mjs`).
- Egen funksjon `supabase/functions/tag-cleanup/` (valgt framfor sjangre-sync: egen, liten, deployes og rulles tilbake uten å røre sjangre-sync; ingen migrasjon eller pg_cron, siden gjenopptar). Endepunkter: start, status, cancel, resume, resume-paused, active, recent, rollback.
- Oppdatering bruker `tagsRemove` i bulk. Angre bruker `tagsAdd` fra loggen, med smal mutasjonsliste.
- Knapp «Rydd tagger» (Sjekk, Rydd tagger, Avbryt, CSV, Angre) på siden Sjangre: `RyddTagger.tsx`.
- Nye GraphQL-spørringer er validert mot Shopifys skjema.

## Test (ingen Testbutikk-test: Eirik tester direkte i live)
Trinn 3 (enhetstester, hele suiten, validering, deploy etter ja) → 4 (sjekk mot live) → 5 (sikkerhetsnett) → 6 (mikrotest, 10 bøker) → 7 (pilot, resten). Se oppdraget. Status føres under.

