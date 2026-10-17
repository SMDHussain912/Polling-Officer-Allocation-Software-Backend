'use strict';

/**
 * Stage 3 — team↔station mapping engine (pure, testable, no I/O).
 *
 * Algorithm [O] (Annexure III p.80, "Mapping Teams with Polling Stations"):
 *  randomly map each polling station to one already-generated polling party.
 *
 *  1. Fisher–Yates shuffle the station list (injectable RNG for deterministic
 *     tests / audits).
 *  2. Assign the i-th shuffled station the i-th party (both shuffled) — a
 *     uniform random bijection over the shared prefix.
 *  3. If the number of parties and stations differ, only the smaller count is
 *     mapped one-to-one; the remainder is reported in unmetRequirements as an
 *     UNRESOLVED surplus/deficit — the engine NEVER invents how to handle the
 *     extra teams or stations.
 *
 * Confidentiality [O] (circular p.62): every produced assignment is created in
 * the CONFIDENTIAL state. Nothing here auto-publishes; reveal is a separate,
 * authorized action handled by the service layer.
 */

const { randomInt: cryptoRandomInt } = require('crypto');
const { PUBLICATION_STATUS } = require('./stage3.constants');

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

/**
 * Produce the one-to-one mapping. Returns { assignments, unmetRequirements }.
 * `assignments` entries carry ONLY teamCode + station identity + the
 * confidential publication state — never personnel or sensitive fields.
 */
function mapTeamsToStations(parties, pollingStations, randomInt, opts) {
  opts = opts || {};
  const adjacency = opts.adjacency || null; // stage2.adjacency lookup or null
  const membersByTeam = opts.membersByTeam || null; // { teamCode: [members] }
  const rand = checkRandomInt(randomInt);

  // --- Near-mandal mode: each team gets a station whose mandal is near EVERY
  // member's work/native mandal (and in none of their own). Greedy over
  // shuffled teams; leftovers are reported, never force-assigned.
  if (adjacency && adjacency.size > 0 && membersByTeam) {
    return mapTeamsToStationsNearMandal(parties, pollingStations, adjacency, membersByTeam, rand);
  }

  const shuffledParties = shuffleInPlace(parties.slice(), rand);
  const shuffledStations = shuffleInPlace(pollingStations.slice(), rand);

  const pairCount = Math.min(shuffledParties.length, shuffledStations.length);
  const assignments = [];
  for (let i = 0; i < pairCount; i += 1) {
    const party = shuffledParties[i];
    const station = shuffledStations[i];
    assignments.push({
      teamCode: party.teamCode,
      teamSize: party.teamSize,
      postingMandal: party.postingMandal,
      stationId: station.stationId,
      stationCode: station.stationCode,
      stationMandal: station.mandal,
      publicationStatus: PUBLICATION_STATUS.CONFIDENTIAL,
    });
  }

  const unmetRequirements = [];
  if (shuffledParties.length > shuffledStations.length) {
    const surplus = shuffledParties.slice(pairCount).map(function (p) { return p.teamCode; });
    unmetRequirements.push({
      code: 'TEAMS_WITHOUT_STATION',
      count: surplus.length,
      teamCodes: surplus,
      message: 'More polling parties than polling stations. Surplus handling is unresolved; ' +
        'no party was force-assigned.',
    });
  } else if (shuffledStations.length > shuffledParties.length) {
    const unstaffed = shuffledStations.slice(pairCount).map(function (s) { return s.stationId; });
    unmetRequirements.push({
      code: 'STATIONS_WITHOUT_TEAM',
      count: unstaffed.length,
      stationIds: unstaffed,
      message: 'More polling stations than polling parties. Deficit handling is unresolved; ' +
        'no station was double-staffed.',
    });
  }

  return { assignments: assignments, unmetRequirements: unmetRequirements };
}


/**
 * Near-mandal Stage 3 mapping. Shuffles teams, then for each team takes the
 * first still-free station passing stationEligibleForTeam (near every
 * member, in none of their home mandals). Unplaceable teams land in
 * unmetRequirements with code TEAMS_WITHOUT_NEAR_STATION.
 */
function mapTeamsToStationsNearMandal(parties, pollingStations, adjacency, membersByTeam, rand) {
  const adj = require('../randomization-stage-2/stage2.adjacency');
  const shuffledParties = shuffleInPlace(parties.slice(), rand);
  const shuffledStations = shuffleInPlace(pollingStations.slice(), rand);
  const taken = new Set();
  const assignments = [];
  const unplaced = [];
  for (const party of shuffledParties) {
    const members = membersByTeam[party.teamCode] || [];
    let placed = false;
    for (const station of shuffledStations) {
      if (taken.has(station.stationId)) continue;
      const check = adj.stationEligibleForTeam(station.mandal, members, adjacency);
      if (!check.ok) continue;
      taken.add(station.stationId);
      assignments.push({
        teamCode: party.teamCode,
        teamSize: party.teamSize,
        postingMandal: party.postingMandal,
        stationId: station.stationId,
        stationCode: station.stationCode,
        stationMandal: station.mandal,
        publicationStatus: PUBLICATION_STATUS.CONFIDENTIAL,
      });
      placed = true;
      break;
    }
    if (!placed) unplaced.push(party.teamCode);
  }
  const unmetRequirements = [];
  const freeStations = shuffledStations.filter(function (st) { return !taken.has(st.stationId); });
  if (unplaced.length > 0) {
    unmetRequirements.push({
      code: 'TEAMS_WITHOUT_NEAR_STATION',
      count: unplaced.length,
      teamCodes: unplaced,
      message: 'No free polling station in a mandal adjacent to every team member; ' +
        'these teams were not force-assigned.',
    });
  }
  if (freeStations.length > 0 && unplaced.length === 0 && shuffledParties.length < shuffledStations.length) {
    unmetRequirements.push({
      code: 'STATIONS_WITHOUT_TEAM',
      count: freeStations.length,
      stationIds: freeStations.map(function (st) { return st.stationId; }),
      message: 'More polling stations than polling parties. Deficit handling is unresolved; ' +
        'no station was double-staffed.',
    });
  }
  if (shuffledParties.length > shuffledStations.length) {
    const surplus = shuffledParties.slice(assignments.length + unplaced.length).map(function (p) { return p.teamCode; });
    if (surplus.length > 0) {
      unmetRequirements.push({
        code: 'TEAMS_WITHOUT_STATION',
        count: surplus.length,
        teamCodes: surplus,
        message: 'More polling parties than polling stations. Surplus handling is unresolved; ' +
          'no party was force-assigned.',
      });
    }
  }
  return { assignments: assignments, unmetRequirements: unmetRequirements };
}

module.exports = {
  shuffleInPlace: shuffleInPlace,
  defaultRandomInt: defaultRandomInt,
  mapTeamsToStations: mapTeamsToStations,
  mapTeamsToStationsNearMandal: mapTeamsToStationsNearMandal,
};
