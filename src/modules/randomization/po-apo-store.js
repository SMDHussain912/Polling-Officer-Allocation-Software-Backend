'use strict';

/**
 * PO / APO roster persistence (Stage 2 output -> po_officers / apo_officers).
 *
 * At randomization time the run learns who is PO (slot 0) and APO (slot 1).
 * Those rosters are written here with the FULL personnel row (all ~30
 * personnel columns, INCLUDING aadhar_number / voter_id / mobile_no).
 *
 * GOVERNMENT-ONLY by explicit authority decision. Never call this from a
 * staff/read-only route, and never return these rows from a staff endpoint.
 * Fail-closed: any persist error is reported loudly, never swallowed.
 */

const PO_TABLE = 'po_officers';
const APO_TABLE = 'apo_officers';

// All personnel columns to snapshot (mirrors migration 002), including
// sensitive aadhar_number / voter_id / mobile_no (GOVERNMENT-ONLY).
const PERSONNEL_SNAPSHOT_COLS = [
  'district', 'is_active', 'exempt_category', 'sl_no', 'employee_id',
  'employee_name', 'designation', 'gender', 'age', 'aadhar_number',
  'languages_known', 'employment_sector', 'scale_of_pay', 'basic_pay',
  'gazetted_status', 'date_of_birth', 'date_of_retirement',
  'employment_type', 'enrolled_assembly_constituency', 'part_no_vote_sl_no',
  'voter_id', 'residence_address', 'residence_constituency_code',
  'residence_constituency_name', 'work_mandal', 'working_constituency_code',
  'working_constituency_name', 'native_mandal', 'native_constituency_code',
  'native_constituency_name', 'previous_po_duty', 'mobile_no',
  'service_in_district_4y', 'ph_category', 'criminal_case_or_eci_orders',
  'exceeded_3_years', 'eci_ceo_order_details', 'remarks',
];

function emptyRunStats() {
  return { po: 0, apo: 0, poErrors: null, apoErrors: null };
}

/**
 * Persist this run's PO/APO rosters.
 *
 * @param {object} args
 * @param {object} args.poolTx  pg client/pool with .query (or a stub in tests)
 * @param {Array}  args.parties  Stage 2 parties (member[0] = PO, member[1] = APO)
 * @param {string|number} args.personnelBatchId personnel import batch the run read
 * @param {number|string} args.districtId        district scope
 * @param {string} args.runId                    randomization run id (may be null)
 * @returns {Promise<object>} { po, apo, poErrors, apoErrors }
 */
async function persistPoApoRosters(args) {
  const poolTx = args.poolTx;
  const parties = Array.isArray(args.parties) ? args.parties : [];
  const personnelBatchId = args.personnelBatchId;
  const districtId = args.districtId;
  const runId = args.runId || null;
  const stats = emptyRunStats();
  if (!poolTx || typeof poolTx.query !== 'function') {
    stats.poErrors = stats.apoErrors = 'No database handle (pool.query missing).';
    return stats;
  }
  if (parties.length === 0) return stats;

  // Full personnel rows for everyone the run touched (sensitive INCLUDED).
  const cols = PERSONNEL_SNAPSHOT_COLS.join(', ');
  let personnelRows;
  try {
    const res = await poolTx.query(
      'SELECT ' + cols + ' FROM personnel WHERE import_batch_id = $1 AND district = $2 LIMIT 5000',
      [personnelBatchId, districtId]
    );
    personnelRows = res.rows || [];
  } catch (err) {
    stats.poErrors = stats.apoErrors = 'Failed to read personnel for PO/APO rosters: ' + err.message;
    return stats;
  }
  const byEmployeeId = new Map();
  for (const r of personnelRows) {
    if (r && r.employee_id !== undefined && r.employee_id !== null) {
      byEmployeeId.set(String(r.employee_id), r);
    }
  }

  // PO = member[0], APO = member[1] of every formed party.
  const jobs = [];
  for (const party of parties) {
    const members = (party && party.members) || [];
    if (members.length < 2) continue;
    const poMember = members[0];
    const apoMember = members[1];
    const poRow = byEmployeeId.get(String(poMember.personnelId));
    const apoRow = byEmployeeId.get(String(apoMember.personnelId));
    if (poRow) {
      jobs.push({ table: PO_TABLE, row: poRow, party: party, runId: runId });
    } else {
      stats.poErrors = (stats.poErrors ? stats.poErrors + '; ' : '') +
        'PO ' + poMember.personnelId + ' not found in personnel batch ' + personnelBatchId;
    }
    if (apoRow) {
      jobs.push({ table: APO_TABLE, row: apoRow, party: party, runId: runId });
    } else {
      stats.apoErrors = (stats.apoErrors ? stats.apoErrors + '; ' : '') +
        'APO ' + apoMember.personnelId + ' not found in personnel batch ' + personnelBatchId;
    }
  }

  for (const job of jobs) {
    const data = Object.assign({}, job.row, {
      run_id: job.runId,
      team_code: job.party.teamCode || null,
      posting_mandal: job.party.postingMandal || null,
    });
    const columns = ['run_id', 'team_code', 'posting_mandal'].concat(PERSONNEL_SNAPSHOT_COLS);
    try {
      const existing = await poolTx.query(
        'SELECT id FROM ' + job.table + ' WHERE run_id IS NOT DISTINCT FROM $1 AND employee_id = $2 LIMIT 1',
        [job.runId, String(data.employee_id)]
      );
      if (existing.rows && existing.rows.length > 0) {
        const setClause = columns.map(function (c, i) { return c + ' = $' + (i + 2); }).join(', ');
        const values = [existing.rows[0].id].concat(columns.map(function (c) { return data[c] !== undefined ? data[c] : null; }));
        await poolTx.query('UPDATE ' + job.table + ' SET ' + setClause + ' WHERE id = $1', values);
      } else {
        const placeholders = columns.map(function (_, i) { return '$' + (i + 1); }).join(', ');
        const values = columns.map(function (c) { return data[c] !== undefined ? data[c] : null; });
        await poolTx.query('INSERT INTO ' + job.table + ' (' + columns.join(', ') + ') VALUES (' + placeholders + ')', values);
      }
      if (job.table === PO_TABLE) stats.po += 1;
      else stats.apo += 1;
    } catch (err) {
      const msg = 'Failed to persist ' + job.table + ' row for ' + data.employee_id + ': ' + err.message;
      if (job.table === PO_TABLE) {
        stats.poErrors = (stats.poErrors ? stats.poErrors + '; ' : '') + msg;
      } else {
        stats.apoErrors = (stats.apoErrors ? stats.apoErrors + '; ' : '') + msg;
      }
    }
  }
  return stats;
}

module.exports = { persistPoApoRosters, PO_TABLE, APO_TABLE, PERSONNEL_SNAPSHOT_COLS };