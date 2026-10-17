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
=======
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
