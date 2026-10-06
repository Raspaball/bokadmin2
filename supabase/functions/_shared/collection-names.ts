// supabase/functions/_shared/collection-names.ts
// Bokgruppekode → samlingsnavn (1-, 2- og 3-sifrede koder). Den autoritative
// kilden, brukt av shopify (samlinger, megameny) og sjangre-sync. Ikke kort ned
// eller kopier kartet. Flyttet hit fra shopify/index.ts i pakke A2 del 6
// (sjangre-sync hadde en avkortet kopi og ga f.eks. «Bokgruppe 334» i stedet for «Ungdom»).
// Kilde: https://forleggerforeningen.no/bokgruppene/
// Format på nettstedet er X.Y.Z — her oversatt til XYZ (f.eks. 3.1.6 → 316)

export const COLLECTION_NAMES: Record<string, string> = {
  // ── 1-sifret (hovednivå) ──────────────────────────────────────────────────
  '1': 'Skolebøker',
  '2': 'Fagbøker og lærebøker',
  '3': 'Sakprosa',
  '4': 'Skjønnlitteratur',
  '5': 'Billigbøker',
  '6': 'Verk',
  '7': 'Kommisjonsbøker, lover, forskningsrapporter',
  '8': 'Lydbøker og elektroniske innholdsprodukter',
  '9': 'Annen litteratur',

  // ── 2-sifret ──────────────────────────────────────────────────────────────
  '11': 'Skolebøker',
  '21': 'Fagbøker, høyere utdanning',
  '22': 'Fagbøker, yrkesfaglig utdanning',
  '31': 'Sakprosa norsk, voksne',
  '32': 'Sakprosa oversatt, voksne',
  '33': 'Sakprosa norsk, barn og ungdom',
  '34': 'Sakprosa oversatt, barn og ungdom',
  '41': 'Norsk skjønnlitteratur, voksne',
  '42': 'Oversatt skjønnlitteratur, voksne',
  '43': 'Norsk skjønnlitteratur, barn og ungdom',
  '44': 'Oversatt skjønnlitteratur, barn og ungdom',
  '50': 'Billigbøker',
  '60': 'Verk',
  '70': 'Kommisjonsbøker og tilsvarende',
  '80': 'Digitale produkter, læremateriell',
  '81': 'E-bøker, forbrukermarkedet',
  '82': 'Digitalt læremateriell',
  '83': 'Øvrige produkter',
  '85': 'E-bøker',
  '88': 'Lydbøker',
  '89': 'Digitale læremidler',
  '91': 'Norske serieromaner',
  '92': 'Oversatte underholdningsromaner',
  '93': 'Utenlandsk sakprosa',
  '94': 'Utenlandsk skjønnlitteratur',

  // ── 3-sifret ──────────────────────────────────────────────────────────────
  // 1xx — Skolebøker
  '110': 'Grunnskolen',
  '120': 'Videregående skole',
  // 2xx — Fagbøker og lærebøker
  '210': 'Diverse fagbøker',
  '211': 'Jus',
  '212': 'Økonomi, administrasjon, markedsføring',
  '213': 'Helse og sosialfag',
  '214': 'Samfunnsvitenskapelige fag',
  '215': 'Pedagogikk',
  '216': 'Språk og estetiske fag',
  '217': 'Religion, historie, litteraturvitenskap, filosofi',
  '218': 'Tekniske fag',
  '219': 'Naturvitenskapelige fag',
  '220': 'Diverse fagbøker',
  '221': 'Jus',
  '222': 'Økonomi, administrasjon, markedsføring',
  '223': 'Helse og sosialfag',
  '224': 'Samfunnsvitenskapelige fag',
  '225': 'Pedagogikk',
  '226': 'Språk og estetiske fag',
  '227': 'Religion, historie, litteraturvitenskap, filosofi',
  '228': 'Tekniske fag',
  '229': 'Naturvitenskapelige fag',
  // 3xx — Sakprosa
  '310': 'Diverse sakprosa',
  '311': 'Kultur, religion, kunst',
  '312': 'Samfunn, historie',
  '313': 'Kropp og sinn',
  '314': 'Natur, friluftsliv, sport',
  '315': 'Reise og geografi',
  '316': 'Mat og drikke',
  '317': 'Hobby',
  '318': 'Teknikk og populærvitenskap',
  '319': 'Memoarer, biografier',
  '320': 'Diverse sakprosa oversatt',
  '321': 'Kultur, religion, kunst',
  '322': 'Samfunn, historie',
  '323': 'Kropp og sinn',
  '324': 'Natur, friluftsliv, sport',
  '325': 'Reise og geografi',
  '326': 'Mat og drikke',
  '327': 'Hobby',
  '328': 'Teknikk, populærvitenskap',
  '329': 'Memoarer, biografier',
  '330': 'Diverse sakprosa barn og ungdom',
  '331': 'Billedbøker',
  '332': 'Barn',
  '333': 'Junior',
  '334': 'Ungdom',
  '340': 'Diverse sakprosa barn og ungdom oversatt',
  '341': 'Billedbøker',
  '342': 'Barn',
  '343': 'Junior',
  '344': 'Ungdom',
  // 4xx — Skjønnlitteratur
  '410': 'Diverse norsk skjønnlitteratur',
  '411': 'Romaner',
  '412': 'Noveller',
  '413': 'Lyrikk',
  '414': 'Skuespill',
  '415': 'Essays',
  '416': 'Antologier',
  '417': 'Krim/spenning',
  '418': 'Klassisk litteratur',
  '419': 'Sang- og visebøker',
  '420': 'Diverse oversatt skjønnlitteratur',
  '421': 'Romaner',
  '422': 'Noveller',
  '423': 'Lyrikk',
  '424': 'Skuespill',
  '425': 'Essays',
  '426': 'Antologier',
  '427': 'Krim/spenning',
  '428': 'Klassisk litteratur',
  '429': 'Sang- og visebøker',
  '430': 'Diverse norsk skjønnlitteratur barn og ungdom',
  '431': 'Billedbøker',
  '432': 'Romaner barn',
  '433': 'Romaner junior',
  '434': 'Romaner ungdom',
  '435': 'Antologier',
  '436': 'Klassisk litteratur',
  '437': 'Sang, viser, dikt',
  '438': 'Noveller',
  '440': 'Diverse oversatt skjønnlitteratur barn og ungdom',
  '441': 'Billedbøker',
  '442': 'Romaner barn',
  '443': 'Romaner junior',
  '444': 'Romaner ungdom',
  '445': 'Antologier',
  '446': 'Klassisk litteratur',
  '447': 'Sang, viser, dikt',
  '448': 'Noveller',
  // 5xx — Billigbøker
  '500': 'Diverse billigbøker',
  '501': 'Norsk sakprosa for voksne',
  '502': 'Norsk skjønnlitteratur for voksne',
  '503': 'Oversatt sakprosa for voksne',
  '504': 'Oversatt skjønnlitteratur for voksne',
  '505': 'Norsk sakprosa for barn og ungdom',
  '506': 'Norsk skjønnlitteratur for barn og ungdom',
  '507': 'Oversatt sakprosa for barn og ungdom',
  '508': 'Oversatt skjønnlitteratur for barn og ungdom',
  // 6xx — Verk
  '600': 'Diverse verk',
  '601': 'Skjønnlitterære verk for voksne',
  '602': 'Sakprosaverk for voksne',
  '603': 'Skjønnlitterære verk for barn og unge',
  '604': 'Sakprosaverk for barn og unge',
  '605': 'Leksikale verk for voksne',
  '606': 'Leksikale verk for barn og unge',
  // 7xx — Kommisjonsbøker, lover, forskningsrapporter
  '700': 'Diverse kommisjonsbøker',
  '701': 'Tidsskrifter',
  '702': 'Grunnskolen/Videregående skole',
  '703': 'Lærebøker for høyere utdanning',
  '704': 'Lærebøker til voksenopplæring',
  '705': 'Fagbøker for profesjonsmarkedet',
  '706': 'Skjønnlitteratur/sakprosa for voksne',
  '707': 'Skjønnlitteratur/sakprosa for barn',
  '708': 'Lover, forskrifter og forskningsrapporter',
  '709': 'Sammensatte bokprodukter',
  // 8xx — Lydbøker og elektroniske innholdsprodukter
  '800': 'Diverse digitale produkter',
  '801': 'Grunnskolen',
  '802': 'Videregående skole',
  '803': 'Høyere utdanning',
  '804': 'Voksenopplæring',
  '805': 'Faglitteratur for profesjonsmarkedet',
  '806': 'Sakprosa, voksne',
  '807': 'Sakprosa, barn og unge',
  '808': 'Skjønnlitteratur, barn og unge',
  '809': 'Lover, forskrifter og forskningsrapporter',
  '810': 'Diverse lydbøker (fysisk)',
  '811': 'Lydbok (fysisk) norsk sakprosa, voksne',
  '812': 'Lydbok (fysisk) norsk skjønnlitteratur, voksne',
  '813': 'Lydbok (fysisk) oversatt sakprosa, voksne',
  '814': 'Lydbok (fysisk) oversatt skjønnlitteratur, voksne',
  '815': 'Lydbok (fysisk) norsk sakprosa, barn og ungdom',
  '816': 'Lydbok (fysisk) norsk skjønnlitteratur, barn og ungdom',
  '817': 'Lydbok (fysisk) oversatt sakprosa, barn og ungdom',
  '818': 'Lydbok (fysisk) oversatt skjønnlitteratur, barn og ungdom',
  '820': 'Diverse digitalt læremateriell',
  '821': 'Digitalt læremateriell, grunnskolen',
  '822': 'Digitalt læremateriell, videregående',
  '823': 'Digitalt læremateriell, høyere utdanning',
  '824': 'Digitalt læremateriell, voksenopplæring',
  '825': 'Faglitteratur for profesjonsmarkedet, digitalt',
  '830': 'Diverse øvrige produkter',
  '831': 'Kart',
  '832': 'Kalendere, dagbøker, almanakker',
  '833': 'Lover, forskrifter og forskningsrapporter',
  '834': 'Leker, puslespill, tegne- og malemateriell',
  '835': 'Butikkmateriell',
  '836': 'Kontorartikler og kortevarer',
  '837': 'Vitnemål, skoleadministrativt materiell',
  '838': 'Sammensatte produkter',
  '850': 'Diverse e-bøker',
  '851': 'E-bok norsk sakprosa, voksne',
  '852': 'E-bok norsk skjønnlitteratur, voksne',
  '853': 'E-bok oversatt sakprosa, voksne',
  '854': 'E-bok oversatt skjønnlitteratur, voksne',
  '855': 'E-bok norsk sakprosa, barn og ungdom',
  '856': 'E-bok norsk skjønnlitteratur, barn og ungdom',
  '857': 'E-bok oversatt sakprosa, barn og ungdom',
  '858': 'E-bok oversatt skjønnlitteratur, barn og ungdom',
  '880': 'Diverse lydbøker',
  '881': 'Lydbok norsk sakprosa, voksne',
  '882': 'Lydbok norsk skjønnlitteratur, voksne',
  '883': 'Lydbok oversatt sakprosa, voksne',
  '884': 'Lydbok oversatt skjønnlitteratur, voksne',
  '885': 'Lydbok norsk sakprosa, barn og ungdom',
  '886': 'Lydbok norsk skjønnlitteratur, barn og ungdom',
  '887': 'Lydbok oversatt sakprosa, barn og ungdom',
  '888': 'Lydbok oversatt skjønnlitteratur, barn og ungdom',
  '890': 'Diverse digitale læremidler',
  '891': 'Digitale læremidler, grunnskolen',
  '892': 'Digitale læremidler, videregående',
  '893': 'Digitale læremidler, høyere utdanning',
  '894': 'Digitale læremidler, voksenopplæring',
  '895': 'Faglitteratur for profesjonsmarkedet, digitalt',
  // 9xx — Annen litteratur
  '910': 'Norske serieromaner',
  '920': 'Oversatte underholdningsromaner',
  '930': 'Diverse utenlandsk sakprosa',
  '931': 'Sakprosa på originalspråket, voksen',
  '932': 'Ordbøker og undervisningsmateriell på originalspråket',
  '933': 'Reise og geografi på originalspråket',
  '934': 'Sakprosa på originalspråket, barn og ungdom',
  '940': 'Diverse utenlandsk skjønnlitteratur',
  '941': 'Skjønnlitteratur på originalspråket, voksen',
  '942': 'Krim og spenning på originalspråket, voksen',
  '943': 'Fantasy/SF på originalspråket, voksen',
  '944': 'Skjønnlitteratur på originalspråket, barn og ungdom',
};

