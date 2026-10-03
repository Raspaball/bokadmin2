// node --test scripts/*.test.mjs
// Døde pulser: «running» uten livstegn gjenopptas av resume-paused (_shared/job-resume.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { STALL_MS, resumableJobFilter } from "../supabase/functions/_shared/job-resume.ts";

test("filteret tar pauset og running med livstegn eldre enn 3 minutter", () => {
  const now = new Date("2026-10-03T03:00:00.000Z");
  assert.equal(STALL_MS, 180000);
  assert.equal(resumableJobFilter(now), "status.eq.paused,and(status.eq.running,heartbeat_at.lt.2026-10-03T02:57:00.000Z)");
});
