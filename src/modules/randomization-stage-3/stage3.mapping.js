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
function mapTeamsToStations(parties, pollingStations, randomInt, maxAttempts) {
  const rand = checkRandomInt(randomInt);
  const attempts = maxAttempts || 50;
  const { normalizeMandal: mandalNormalize } = require('./stage3.mandal');

  // Pre-compute normalized mandals for all stations and party members to
  // avoid repeated normalization in the hot loop and to build better
  // error messages when no valid bijection exists.
  const normalizedStations = pollingStations.map(function (s) {
    return {
      stationId: s.stationId,
      stationCode: s.stationCode,
      stationMandal: mandalNormalize(s.mandal),
    };
  });

  const normalizedParties = parties.map(function (p) {
    const members = (p.members || []).map(function (m) {
      return {
        personnelId: m.personnelId,
        workMandal: mandalNormalize(m.workMandal || m.work_mandal),
        nativeMandal: mandalNormalize(m.nativeMandal || m.native_mandal),
      };
    });
    return {
      teamCode: p.teamCode,
      teamSize: p.teamSize,
      postingMandal: p.postingMandal,
      members: members,
    };
  });

  // Retry until a valid station↔team bijection is found, where the station's
  // mandal differs from EVERY member's work_mandal and native_mandal.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const shuffledParties = shuffleInPlace(normalizedParties.slice(), rand);
    const shuffledStations = shuffleInPlace(normalizedStations.slice(), rand);

    const pairCount = Math.min(shuffledParties.length, shuffledStations.length);
    const assignments = [];
    let allValid = true;

    for (let i = 0; i < pairCount; i += 1) {
      const party = shuffledParties[i];
      const station = shuffledStations[i];
      const stationMandal = station.stationMandal;

      // Constraint: duty mandal (station's mandal) must differ from each member's
      // working and native mandal. If ANY member is barred, this pairing fails.
      let partyCompatible = true;
      for (let j = 0; j < party.members.length; j += 1) {
        const m = party.members[j];
        if (stationMandal === m.workMandal || stationMandal === m.nativeMandal) {
          partyCompatible = false;
          break;
        }
      }

      if (!partyCompatible) {
        allValid = false;
        break;
      }

      assignments.push({
        teamCode: party.teamCode,
        teamSize: party.teamSize,
        postingMandal: party.postingMandal,
        stationId: station.stationId,
        stationCode: station.stationCode,
        stationMandal: station.stationMandal,
        publicationStatus: PUBLICATION_STATUS.CONFIDENTIAL,
      });
    }

    if (allValid) {
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
  }

  // No valid bijection found within maxAttempts. Build a detailed error
  // message explaining which mandals are conflicting.
  const stationMandals = new Set();
  for (const s of normalizedStations) {
    if (s.stationMandal) stationMandals.add(s.stationMandal);
  }
  const memberWorkMandals = new Set();
  const memberNativeMandals = new Set();
  for (const p of normalizedParties) {
    for (const m of p.members) {
      if (m.workMandal) memberWorkMandals.add(m.workMandal);
      if (m.nativeMandal) memberNativeMandals.add(m.nativeMandal);
    }
  }

  const conflictingStationMandals = [...stationMandals].filter(function (sm) {
    return normalizedParties.every(function (p) {
      return p.members.some(function (m) {
        return sm === m.workMandal || sm === m.nativeMandal;
      });
    });
  });
  const conflictingWorkMandals = [...memberWorkMandals].filter(function (wm) {
    return [...stationMandals].some(function (sm) { return sm === wm; });
  });
  const conflictingNativeMandals = [...memberNativeMandals].filter(function (nm) {
    return [...stationMandals].some(function (sm) { return sm === nm; });
  });

  let message = 'No polling station satisfies the duty-mandala ≠ work/native-mandala rule for all teams.';
  if (conflictingStationMandals.length > 0) {
    message += ' Station mandal(s) ' + conflictingStationMandals.join(', ') +
      ' conflict with officer work/native mandal(s) for every party.';
  } else if (conflictingWorkMandals.length > 0 || conflictingNativeMandals.length > 0) {
    message += ' Officer work mandal(s) ' + conflictingWorkMandals.join(', ') +
      ' and/or native mandal(s) ' + conflictingNativeMandals.join(', ') +
      ' conflict with station mandal(s).';
  } else {
    message += ' No valid one-to-one assignment found within ' + attempts + ' attempts.';
  }

  return {
    assignments: [],
    unmetRequirements: [{
      code: 'NO_VALID_STATION_ASSIGNMENT',
      count: parties.length,
      message: message,
    }],
  };
}

module.exports = {
  shuffleInPlace: shuffleInPlace,
  defaultRandomInt: defaultRandomInt,
  mapTeamsToStations: mapTeamsToStations,
};
