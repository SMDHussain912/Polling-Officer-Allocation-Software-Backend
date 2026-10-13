'use strict';

/**
 * Stage 2 — party formation engine (pure, testable, no I/O).
 *
 * Algorithm: randomized greedy with retries.
 *  1. Shuffle PO-eligible candidates (Fisher-Yates, injectable RNG).
 *  2. For each party slot: pick the next eligible Presiding Officer, then
 *     greedily fill polling officers from a fresh shuffle, enforcing:
 *       (a) PO seniorityRank strictly lower (more senior) than every PO in
 *           the same party;
 *       (b) all members have distinct officeKey;
 *       (c) nobody posted to their work/native mandal.
 *  3. Retry whole formation up to maxAttempts with fresh shuffles; keep the
 *     best (most complete parties) attempt. Never relax a rule: shortfall is
 *     reported as INCOMPLETE with unmetRequirements.
 */

const { randomInt: cryptoRandomInt } = require('crypto');
const { TEAM_ROLES } = require('./stage2.constants');
const { isMandalBarred, normalizeMandal } = require('./stage2.mandal');

function shuffleInPlace(arr, randomInt) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function defaultRandomInt(maxExclusive) {
  return cryptoRandomInt(maxExclusive);
}

function checkRandomInt(fn) {
  if (fn === undefined || fn === null) return defaultRandomInt;
  if (typeof fn !== 'function') throw new Error('randomInt must be a function.');
  return fn;
}

function partyIsValid(members) {
  if (!members || members.length === 0) return false;
  const po = members[0];
  const offices = new Set();
  for (const m of members) {
    if (offices.has(m.officeKey)) return false;
    offices.add(m.officeKey);
  }
  for (let i = 1; i < members.length; i += 1) {
    if (!(po.seniorityRank < members[i].seniorityRank)) return false;
  }
  return true;
}

function tryFormOnce(pool, partySize, postings, randomInt, startIndex) {
  const avail = pool.slice();
  shuffleInPlace(avail, randomInt);
  const poEligible = avail.filter(function (e) { return e.presidingEligible; });
  const parties = [];
  const used = new Set();
  let postingIdx = startIndex || 0;
  const targetParties = postings.length > 0 ? postings.length : Number.MAX_SAFE_INTEGER;

  for (const po of poEligible) {
    if (parties.length >= targetParties) break;
    if (used.has(po.personnelKey)) continue;
    const posting = postings.length > 0 ? postings[postingIdx % postings.length] : null;
    const postingKey = posting ? posting.key : null;
    if (postingKey && isMandalBarred(po, postingKey)) continue;
    const members = [po];
    const usedOffices = new Set([po.officeKey]);
    const rest = avail.filter(function (e) { return !used.has(e.personnelKey) && e.personnelKey !== po.personnelKey; });
    shuffleInPlace(rest, randomInt);
    for (const cand of rest) {
      if (members.length >= partySize) break;
      if (usedOffices.has(cand.officeKey)) continue;
      if (!(po.seniorityRank < cand.seniorityRank)) continue;
      if (postingKey && isMandalBarred(cand, postingKey)) continue;
      members.push(cand);
      usedOffices.add(cand.officeKey);
    }
    if (members.length === partySize && partyIsValid(members)) {
      members.forEach(function (m) { used.add(m.personnelKey); });
      parties.push({ members: members, posting: posting });
      postingIdx += 1;
    }
  }
  const unassigned = avail.filter(function (e) { return !used.has(e.personnelKey); });
  return { parties: parties, unassigned: unassigned };
}

function formParties(pool, opts) {
  const partySize = opts.partySize;
  const postings = opts.postings || [];
  const randomInt = checkRandomInt(opts.randomInt);
  const maxAttempts = opts.maxAttempts || 50;
  const partiesRequested = opts.partiesRequested || 0;

  let best = { parties: [], unassigned: pool.slice() };
  for (let a = 0; a < maxAttempts; a += 1) {
    const attempt = tryFormOnce(pool, partySize, postings, randomInt, a);
    if (attempt.parties.length > best.parties.length) best = attempt;
    const want = partiesRequested > 0 ? partiesRequested : attempt.parties.length;
    if (partiesRequested > 0 && attempt.parties.length >= partiesRequested) {
      best = attempt;
      break;
    }
    if (partiesRequested === 0 && attempt.unassigned.length === 0) break;
    if (want > 0 && best.parties.length >= want) break;
  }
  if (partiesRequested > 0) {
    best.parties = best.parties.slice(0, partiesRequested);
    const usedKeys = new Set();
    best.parties.forEach(function (p) {
      p.members.forEach(function (m) { usedKeys.add(m.personnelKey); });
    });
    best.unassigned = pool.filter(function (e) { return !usedKeys.has(e.personnelKey); });
  }
  return best;
}

