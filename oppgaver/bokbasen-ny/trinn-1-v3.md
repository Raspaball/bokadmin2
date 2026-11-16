# Bokbasen ny, trinn 1: v3 i dagens kode, test av 25 ISBN v2 mot v3   (16.11.2026, skrevet av Cowork/Claude for Claude Code)

## Mål (én setning)
Dagens Bokbasen-fane og jobbene skal hente fra Bokbasens v3-adresse i stedet for v2, med samme resultat som i dag, slik at de virker gjennom testperioden.

## Bakgrunn
Bokbasen oppga 30.06.2026 som sluttdato for v2. v2 svarte fortsatt 16.11.2026. All kode bruker v2 i dag [Kode]:
- `supabase/functions/_shared/bokbasen-auth.ts` linje 17: `BOKBASEN_ONIX_URL` (…/export/onix/v2)
- `supabase/functions/bokbasen/index.ts`: fem steder som bygger adressen selv (linje ca. 270, 332, 381, 462, 585)
- `scripts/lib/clients.mjs` linje ca. 156: `fetchOnixXml()`

## Les først
- `CLAUDE.md`, `oppgaver/bokbasen-ny/STATUS.md`
- Bokbasen: «Changes ONIX (2026) – v3» https://bokbasen.jira.com/wiki/spaces/api/pages/3812229200 og «ONIX» https://bokbasen.jira.com/wiki/spaces/api/pages/67993632
- `supabase/functions/_shared/onix.js` (særlig `resolvePublication()`, `extractContributors()`), `onix-cache.ts`, `price.ts`, `availability.ts`, `book-standard.ts`
- Testene `scripts/onix*.test.mjs`, `scripts/price.test.mjs`

## Modell
Sonnet holder. Bytt til Opus hvis en test feiler to ganger, eller hvis v3 avviker mer enn dokumentasjonen sier.

## Dette skal lages

### Del A: sammenligning (ingen endring i funksjonene, ingen deploy)
- Skript `scripts/bokbasen-ny/v2-mot-v3.mjs`. Det henter 25 ISBN i v2 og i v3 og sammenligner felt for felt.
- **Enkeltoppslag:** 25 ISBN × 2 versjoner = 50 oppslag (Eirik 16.11.2026). Det kjøres **én gang**. Skriptet teller oppslagene og nekter å gå over 50. Rå XML lagres i `scripts/out/bokbasen-ny/v2-v3/`, og alle senere kjøringer leser fra disk (`--fra-disk`).
- **Utvalget (25 ISBN):** hentes fra `onix_cache` (bare SELECT), og lista lagres bare i `scripts/out/` (ikke i git). Spre dem slik:
  - ONIX-kode: kommende (10–12), i salg (20–23), midlertidig utsolgt (30–34), utgått (41, 43, 46–49), andre (40, 42, 44)
  - format: innbundet, heftet, pocket, lydbok, e-bok, og noe som ikke er bok
  - flere forfattere, oversetter og illustratør, institusjon som forfatter, bok uten forlagstekst, bok i serie, bok med flere priser (fastpris og veiledende), bok med ny utgave (RelatedProduct 05)
  - de to kjente fra gjennomgangen 16.11: 9788203461392 (virket) og 9788202693985 (ga «Kunne ikke tolke ONIX»)
- **Felt som sammenlignes**, med de samme funksjonene som systemet bruker (ikke egne kopier):
  - `extractTitle`, `extractDescription`, `extractContributors` (forfattere, institusjoner, roller)
  - `choosePrice` (beløp og pristype), `extractAvailabilityCode`, `availabilityRule` (status)
  - `extractPublishingDate`, `extractPublicationYear` (og `resolvePublication().rule`)
  - `extractBokgruppekode`, `extractProductForm`/`bookFormat`, `extractReplacedBy`
  - hele `bookFieldsFromOnix()` (sider, språk, serie, alder, thema m.m.) og omslagsadressen
  - i tillegg: hvilke XML-elementer som bare finnes i den ene versjonen (liste med antall)
- Resultat: `scripts/out/bokbasen-ny/v2-v3/rapport.csv` (én linje per ISBN og felt som avviker) og et sammendrag på skjermen.

