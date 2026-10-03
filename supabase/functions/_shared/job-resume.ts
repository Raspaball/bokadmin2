// supabase/functions/_shared/job-resume.ts
// Hvilke jobber pg_cron (resume-paused) og siden kan gjenoppta. En puls (45 s) kan dø uten å
// sette «paused» (Edge Function-timeout, krasj): jobben blir stående som «running». Funnet i
// book-update-jobben 15056b8e (2026-10-03): ingen livstegn på 20 minutter, og ingenting
// gjenopptok den. Derfor gjenopptas også «running»-jobber uten livstegn (jobs.heartbeat_at,
// satt av triggeren i migrasjonen 20261002150000) på over STALL_MS.
// Ren TypeScript (testes i scripts/).

/** Livstegn eldre enn dette (en puls varer 45 s) regnes som en død puls. */
export const STALL_MS = 3 * 60 * 1000;

/** PostgREST `.or(...)`-filter: pauset, eller «running» uten livstegn siden STALL_MS. */
export function resumableJobFilter(now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - STALL_MS).toISOString();
  return `status.eq.paused,and(status.eq.running,heartbeat_at.lt.${cutoff})`;
}
