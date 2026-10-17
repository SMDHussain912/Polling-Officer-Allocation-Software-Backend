'use strict';
/* Diagnose live training-orders state: run -> stages -> allocate -> generate. */
const pool = require('../src/database');

(async () => {
  try {
    for (const t of [
      'allocation_runs', 'stage2_teams', 'stage2_team_members', 'stage3_assignments',
      'po_training_batches', 'po_training_batch_members', 'po_training_orders',
      'apo_training_batches', 'apo_training_batch_members', 'apo_training_orders',
      'personnel', 'polling_stations', 'users',
    ]) {
      try {
        const r = await pool.query('SELECT COUNT(*)::int c FROM ' + t);
        console.log(t + ': ' + r.rows[0].c);
      } catch (e) { console.log(t + ': ERR ' + e.message.slice(0, 100)); }
    }
    try {
      const r = await pool.query('SELECT id, run_by_username, created_at FROM allocation_runs ORDER BY id DESC LIMIT 3');
      console.log('RUNS:', JSON.stringify(r.rows));
    } catch (e) { console.log('RUNS ERR:', e.message.slice(0, 120)); }
    try {
      const { allocateTraining } = require('../src/modules/training-orders/index');
      const a = await allocateTraining({ createdBy: 3 });
      console.log('ALLOCATE_OK source=' + a.source + ' runId=' + a.stageRunId +
        ' batches=' + a.batches.map((b) => b.group + '/' + b.mandal + ':' + b.officer_count).join(',') +
        ' skippedMo=' + a.skippedMo + ' errors=' + JSON.stringify(a.errors));
    } catch (e) {
      console.log('ALLOCATE_ERR status=' + (e.statusCode || '?') + ' msg=' + e.message);
      if (e.dbState) console.log('DBSTATE:', JSON.stringify(e.dbState));
    }
  } catch (e) { console.error('FATAL', e.message); }
  await pool.end();
})();
