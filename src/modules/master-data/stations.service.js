'use strict';

/**
 * Master data — persistence for a polling-station import.
 *
 * One import = one import_batches row (kind='stations') + accepted rows in
 * polling_stations, written atomically (single transaction). Rejected rows are
 * NOT stored; they are returned to the caller with explicit reasons so the
 * operator can fix the payload and retry (the batch keeps the counts).
 *
 * Input is a validated JSON array (the official "Booths" workbook is not in
 * the workspace — see stations.validation.js). Reuses the shared pg pool and
 * the existing import_batches traceability table.
 */

const pool = require('../../database');
const { validateStations } = require('./stations.validation');

// Columns written to polling_stations (all confirmed by migration 003), mapped
// to the camelCase field names produced by stations.validation.js. Reading the
// wrong key would silently insert NULL into NOT NULL columns.
const STATION_COLUMNS = Object.freeze([
  ['district', 'district'],
  ['station_id', 'stationId'],
  ['station_number', 'stationNumber'],
  ['station_name', 'stationName'],
  ['building_name', 'buildingName'],
  ['street', 'street'],
  ['locality', 'locality'],
  ['ward', 'ward'],
  ['mandal', 'mandal'],
  ['pin_code', 'pinCode'],
  ['required_officers', 'requiredOfficers'],
]);

const DB_COLUMNS = STATION_COLUMNS.map(([column]) => column);

const INSERT_SQL = `
  INSERT INTO polling_stations (
    import_batch_id, ${DB_COLUMNS.join(', ')}
  ) VALUES ($1, ${DB_COLUMNS.map((_, i) => `$${i + 2}`).join(', ')})
`;

/**
 * persistStationImport({ fileName, stations, importedBy }) -> batch summary
 *   stations: array of JSON records (validated here).
 * Throws on DB failure; the transaction rolls back.
 */
async function persistStationImport({ fileName, stations, importedBy }) {
  if (!Array.isArray(stations)) {
    const err = new Error('stations must be an array');
    err.statusCode = 400;
    throw err;
  }
  const { accepted, rejected } = validateStations(stations);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchResult = await client.query(
      `INSERT INTO import_batches
         (file_name, imported_by, total_rows, accepted_rows, rejected_rows, status, kind)
       VALUES ($1, $2, $3, $4, $5, 'in_progress', 'stations')
       RETURNING id`,
      [
        fileName,
        importedBy ?? null,
        accepted.length + rejected.length,
        accepted.length,
        rejected.length,
      ]
    );
    const batchId = batchResult.rows[0].id;

    for (const record of accepted) {
      const values = STATION_COLUMNS.map(([, field]) => record[field] ?? null);
      await client.query(INSERT_SQL, [batchId, ...values]);
    }

    await client.query(`UPDATE import_batches SET status = 'completed' WHERE id = $1`, [batchId]);
    await client.query('COMMIT');

    return {
      batchId,
      totalRows: accepted.length + rejected.length,
      acceptedRows: accepted.length,
      rejectedRows: rejected.length,
      rejected,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * listStations({ batchId, district, limit }) -> { count, stations }
 * Read-only projection of polling_stations (no sensitive fields exist here).
 */
async function listStations({ batchId, district, limit } = {}) {
  const where = [];
  const params = [];
  if (batchId !== undefined && batchId !== null) {
    params.push(batchId);
    where.push(`import_batch_id = $${params.length}`);
  }
  if (district) {
    params.push(district);
    where.push(`district = $${params.length}`);
  }
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 5000) : 1000;
  params.push(cap);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT id, import_batch_id, district, station_id, station_number, station_name,
            building_name, street, locality, ward, mandal, pin_code, required_officers
       FROM polling_stations
       ${whereSql}
      ORDER BY id
      LIMIT $${params.length}`,
    params
  );
  return { count: rows.length, stations: rows };
}

module.exports = { persistStationImport, listStations };