function formPartiesWithFallback(pool, opts) {
  // Phase 1: form as many full 6-member (1+5) parties as the rules allow.
  // Phase 2 (only when allowShortageFallback): from the leftover pool, form
  // 5-member (1+4) parties where ONE person carries the merged 3rd+4th duty
  // (MPTC + ZPTC ballot papers, circular p.59). Anyone still unfillable is
  // reported via unassigned — rules are never relaxed to force a party.
  const full = formParties(pool, {
    partySize: 6,
    postings: opts.postings,
    randomInt: opts.randomInt,
    maxAttempts: opts.maxAttempts,
    partiesRequested: 0,
  });
  if (!opts.allowShortageFallback) return { full: full, shortage: null };
  const usedKeys = new Set();
  full.parties.forEach(function (p) {
    p.members.forEach(function (m) { usedKeys.add(m.personnelKey); });
  });
  const leftover = pool.filter(function (e) { return !usedKeys.has(e.personnelKey); });
  if (leftover.length === 0) return { full: full, shortage: null };
  const shortage = formParties(leftover, {
    partySize: 5,
    postings: [],
    randomInt: opts.randomInt,
    maxAttempts: opts.maxAttempts,
    partiesRequested: 0,
  });
  return { full: full, shortage: shortage };
}

function buildTeamCode(prefix, electionShort, seq) {
  const n = String(seq).padStart(3, '0');
  return prefix + '-' + electionShort + '-' + n;
}

function electionShortOf(electionConfigurationId) {
  const s = String(electionConfigurationId).replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase();
  return s || 'EC';
}

function roleForSlot(slotIndex, pollingOfficersPerParty) {
  // slotIndex 0 = Presiding Officer; 1..N = 1st..Nth Polling Officer.
  // Shortage 1+4: slots are 1st, 2nd, 3rd(merged), 5th — no 4th role.
  if (slotIndex === 0) return TEAM_ROLES.PRESIDING_OFFICER;
  if (pollingOfficersPerParty === 4) {
    if (slotIndex === 1) return TEAM_ROLES.POLLING_OFFICER_1;
    if (slotIndex === 2) return TEAM_ROLES.POLLING_OFFICER_2;
    if (slotIndex === 3) return TEAM_ROLES.POLLING_OFFICER_3;
    return TEAM_ROLES.POLLING_OFFICER_5;
  }
  if (slotIndex === 1) return TEAM_ROLES.POLLING_OFFICER_1;
  if (slotIndex === 2) return TEAM_ROLES.POLLING_OFFICER_2;
  if (slotIndex === 3) return TEAM_ROLES.POLLING_OFFICER_3;
  if (slotIndex === 4) return TEAM_ROLES.POLLING_OFFICER_4;
  return TEAM_ROLES.POLLING_OFFICER_5;
}

function dutyForSlot(slotIndex, pollingOfficersPerParty) {
  const duties = require('./stage2.duties');
  if (slotIndex === 0) return duties.PRESIDING_OFFICER_DUTY;
  if (pollingOfficersPerParty === 4) {
    if (slotIndex === 1) return duties.POLLING_OFFICER_DUTIES[1];
    if (slotIndex === 2) return duties.POLLING_OFFICER_DUTIES[2];
    if (slotIndex === 3) return duties.SHORTAGE_MERGED_DUTY_3;
    return duties.POLLING_OFFICER_DUTIES[5];
  }
  return duties.POLLING_OFFICER_DUTIES[slotIndex] || null;
}

function toExcelRows(parties) {
  const rows = [];
  for (const p of parties) {
    p.members.forEach(function (m) {
      rows.push({
        teamCode: p.teamCode,
        mandal: p.postingMandal,
        role: m.role,
        duty: m.duty === undefined ? null : m.duty,
        employeeId: m.personnelId,
        name: m.name,
        designation: m.designation,
        office: m.officeName,
      });
    });
  }
  return rows;
}

module.exports = {
  formParties: formParties,
  formPartiesWithFallback: formPartiesWithFallback,
  partyIsValid: partyIsValid,
  roleForSlot: roleForSlot,
  dutyForSlot: dutyForSlot,
  buildTeamCode: buildTeamCode,
  electionShortOf: electionShortOf,
  toExcelRows: toExcelRows,
  normalizeMandal: normalizeMandal,
};
