// src/app/utils/tagCleanup.ts
// CSV for taggjobben «Rydd tagger» (tag_cleanup): ISBN, handle, tagger før, tagger som fjernes, tagger etter.
// Radene kommer fra sync_log (action tag_cleanup, outcome endret): `fields` = tagger som fjernes, og meldingen
// slutter på «beholder: bkg-3, bkg-31» (taggene som står igjen). Ren funksjon, testes i scripts/tag-cleanup.test.mjs.

export interface TagCleanupRow {
  isbn: string | null;
  title: string | null;
  fields?: string[] | null;
  message: string;
}

/** «Ville fjernet 3 tagger; beholder: bkg-3, bkg-31» → ["bkg-3", "bkg-31"] */
export function keptTagsFromMessage(message: string): string[] {
  const m = /beholder:\s*(.*)$/.exec(message);
  if (!m || m[1].trim() === "(ingen)") return [];
  return m[1].split(",").map((t) => t.trim()).filter(Boolean);
}

const BOM = String.fromCharCode(0xfeff);
const cell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function tagCleanupCsv(rows: TagCleanupRow[]): string {
  const header = ["ISBN", "Handle", "Tagger før", "Tagger som fjernes", "Tagger etter"];
  const lines = rows.map((r) => {
    const removed = r.fields ?? [];
    const kept = keptTagsFromMessage(r.message);
    return [r.isbn ?? "", r.title ?? "", [...kept, ...removed].join(", "), removed.join(", "), kept.join(", ")].map((c) => cell(String(c))).join(";");
  });
  return BOM + [header.join(";"), ...lines].join("\r\n") + "\r\n";
}
