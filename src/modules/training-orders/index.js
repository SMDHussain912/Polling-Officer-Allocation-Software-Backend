'use strict';

/**
 * Training orders — PO / APO allocation + per-officer DOCX print + ZIP download.
 *
 * Spec: TRAINING-ORDERS-ANALYSIS.md
 *  - Separate tables: po_* / apo_*
 *  - Allocate from last Stage-2 excelRows (duty/posting mandal); skip MO
 *  - Re-allocate = wipe all six tables then refill
 *  - Print = built-in tagged templates, one DOCX per officer, auto SL
 *  - Download = ZIP of generated orders
 *  - Config from .env via src/config
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PizZip = require('pizzip');
const pool = require('../../database');
const config = require('../../config');
const { getLastRun, hydrateOnce, latestStageTables } = require('../randomization/allocation-store');
const { mergeDocx } = require('../imports/order-merge.service');

const MAX_BATCH_SIZE = 100;

const TABLES = Object.freeze({
  PO: {
    batches: 'po_training_batches',
    members: 'po_training_batch_members',
    orders: 'po_training_orders',
    template: path.join(__dirname, '../../../docs/po-order-tagged.docx'),
  },
  APO: {
    batches: 'apo_training_batches',
    members: 'apo_training_batch_members',
    orders: 'apo_training_orders',
    template: path.join(__dirname, '../../../docs/apo-order-tagged.docx'),
  },
});

function tablesFor(group) {
  const g = String(group || '').toUpperCase();
  if (g !== 'PO' && g !== 'APO') {
    const err = new Error('group must be PO or APO');
    err.statusCode = 400;
    throw err;
  }
  return TABLES[g];
}

/** Classify Stage-2 role → PO | APO | MO (skip). */
function classifyRole(role) {
  const r = String(role || '').toLowerCase();
  if (r.includes('micro') && r.includes('observer')) return 'MO';
  if (r === 'mo' || r.startsWith('micro observer')) return 'MO';
  if (r.includes('presid')) return 'PO';
  return 'APO';
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** Parse TRAINING_DATE (dd.mm.yyyy or yyyy-mm-dd) → { dd, mm, yyyy, weekday }. */
function parseTrainingDate(raw) {
  const s = String(raw || '').trim();
  let d = null;
  let m = null;
  let y = null;
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  const ymd = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (dmy) {
    d = dmy[1].padStart(2, '0');
    m = dmy[2].padStart(2, '0');
    y = dmy[3];
  } else if (ymd) {
    y = ymd[1];
    m = ymd[2].padStart(2, '0');
    d = ymd[3].padStart(2, '0');
  }
  let weekday = '';
  if (d && m && y) {
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    if (!Number.isNaN(dt.getTime())) {
      weekday = dt.toLocaleDateString('en-IN', { weekday: 'long' });
    }
  }
  return { dd: d || '', mm: m || '', yyyy: y || '', weekday };
}

function envMergeDefaults() {
  const training = config.training || {};
  const orders = config.orders || {};
  const parsed = parseTrainingDate(training.date);
  const year =
    config.electionYear ||
    parsed.yyyy ||
    String(new Date().getFullYear());
  const district = config.districtName || 'Kakinada';
  return {
    district,
    order_date: config.orderDate || orders.pollingDateTime || '',
    order_place: config.orderPlace || district,
    election_year: year,
    training_dd: parsed.dd,
    training_mm: parsed.mm,
    training_yyyy: parsed.yyyy,
    training_weekday: parsed.weekday,
    training_time_from: training.timeFrom || '',
    training_time_to: training.timeTo || '',
  };
}

/**
 * Wipe all PO + APO training batch/member/order rows (cascade members via FK).
 */
async function wipeAllTraining(client) {
  await client.query('DELETE FROM po_training_orders');
  await client.query('DELETE FROM apo_training_orders');
  await client.query('DELETE FROM po_training_batch_members');
  await client.query('DELETE FROM apo_training_batch_members');
  await client.query('DELETE FROM po_training_batches');
  await client.query('DELETE FROM apo_training_batches');
}

/**
 * Wipe every table EXCEPT `users` and `roles` (auth tables must be kept so
 * admins can still log in). Uses TRUNCATE ... CASCADE so FK-dependent rows
 * are removed automatically. Returns the list of tables that were truncated.
 */
async function wipeAllData() {
  // Keep users/roles (auth) AND randomization source tables — wiping them
  // destroys allocation_runs / stage2_team_members / stage3_assignments and
  // makes Training show "No completed randomization run found" after allocate.
  const protectedTables = new Set([
    'users',
    'roles',
    'allocation_runs',
    'stage2_team_members',
    'stage3_assignments',
  ]);
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  const toTruncate = rows
    .map((r) => r.tablename)
    .filter((name) => !protectedTables.has(name));
  if (toTruncate.length === 0) return { truncated: [] };
  const quoted = toTruncate.map((n) => `"${n}"`).join(', ');
  console.debug("[WIPE-ALL-DATA] truncating tables:", toTruncate);
  await pool.query(`TRUNCATE TABLE ${quoted} CASCADE`);
  console.debug("[WIPE-ALL-DATA] truncated", toTruncate.length, "tables");
  return { truncated: toTruncate };
}

async function loadPersonnelByEmployeeIds(client, employeeIds) {
  const ids = [...new Set(employeeIds.map((x) => String(x).trim()).filter(Boolean))];
  const map = new Map();
  if (ids.length === 0) return map;
  const r = await client.query(
    `SELECT p.id, p.employee_id, p.employee_name, p.designation, p.mobile_no,
            p.work_mandal, p.residence_address, b.department_name
       FROM personnel p
       LEFT JOIN import_batches b ON b.id = p.import_batch_id
      WHERE p.employee_id = ANY($1::text[])`,
    [ids]
  );
  for (const row of r.rows) {
    map.set(String(row.employee_id).trim(), row);
  }
  return map;
}

/**
 * Allocate: wipe → split Stage-2 rows into PO/APO by duty mandal → batches ≤100.
 */
async function allocateTraining({ createdBy } = {}) {
  console.debug("[ALLOCATE] starting allocateTraining, createdBy:", createdBy);
  await hydrateOnce();

  // Source priority: normalized Stage 2/3 DB tables (migration 014) first —
  // they carry the stored training_group + duty mandal per officer and prove
  // Stage 2/3 actually persisted. Fall back to last-run JSON only when the
  // run predates migration 014.
  let teamRows = [];
  let source = 'none';
  let stageRunId = null;
  try {
    const tables = await latestStageTables();
    console.debug('[ALLOCATE] latestStageTables rows:', tables ? tables.rows.length : 0, 'runId:', tables ? tables.runId : null);
    if (tables && tables.rows.length > 0) {
      stageRunId = tables.runId;
      source = 'stage_tables';
      teamRows = tables.rows.map((r) => ({
        teamCode: r.team_code,
        mandal: r.mandal,
        role: r.role,
        duty: r.duty,
        employeeId: r.employee_id,
        trainingGroup: r.training_group,
        // Stage 3 enrichment: officer's real duty station (mandal) + ballot ID
        // (station / venue code) from the published Stage-3 allotment.
        dutyMandal: r.station_mandal || '',
        venueCode: r.station_code || '',
      }));
    }
  } catch (err) {
    // Table read failed (e.g. migration not applied) — fall through to JSON.
    if (process.env.NODE_ENV !== 'test') {
      console.warn('allocateTraining: stage tables unreadable, trying run JSON (' + (err.message || err) + ')');
    }
  }
  if (teamRows.length === 0) {
    const lastRun = getLastRun();
    let jsonRows = [];
    let jsonSource = 'none';
    if (lastRun && lastRun.stage2) {
      // Prefer excelRows (legacy run-JSON format); fall back to parties
      // (the actual Stage 2 structure the run produces). excelRows never
      // exists in current code — persistStageTables writes stage2.parties
      // to the DB instead — so this fallback is what makes Training see
      // data when migration 014 stage tables are unavailable.
      if (Array.isArray(lastRun.stage2.excelRows)) {
        jsonRows = lastRun.stage2.excelRows;
        jsonSource = 'excelRows';
      } else if (Array.isArray(lastRun.stage2.parties)) {
        let partyIdx = 0;
        for (const p of lastRun.stage2.parties) {
          const teamCode = `T${String(partyIdx + 1).padStart(3, '0')}`;
          const mandal = String(p.posting || 'UNSPECIFIED').trim() || 'UNSPECIFIED';
          for (const m of p.members || []) {
            jsonRows.push({
              employeeId: m.personnelId || m.employee_id || null,
              employee_id: m.personnelId || m.employee_id || null,
              role: m.role || 'Polling Officer',
              duty: m.duty || null,
              teamCode,
              training_group: classifyRole(m.role),
              trainingGroup: classifyRole(m.role),
              mandal,
              dutyMandal: '',
              venueCode: '',
            });
          }
          partyIdx += 1;
        }
        jsonSource = 'parties';
      }
    }
    console.debug('[ALLOCATE] JSON fallback rows:', jsonRows.length, 'source:', jsonSource);
    if (jsonRows.length > 0) {
      source = 'run_json';
      teamRows = jsonRows;
    }
  }
  if (teamRows.length === 0) {
    // Diagnostics: what does the DB actually contain? Helps the operator
    // tell whether (a) no run was ever saved, (b) migrations are missing,
    // or (c) stage tables exist but are empty.
    let dbState = null;
    try {
      const runs = await pool.query('SELECT COUNT(*)::int AS c FROM allocation_runs');
      const s2m = await pool.query('SELECT COUNT(*)::int AS c FROM stage2_team_members');
      const s3a = await pool.query('SELECT COUNT(*)::int AS c FROM stage3_assignments');
      const lastRun = getLastRun();
      const jsonExcelRows = lastRun && lastRun.stage2 && Array.isArray(lastRun.stage2.excelRows)
        ? lastRun.stage2.excelRows.length
        : (lastRun ? 0 : null);
      const jsonParties = lastRun && lastRun.stage2 && Array.isArray(lastRun.stage2.parties)
        ? lastRun.stage2.parties.length
        : (lastRun ? 0 : null);
      dbState = {
        allocationRunsRows: Number(runs.rows[0].c),
        stage2TeamMembersRows: Number(s2m.rows[0].c),
        stage3AssignmentsRows: Number(s3a.rows[0].c),
        inMemoryRun: !!lastRun,
        inMemoryRunStage2ExcelRows: jsonExcelRows,
        inMemoryRunStage2Parties: jsonParties,
      };
    } catch (diagErr) {
      dbState = { error: diagErr.message || String(diagErr) };
    }

    const hints = [];
    if (source === 'none') {
      hints.push(
        'No Stage 2/3 data source was found. Check that migrations 012 (allocation_runs) and 014 (stage results) are applied to the database, then run POST /api/randomization/run.'
      );
    } else if (source === 'run_json') {
      hints.push(
        'A run exists but its Stage-2 excelRows is empty — re-run POST /api/randomization/run so Stage 2/3 rows persist to the stage tables.'
      );
    } else {
      hints.push(
        'Stage tables exist but are empty — re-run POST /api/randomization/run so Stage 2/3 rows persist.'
      );
    }
    return {
      batches: [],
      errors: [
        'No completed randomization run found. Run Stage 2/3 first (POST /api/randomization/run).',
        ...hints,
      ],
      skippedMo: 0,
      unresolved: 0,
      source,
      stageRunId,
      dbState,
    };
  }

  const groups = { PO: [], APO: [] };
  let skippedMo = 0;
  for (const row of teamRows) {
    // DB-table rows carry the stored training_group (classified at run time);
    // run-JSON rows are classified live. Both skip MO.
    const kind = row.trainingGroup === 'PO' || row.trainingGroup === 'APO'
      ? row.trainingGroup
      : row.trainingGroup === 'MO'
        ? 'MO'
        : classifyRole(row.role);
    if (kind === 'MO') {
      skippedMo += 1;
      continue;
    }
    groups[kind].push(row);
  }

  const allEmpIds = [...groups.PO, ...groups.APO].map((r) => r.employeeId);
  const client = await pool.connect();
  const batches = [];
  let unresolved = 0;
  try {
    await client.query('BEGIN');
    await wipeAllTraining(client);
    const personnelMap = await loadPersonnelByEmployeeIds(client, allEmpIds);

    for (const group of ['PO', 'APO']) {
      const t = TABLES[group];
      const members = groups[group];
      if (members.length === 0) continue;
      const byMandal = new Map();
      for (const m of members) {
        const mandal = String(m.mandal || 'UNSPECIFIED').trim() || 'UNSPECIFIED';
        if (!byMandal.has(mandal)) byMandal.set(mandal, []);
        byMandal.get(mandal).push(m);
      }
      for (const [mandal, officers] of byMandal) {
        const shuffled = shuffleInPlace(officers.slice());
        let batchNo = 1;
        for (let start = 0; start < shuffled.length; start += MAX_BATCH_SIZE) {
          const chunk = shuffled.slice(start, start + MAX_BATCH_SIZE);
          const b = await client.query(
            `INSERT INTO ${t.batches} (batch_no, mandal, created_by)
             VALUES ($1, $2, $3) RETURNING id`,
            [batchNo, mandal, createdBy == null ? null : createdBy]
          );
          const batchId = b.rows[0].id;
          let inserted = 0;
          for (const officer of chunk) {
            const empKey = String(officer.employeeId || '').trim();
            const per = personnelMap.get(empKey);
            if (!per) {
              unresolved += 1;
              continue;
            }
            await client.query(
              `INSERT INTO ${t.members}
                 (batch_id, personnel_id, employee_id, role, team_code,
                  duty_mandal, venue_code, added_by_code)
               VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
               ON CONFLICT DO NOTHING`,
              [
                batchId,
                per.id,
                per.employee_id,
                officer.role || null,
                officer.teamCode || null,
                officer.dutyMandal || null,
                officer.venueCode || null,
              ]
            );
            inserted += 1;
          }
          batches.push({
            id: batchId,
            batch_no: batchNo,
            mandal,
            group,
            officer_count: inserted,
          });
          batchNo += 1;
        }
      }
    }

    await client.query('COMMIT');
    return { batches, errors: [], skippedMo, unresolved, source, stageRunId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { batches, errors: [err.message], skippedMo, unresolved, source, stageRunId };
  } finally {
    client.release();
  }
}

/** List batches for PO or APO (with location name + member count). */
async function listBatches(group) {
  const t = tablesFor(group);
  const r = await pool.query(
    `SELECT b.id, b.batch_no, b.mandal, b.location_id, l.location_name,
            (SELECT COUNT(*)::int FROM ${t.members} m WHERE m.batch_id = b.id) AS member_count,
            b.created_at
       FROM ${t.batches} b
       LEFT JOIN training_locations l ON l.id = b.location_id
      ORDER BY b.mandal, b.batch_no`
  );
  return { group: String(group).toUpperCase(), batches: r.rows };
}

/** List members of one batch. */
async function listBatchMembers(group, batchId) {
  const t = tablesFor(group);
  const id = Number(batchId);
  if (!Number.isSafeInteger(id)) {
    const err = new Error('batchId must be a number');
    err.statusCode = 400;
    throw err;
  }
  const b = await pool.query(`SELECT id, batch_no, mandal, location_id FROM ${t.batches} WHERE id = $1`, [id]);
  if (b.rows.length === 0) {
    const err = new Error('Batch not found');
    err.statusCode = 404;
    throw err;
  }
  const m = await pool.query(
    `SELECT m.personnel_id, m.employee_id, m.role, m.team_code,
            p.employee_name, p.designation, p.native_mandal, p.work_mandal, p.mobile_no,
            -- Stage 3 allotment: officer's real duty station + mandal (join via
            -- team_code on the latest run that mapped this team).
            a.station_code AS venue_code, a.station_mandal AS duty_mandal
       FROM ${t.members} m
       JOIN personnel p ON p.id = m.personnel_id
       LEFT JOIN LATERAL (
         SELECT sa.station_code, sa.station_mandal
           FROM stage3_assignments sa
          WHERE sa.team_code = m.team_code
          ORDER BY sa.run_id DESC
          LIMIT 1
       ) a ON TRUE
      WHERE m.batch_id = $1
      ORDER BY p.employee_name`,
    [id]
  );
  return { group: String(group).toUpperCase(), batch: b.rows[0], members: m.rows };
}

/** Same-mandal locations for a batch. */
async function listBatchLocations(group, batchId) {
  const t = tablesFor(group);
  const id = Number(batchId);
  const b = await pool.query(`SELECT id, mandal FROM ${t.batches} WHERE id = $1`, [id]);
  if (b.rows.length === 0) {
    const err = new Error('Batch not found');
    err.statusCode = 404;
    throw err;
  }
  const mandal = b.rows[0].mandal;
  const locs = await pool.query(
    `SELECT id, location_name, panchayat, mandal, category
       FROM training_locations
      WHERE LOWER(TRIM(mandal)) = LOWER(TRIM($1))
      ORDER BY location_name`,
    [mandal]
  );
  return { locations: locs.rows, mandal };
}

/** Assign / clear location (same-mandal guard). */
async function assignBatchLocation(group, batchId, locationId) {
  const t = tablesFor(group);
  const id = Number(batchId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query(
      `SELECT id, mandal FROM ${t.batches} WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (b.rows.length === 0) {
      const err = new Error('Batch not found');
      err.statusCode = 404;
      throw err;
    }
    let locId = locationId == null || locationId === '' ? null : Number(locationId);
    if (locId !== null) {
      if (!Number.isSafeInteger(locId)) {
        const err = new Error('locationId must be a number or null');
        err.statusCode = 400;
        throw err;
      }
      const loc = await client.query(
        `SELECT id, mandal FROM training_locations WHERE id = $1`,
        [locId]
      );
      if (loc.rows.length === 0) {
        const err = new Error('Location not found');
        err.statusCode = 404;
        throw err;
      }
      if (
        String(loc.rows[0].mandal || '').trim().toLowerCase() !==
        String(b.rows[0].mandal || '').trim().toLowerCase()
      ) {
        const err = new Error('Location mandal must match batch duty mandal');
        err.statusCode = 400;
        throw err;
      }
    }
    await client.query(`UPDATE ${t.batches} SET location_id = $1 WHERE id = $2`, [locId, id]);
    await client.query('COMMIT');
    return { ok: true, batchId: id, locationId: locId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function officeAddressFor(per) {
  const dept = (per.department_name && String(per.department_name).trim()) || '';
  if (dept) return dept;
  return '';
}

function designationDeptFor(per) {
  const desig = (per.designation && String(per.designation).trim()) || '';
  const dept = (per.department_name && String(per.department_name).trim()) || '';
  if (desig && dept) return `${desig} / ${dept}`;
  return desig || dept || '';
}

/**
 * Generate one DOCX per officer for PO or APO. Replaces prior orders for that group.
 * Returns { generated, skippedNoLocation, errors }.
 */
async function generateOrders({ group, createdBy } = {}) {
  const t = tablesFor(group);
  const g = String(group).toUpperCase();
  if (!fs.existsSync(t.template)) {
    const err = new Error(`Built-in template missing: ${path.basename(t.template)}`);
    err.statusCode = 500;
    throw err;
  }
  const templateBytes = fs.readFileSync(t.template);
  const defaults = envMergeDefaults();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Wipe prior generated orders for this group only (batches stay).
    await client.query(`DELETE FROM ${t.orders}`);

    const rows = await client.query(
      `SELECT m.personnel_id, m.employee_id, m.role, m.team_code, m.batch_id,
              b.mandal AS batch_mandal, b.batch_no,
              -- Stage 3 duty mandal (station_mandal) is the officer's real duty
              -- mandal; fall back to the batch (Stage-2 posting) mandal when not
              -- yet allotted. venue_code is the Stage-3 station / ballot ID.
              COALESCE(m.duty_mandal, b.mandal) AS duty_mandal,
              l.location_name AS venue,
              m.venue_code AS venue_code,
              p.employee_name, p.designation, p.mobile_no, p.work_mandal,
              ib.department_name
         FROM ${t.members} m
         JOIN ${t.batches} b ON b.id = m.batch_id
         JOIN personnel p ON p.id = m.personnel_id
         LEFT JOIN training_locations l ON l.id = b.location_id
         LEFT JOIN import_batches ib ON ib.id = p.import_batch_id
        ORDER BY b.mandal, b.batch_no, p.employee_name`
    );

    let sl = 0;
    let generated = 0;
    let skippedNoLocation = 0;
    const errors = [];

    for (const row of rows.rows) {
      if (!row.venue) {
        skippedNoLocation += 1;
        // Still print with blank venue (fail-soft on venue) — user can assign later and re-generate.
      }
      sl += 1;
      const per = {
        department_name: row.department_name,
        designation: row.designation,
      };
      const data = {
        ...defaults,
        sl_no: String(sl),
        employee_id: row.employee_id || '',
        employee_name: row.employee_name || '',
        designation_dept: designationDeptFor(per),
        office_address: officeAddressFor(per),
        mobile_no: row.mobile_no || '',
        training_venue: row.venue || '',
        duty_mandal: row.duty_mandal || '',
        venue_code: row.venue_code || '',
        ack_name: row.employee_name || '',
        ack_designation: row.designation || '',
        ack_mobile: row.mobile_no || '',
        ack_work_mandal: row.work_mandal || '',
      };
      let docx;
      try {
        docx = mergeDocx(templateBytes, data);
      } catch (e) {
        errors.push(`personnel ${row.personnel_id}: ${e.message}`);
        continue;
      }
      const orderId = `TR-${g}-${Date.now().toString(36).toUpperCase()}-${crypto.randomInt(100000, 999999)}-${sl}`;
      await client.query(
        `INSERT INTO ${t.orders}
           (order_id, sl_no, batch_id, personnel_id, employee_id, employee_name,
            mandal, venue, venue_code, status, order_docx, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'generated',$10,$11,now(),now())`,
        [
          orderId,
          sl,
          row.batch_id,
          row.personnel_id,
          row.employee_id,
          row.employee_name,
          row.duty_mandal,
          row.venue || null,
          row.venue_code || null,
          docx,
          createdBy == null ? null : createdBy,
        ]
      );
      generated += 1;
    }

    await client.query('COMMIT');
    return { group: g, generated, skippedNoLocation, errors, totalMembers: rows.rows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** List stored orders (optional group filter). */
async function listTrainingOrders({ group, page = 1, perPage = 50 } = {}) {
  const pageN = Math.max(1, Number(page) || 1);
  const per = Math.min(200, Math.max(1, Number(perPage) || 50));
  const offset = (pageN - 1) * per;

  async function fromTable(g) {
    const t = TABLES[g];
    const count = await pool.query(`SELECT COUNT(*)::int AS c FROM ${t.orders}`);
    const rows = await pool.query(
      `SELECT id, order_id, sl_no, batch_id, personnel_id, employee_id, employee_name,
              mandal, venue_code, venue, status, created_at,
              '${g}' AS training_group
         FROM ${t.orders}
        ORDER BY sl_no ASC, id ASC
        LIMIT $1 OFFSET $2`,
      [per, offset]
    );
    return { total: count.rows[0].c, orders: rows.rows };
  }

  if (group) {
    const g = String(group).toUpperCase();
    tablesFor(g);
    const part = await fromTable(g);
    return {
      orders: part.orders,
      page: pageN,
      perPage: per,
      total: part.total,
      totalPages: Math.ceil(part.total / per) || 1,
    };
  }

  // Both groups — single paginated UNION ALL so page > 1 actually pages through
  // all PO + APO orders instead of re-fetching offset 0 on every page.
  const countR = await pool.query(
    `SELECT (SELECT COUNT(*) FROM po_training_orders) +
             (SELECT COUNT(*) FROM apo_training_orders) AS c`
  );
  const total = Number(countR.rows[0].c || 0);
  const rows = await pool.query(
    `SELECT id, order_id, sl_no, batch_id, personnel_id, employee_id, employee_name,
            mandal, venue, status, created_at, 'PO' AS training_group
       FROM po_training_orders
     UNION ALL
     SELECT id, order_id, sl_no, batch_id, personnel_id, employee_id, employee_name,
            mandal, venue, status, created_at, 'APO' AS training_group
       FROM apo_training_orders
     ORDER BY sl_no ASC, id ASC
     LIMIT $1 OFFSET $2`,
    [per, offset]
  );
  return {
    orders: rows.rows,
    page: pageN,
    perPage: per,
    total,
    totalPages: Math.ceil(total / per) || 1,
  };
}

/** Single order download. */
async function downloadTrainingOrder(group, id) {
  const t = tablesFor(group);
  const r = await pool.query(
    `SELECT id, order_id, employee_id, employee_name, order_docx
       FROM ${t.orders} WHERE id = $1`,
    [Number(id)]
  );
  if (r.rows.length === 0) {
    const err = new Error('Training order not found');
    err.statusCode = 404;
    throw err;
  }
  const order = r.rows[0];
  if (!order.order_docx) {
    const err = new Error('Training order has not been generated yet — run Generate/Print first');
    err.statusCode = 404;
    throw err;
  }
  return {
    order,
    buffer: order.order_docx,
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: `${order.order_id || 'order'}.docx`,
  };
}

/**
 * ZIP all generated orders for group (PO|APO) or both when group omitted/ALL.
 */
async function buildOrdersZip(group) {
  const zip = new PizZip();
  let count = 0;

  async function addGroup(g) {
    const t = TABLES[g];
    const r = await pool.query(
      `SELECT order_id, employee_id, employee_name, order_docx, sl_no
         FROM ${t.orders}
        ORDER BY sl_no ASC, id ASC`
    );
    for (const row of r.rows) {
      if (!row.order_docx) continue;
      const safeName = String(row.employee_name || row.employee_id || 'officer')
        .replace(/[^\w.\- ]+/g, '_')
        .slice(0, 60);
      const fname = `${g}/${String(row.sl_no).padStart(4, '0')}_${safeName}_${row.order_id}.docx`;
      zip.file(fname, row.order_docx);
      count += 1;
    }
  }

  const g = group ? String(group).toUpperCase() : 'ALL';
  if (g === 'ALL') {
    await addGroup('PO');
    await addGroup('APO');
  } else {
    tablesFor(g);
    await addGroup(g);
  }

  if (count === 0) {
    const err = new Error('No generated orders to download. Run Print/Generate first.');
    err.statusCode = 404;
    throw err;
  }

  const buffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  const filename =
    g === 'ALL' ? 'training-orders-PO-APO.zip' : `training-orders-${g}.zip`;
  return { buffer, filename, count };
}

module.exports = {
  MAX_BATCH_SIZE,
  TABLES,
  classifyRole,
  parseTrainingDate,
  envMergeDefaults,
  allocateTraining,
  listBatches,
  listBatchMembers,
  listBatchLocations,
  assignBatchLocation,
  generateOrders,
  listTrainingOrders,
  downloadTrainingOrder,
  buildOrdersZip,
  wipeAllTraining,
  wipeAllData,
};
