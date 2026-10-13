'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { validateRows, normalizeDate } = require('../../src/modules/imports/validation');

function row(sheetRow, values) {
  return { sheetRow, values: { sl_no: String(sheetRow - 6), ...values } };
}

test('accepts a fully valid row', () => {
  const { accepted, rejected } = validateRows([
    row(7, { employee_id: 'EMP001', employee_name: 'Alpha', date_of_birth: '01.02.1980' }),
  ]);
  assert.strictEqual(accepted.length, 1);
  assert.strictEqual(rejected.length, 0);
  assert.strictEqual(accepted[0].date_of_birth, '1980-02-01');
});

test('rejects missing employee_name', () => {
  const { accepted, rejected } = validateRows([
    row(7, { employee_id: 'EMP001', employee_name: '' }),
  ]);
  assert.strictEqual(accepted.length, 0);
  assert.deepStrictEqual(rejected[0].reasons, ['employee_name_required']);
});

test('rejects missing employee_id', () => {
  const { rejected } = validateRows([row(7, { employee_id: '', employee_name: 'Alpha' })]);
  assert.deepStrictEqual(rejected[0].reasons, ['employee_id_required']);
});

test('rejects unparseable and impossible dates, accepts blank', () => {
  const { accepted, rejected } = validateRows([
    row(7, { employee_id: 'A1', employee_name: 'A', date_of_birth: 'not-a-date' }),
    row(8, { employee_id: 'A2', employee_name: 'B', date_of_birth: '31.02.1980' }),
    row(9, { employee_id: 'A3', employee_name: 'C', date_of_birth: '', date_of_retirement: '' }),
  ]);
  assert.strictEqual(accepted.length, 1);
  assert.strictEqual(accepted[0].date_of_birth, null);
  assert.deepStrictEqual(rejected[0].reasons, ['date_of_birth_unparseable']);
  assert.deepStrictEqual(rejected[1].reasons, ['date_of_birth_unparseable']);
});

test('rejects duplicate employee_id within one file (later rows)', () => {
  const { accepted, rejected } = validateRows([
    row(7, { employee_id: 'EMP001', employee_name: 'Alpha' }),
    row(8, { employee_id: 'EMP001', employee_name: 'Beta' }),
  ]);
  assert.strictEqual(accepted.length, 1);
  assert.strictEqual(accepted[0].employee_name, 'Alpha');
  assert.deepStrictEqual(rejected[0].reasons, ['duplicate_employee_id_in_file']);
});

test('combines multiple reasons on one row', () => {
  const { rejected } = validateRows([
    row(7, { employee_id: '', employee_name: '', date_of_birth: 'junk' }),
  ]);
  assert.deepStrictEqual(rejected[0].reasons.sort(), [
    'date_of_birth_unparseable',
    'employee_id_required',
    'employee_name_required',
  ]);
});

test('normalizeDate handles dd.mm.yyyy edge cases', () => {
  assert.deepStrictEqual(normalizeDate('29.2.2004'), { value: '2004-02-29' }); // leap year
  assert.deepStrictEqual(normalizeDate('29.2.2003'), { error: 'unparseable_date' });
  assert.deepStrictEqual(normalizeDate(''), { value: null });
});
