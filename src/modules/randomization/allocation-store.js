'use strict';

/**
 * In-memory allocation store (shared by the randomization router + reports).
 *
 * Holds ONLY the most recent completed run and its publish record. Nothing
 * sensitive is stored here — the orchestrator never reads Aadhaar / voter ID /
 * mobile columns, so they cannot leak in.
 *
 * This store is intentionally transient (lost on restart). A durable schema
 * for runs/results is a prepared, unapplied migration — see Phase 12 notes.
 */

const store = {
  lastRun: null,      // { runAt, runBy, stage1, stage2, stage3, auditEvents }
  publication: null,  // { publishedStage3, confirmedBy, confirmedAt }
};

function recordRun(entry) {
  store.lastRun = entry;
  store.publication = null; // a new run supersedes any earlier publication
  return store.lastRun;
}

function recordPublication(publishedStage3, confirmedBy) {
  if (!store.lastRun) return null;
  store.publication = {
    publishedStage3: publishedStage3,
    confirmedBy: confirmedBy,
    confirmedAt: new Date().toISOString(),
  };
  return store.publication;
}

function getLastRun() { return store.lastRun; }
function getPublication() { return store.publication; }

module.exports = { recordRun, recordPublication, getLastRun, getPublication };
