'use strict';

/**
 * tests/imports/order-merge.test.js
 *
 * Unit tests for the order-merge engine + the Gmail attachment (MIME) path.
 * Pure — builds a minimal .docx in memory, merges, and inspects the encoded
 * Gmail message. No database, no live API.
 *
 * Run: node --test tests/imports/order-merge.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');

const { mergeDocx, buildMergeData, filenameFor } = require('../../src/modules/imports/order-merge.service');
const { createGmailProvider } = require('../../src/modules/notifications/providers');

// Minimal valid .docx whose body contains two tags.
function makeTemplate() {
  const zip = new PizZip();
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>Order for {employee_name} as {role}</w:t></w:r></w:p></w:body></w:document>'
  );
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  return zip.generate({ type: 'nodebuffer' });
}

test('mergeDocx fills tags and leaves none behind', () => {
  const out = mergeDocx(makeTemplate(), buildMergeData({
    personnel: { employee_name: 'Asha Rao' },
    assignment: { role: 'Stage Officer II' },
  }));
  const xml = new PizZip(out).file('word/document.xml').asText();
  assert.ok(xml.includes('Asha Rao'));
  assert.ok(xml.includes('Stage Officer II'));
  assert.ok(!xml.includes('{employee_name}'));
});

test('mergeDocx: missing data renders blank (nullGetter), never throws', () => {
  const out = mergeDocx(makeTemplate(), { employee_name: 'Bhanu' });
  const xml = new PizZip(out).file('word/document.xml').asText();
  assert.ok(xml.includes('Bhanu'));
  assert.ok(!xml.includes('{role}'));
});

test('mergeDocx: empty buffer -> 400', () => {
  assert.throws(() => mergeDocx(Buffer.alloc(0), {}), (e) => e.statusCode === 400);
});

test('buildMergeData flattens order_config + personnel + assignment + extra', () => {
  const data = buildMergeData({
    orderConfig: { election_title: 'GP Election 2026', district: 'Kakinada' },
    personnel: { employee_id: 'E1', employee_name: 'Asha', designation: 'SA' },
    assignment: { role: 'CS', team_no: '1', table_no: '3', body_name: 'Ward 5' },
    extra: { custom_tag: 'X' },
  });
  assert.equal(data.election_title, 'GP Election 2026');
  assert.equal(data.district, 'Kakinada');
  assert.equal(data.name, 'Asha'); // alias of employee_name
  assert.equal(data.role, 'CS');
  assert.equal(data.team_no, '1');
  assert.equal(data.body_name, 'Ward 5');
  assert.equal(data.custom_tag, 'X');
});

test('filenameFor is deterministic and filesystem-safe', () => {
  const fn = filenameFor({ kind: 'stage_officer_ii', personnel: { employee_id: 'E1' }, assignment: { role: 'Stage Officer II' } });
  assert.equal(fn, 'stage_officer_ii_E1_Stage_Officer_II.docx');
  assert.ok(!/[^a-zA-Z0-9._-]/.test(fn));
});

// --- Gmail attachment (MIME multipart) -------------------------------------

function makeGmail(httpSpy) {
  return createGmailProvider({
    env: { GMAIL_SENDER_EMAIL: 'noreply@example.gov', GMAIL_ACCESS_TOKEN: 'tok' },
    httpClient: httpSpy,
  });
}

function decodeRaw(body) {
  // The provider base64url-encodes the full RFC822 message in body.raw.
  return Buffer.from(body.raw, 'base64url').toString('utf8');
}

test('gmail: plain message unchanged (no attachments) -> text/plain', async () => {
  let captured = null;
  const gmail = makeGmail(async (url, opts) => { captured = JSON.parse(opts.body); return { ok: true, status: 200, data: { id: 'm1' } }; });
  await gmail.send({ to: 'a@b.c', subject: 'Hi', message: 'body' });
  const raw = decodeRaw(captured);
  assert.ok(raw.includes('Content-Type: text/plain'));
  assert.ok(!raw.includes('multipart/mixed'));
  assert.equal(captured.id, undefined); // provider returns {id}, we captured body not response
});

test('gmail: with attachment -> multipart/mixed + base64 part', async () => {
  let captured = null;
  const gmail = makeGmail(async (url, opts) => { captured = JSON.parse(opts.body); return { ok: true, status: 200, data: { id: 'm2' } }; });
  const att = { filename: 'order.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('DOCXBYTES').toString('base64') };
  await gmail.send({ to: 'a@b.c', subject: 'Order', message: 'see attached', attachments: [att] });
  const raw = decodeRaw(captured);
  assert.ok(raw.includes('MIME-Version: 1.0'));
  assert.ok(raw.includes('multipart/mixed'));
  assert.ok(raw.includes('Content-Disposition: attachment; filename="order.docx"'));
  assert.ok(raw.includes('Content-Transfer-Encoding: base64'));
  assert.ok(raw.includes('see attached'));
  // the base64 payload round-trips back to the original bytes
  assert.ok(raw.includes(Buffer.from('DOCXBYTES').toString('base64')));
});

test('gmail: unconfigured -> throws NotificationConfigError (fail closed)', async () => {
  const gmail = createGmailProvider({ env: {}, httpClient: async () => ({ ok: true, status: 200, data: {} }) });
  assert.equal(gmail.isConfigured(), false);
  await assert.rejects(() => gmail.send({ to: 'a@b.c', message: 'x' }), (e) => e.code === 'NOTIFICATION_NOT_CONFIGURED');
});