/**
 * Unike samlingstitler (pakke H, etter sjekkrapport 06.10). Flere koder har samme navn i
 * bokgruppelista («Jus» under både 21 og 22, «Verk» som både 6 og 60), og to samlinger med
 * samme tittel kan ikke skilles i butikken. Regel for koder som deler navn:
 *  1. «{navn} – {overordnet navn}» når den overordnede gruppen har et annet navn og
 *     resultatet er unikt («Jus – Fagbøker, høyere utdanning»).
 *  2. Ellers («Skolebøker» 1 og 11, «Verk» 6 og 60): den korteste koden beholder navnet,
 *     de andre får «{navn} ({kode})» («Verk (60)»).
 * Koder med unikt navn er uendret. Brukes for samlingene (shopify, sjangre-sync); menyen
 * viser COLLECTION_NAMES, siden den står under foreldrene.
 */
export function uniqueCollectionTitles(names: Record<string, string>): Record<string, string> {
  const groups = new Map<string, string[]>();
  for (const [code, title] of Object.entries(names)) groups.set(title, [...(groups.get(title) ?? []), code]);
  const out: Record<string, string> = { ...names };
  const taken = new Set([...groups].filter(([, v]) => v.length === 1).map(([t]) => t));
  for (const [title, codes] of groups) {
    if (codes.length < 2) continue;
    const rest: string[] = [];
    for (const code of codes) {
      const parent = names[code.slice(0, -1)];
      const candidate = parent && parent !== title ? `${title} – ${parent}` : null;
      if (candidate && !taken.has(candidate)) { out[code] = candidate; taken.add(candidate); } else rest.push(code);
    }
    rest.sort((a, b) => a.length - b.length || a.localeCompare(b));
    rest.forEach((code, i) => {
      if (i === 0 && !taken.has(title)) { out[code] = title; taken.add(title); } else { out[code] = `${title} (${code})`; taken.add(out[code]); }
    });
  }
  return out;
}

export const COLLECTION_TITLES: Record<string, string> = uniqueCollectionTitles(COLLECTION_NAMES);
