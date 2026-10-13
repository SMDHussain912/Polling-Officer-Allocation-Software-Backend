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
function mapTeamsToStations(parties, pollingStations, randomInt) {
  const rand = checkRandomInt(randomInt);
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

module.exports = {
  shuffleInPlace: shuffleInPlace,
  defaultRandomInt: defaultRandomInt,
  mapTeamsToStations: mapTeamsToStations,
};