### Del B: kodeendringen
1. **Én adresse-konstant.** Alle sju stedene skal bruke den samme. Skriptene i Node må også kunne lese den, så legg den der både Deno og Node når den (for eksempel en liten `.js`-modul i `_shared/` med `.d.ts`, som `bokbasen-auth.ts` eksporterer videre). Etterpå skal `grep -rn "onix/v2" supabase scripts` bare gi treff i `scripts/out/` og i sammenligningsskriptet.
2. **Utgivelsesår:** i v3 betyr PublishingDate-rolle 01 «i salg»-dato i Norge, og rolle 37 er utgivelsesåret [Dok]. `resolvePublication()` bruker i dag året fra rolle 01. Rett den slik at året er riktig i v3, og slik at de 16 973 radene i `onix_cache` (hentet med v2) fortsatt tolkes riktig. Velg den enkleste løsningen som består testene, og si hvilken. Krever løsningen en ny kolonne i `onix_cache`: stopp og spør (det er en migrasjon).
3. **Forfatterroller:** i v3 kan `ContributorRole` gjentas i samme forfatter [Dok]. `extractContributors()` leser i dag den første. Test og rett, slik at en forfatter som også er illustratør fortsatt er forfatter, og ingen blir doblet.
4. **Nye tester** i `scripts/onix*.test.mjs` med små, anonyme XML-biter (ikke hele poster fra Bokbasen): år fra 37, år når 37 mangler, v2-post, gjentatt rolle.
5. Kjør del A på nytt fra disk med ny kode. **Krav: 0 uforklarte forskjeller.** Hver forskjell som blir stående, forklares i rapporten (for eksempel «året er nå fra rolle 37»).
6. Oppdater `CLAUDE.md` (v3, konstanten, regelen for år) og STATUS.md.

## Dette skal IKKE røres
- Pris- og statusreglene: `choosePrice()`, `availabilityRule()`, `planAvailability()`. Gir v3 annen pris eller status for en bok, skal det rapporteres, ikke «rettes».
- Handles, SEO-regler, beskyttede produkter, skrivesperre og butikkbytte.
- Ingen ny funksjon, ingen nye tabeller, ingen klokkejobb. Listeoppslaget bygges ikke her (det er trinn 3).
- Livebutikken, utviklingsbutikken, gamle Bokadmin.
- Feilmeldingen «Bokbasen-oppslag feilet» uten årsak og de tre ISBN-ene som ikke lot seg tolke: finn årsaken hvis sammenligningen viser den, og skriv den i rapporten. Rett den bare hvis rettingen er liten og ligger i tolkeren; ellers eget oppdrag.

## Miljø
Gren: `bokbasen-ny/trinn-1`. Supabase 2.0 (ref `chwpqwblqummlufqdefe`), bare SELECT fram til deploy. Butikk: ingen. Bokbasen: bare lesing, høyst 50 enkeltoppslag i alt (se del A).

## Tester og kontroll (må være grønne)
- `node --test scripts/*.test.mjs`
- `v2-mot-v3.mjs --fra-disk`: 0 uforklarte forskjeller i pris, status, år, dato, forfatter, tittel, tekst, bokgruppe og format
- `npm run build`
- Ingen v2-adresser igjen (se del B punkt 1)
- Ingen rå ONIX eller ISBN-lister i git

## Stopp og spør hvis
- v3 svarer med feil (401, 403, 404) eller et annet format enn dokumentasjonen beskriver
- pris eller status blir annerledes i v3 for noen av de 25
- løsningen krever migrasjon, eller endring utenfor lista over
- en test feiler to ganger
- du er i tvil om hvilket miljø en handling treffer

## Krever Eiriks ja (hver for seg)
1. Planen din (maks 15 linjer).
2. Deploy. Funksjonene skriver til live når Eirik bruker dem, så dette ja-et er like viktig som en skrivefase. Først etter at en ny Claude-samtale har kontrollert grenen og rapporten.
   - Deployes: alle som bruker `_shared/` mot Bokbasen: `bokbasen`, `shopify`, `price-update`, `availability-check`, `book-update`, `sjangre-sync`, `publish-books`. Alltid med `--project-ref chwpqwblqummlufqdefe`.
   - Ingen jobb skal kjøre under deploy.
3. Sammenslåing til `main`.

## Kontroll etter deploy
- Eirik slår opp ett ISBN på Bokbasen-siden (9788203461392): tittel, forfatter, pris, kode og bokgruppe som før.
- Én bokdata-jobb i **sjekkmodus** med 5 ISBN (bare lesing): 0 feil.
- `sync_log`: ingen nye `import_failed` av ny type.

## Tilbakerulling
Deploy forrige commit (e131614, eller commiten fra trinn 0) for de samme sju funksjonene. Virker så lenge v2 svarer. Ingen data er endret.

## Rapport (maks 20 linjer, til `oppgaver/bokbasen-ny/trinn-1-rapport.md`)
Gjort og ikke gjort. Antall oppslag brukt. Antall forskjeller per felt før og etter kodeendringen, og forklaringen på hver type. Valgt løsning for år og `onix_cache`. Årsaken til tolkefeilen hvis funnet. Commit-hash. Hva Eirik må bestemme. Detaljer i `scripts/out/bokbasen-ny/v2-v3/`.
