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

## Status 09.10.2026
- Trinn 3 ferdig: 377 av 377 tester, spørringene validert, `tag-cleanup` deployet til Bokadmin 2.0, migrasjon `20261009120000` (pg_cron `resume-paused-tag-cleanup-jobs`) kjørt.
- Trinn 4 ferdig: sjekk mot live (jobb 39043c8c, bare lesing, 0 operasjoner, 0 feil, 12 min inkludert ventetid før gjenopptak).
  - 17 169 produkter: **993 ville fått 3 476 tagger fjernet**, 15 803 var rene, hoppet over 373 (197 beskyttet, 118 duplikat, 58 uten ISBN).
  - Vanligste tagger som fjernes: skjoenn (80), sakpr (65), skjoenn-rom (62), skole (51), Faglitteratur (48), skole-grunn (29), laerfa (23), skole-vider (22), laerfa-hoey (18), Moderne litteratur (16). Resten er hovedsakelig navn (fornavn/etternavn) og titler. 2 436 ulike tagger.
  - Ingen av de 159 smarte samlingene har regel på en tagg som fjernes (kontrollert mot eksporten fra 09.10).
  - CSV: knappen «Tagger (CSV)» på siden Sjangre (krever innlogging); ikke i git.
- Neste: trinn 5 (sikkerhetsnett), 6 (mikrotest, 10 bøker), 7 (pilot, resten). Venter på «gå videre».
