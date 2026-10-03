#!/usr/bin/env node
// scripts/institusjoner.mjs — pakke G del 3: CSV over alle bidragsytere som er regnet som
// institusjon (CorporateName, eller et navn på listen i _shared/contributors.js) og derfor
// ikke er med i bok.forfatter, handle, SEO-tittel, metabeskrivelse eller alt-tekst.
// Eirik kontrollerer lista; mangler et navn, legges det til i INSTITUTION_NAMES / INSTITUTION_PATTERNS.
//
// Lista kommer fra resultatet av «Oppdater eksisterende bøker» (sjekk eller oppdatering), som
// teller institusjonene mens den går gjennom hele katalogen (jobs.result.counts.institutions).
//
//   node scripts/institusjoner.mjs                 # siste ferdige book_update-jobb
//   node scripts/institusjoner.mjs <jobId>
//   → scripts/out/institusjoner-<dato>.csv  (Navn;Årsak;Roller;Antall bøker;Eksempel-ISBN)
//
// Leser jobben med anon-nøkkelen via funksjonen book-update/status/<jobId>, eller book-update/recent.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import "./lib/clients.mjs"; // laster scripts/.env.local
import { ensureOutDir } from "./lib/clients.mjs";
import { institutionsCsv } from "../supabase/functions/_shared/contributors.js";

const key = process.env.SUPABASE_ANON_KEY;
const base = `${process.env.SUPABASE_URL}/functions/v1/book-update`;
const get = async (path) => {
  const res = await fetch(`${base}/${path}`, { headers: { Authorization: `Bearer ${key}`, apikey: key } });
  if (!res.ok) throw new Error(`book-update/${path}: HTTP ${res.status}`);
  return res.json();
};

let jobId = process.argv[2];
if (!jobId) {
  const recent = await get("recent");
  const jobs = Array.isArray(recent) ? recent : recent.jobs ?? [];
  const done = jobs.filter((j) => j.status === "completed" && j.result?.counts?.institutions);
  if (!done.length) { console.error("Fant ingen ferdig book_update-jobb med institusjonsliste. Kjør «Oppdater eksisterende bøker» (sjekk) først."); process.exit(1); }
  jobId = done[0].id;
}
const job = await get(`status/${jobId}`);
const institutions = job.result?.counts?.institutions;
if (!institutions) { console.error(`Jobb ${jobId} har ingen institusjonsliste (kjørt før pakke G).`); process.exit(1); }
const file = join(ensureOutDir(), `institusjoner-${new Date().toISOString().slice(0, 10)}.csv`);
writeFileSync(file, "﻿" + institutionsCsv(institutions), "utf8");
const names = Object.keys(institutions);
console.log(`Jobb ${jobId}: ${names.length} institusjoner på ${Object.values(institutions).reduce((n, i) => n + i.count, 0)} bøker → ${file}`);
