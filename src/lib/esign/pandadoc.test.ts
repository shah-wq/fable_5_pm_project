import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mapStatus, parseWebhook, verifyWebhook } from './pandadoc.ts';

test('a webhook is accepted only with the HMAC of its exact body', () => {
  process.env.PANDADOC_WEBHOOK_KEY = 'shared-key';
  const body = '[{"event":"document_state_changed","data":{"id":"abc","status":"document.completed"}}]';
  const good = createHmac('sha256', 'shared-key').update(body).digest('hex');
  assert.equal(verifyWebhook(body, good), true);
  assert.equal(verifyWebhook(body, good.toUpperCase()), true);
  assert.equal(verifyWebhook(body + ' ', good), false, 'a changed body');
  assert.equal(verifyWebhook(body, 'deadbeef'), false, 'a wrong signature');
  assert.equal(verifyWebhook(body, null), false, 'no signature');
  delete process.env.PANDADOC_WEBHOOK_KEY;
  assert.equal(verifyWebhook(body, good), false, 'no key configured refuses everything');
});

test('webhook bodies: an array of events, or one, and junk ignored', () => {
  assert.deepEqual(
    parseWebhook([
      { event: 'document_state_changed', data: { id: 'a', status: 'document.completed' } },
      { event: 'recipient_completed', data: { id: 'b' } },
      { nonsense: true },
      null,
    ]),
    [
      { event: 'document_state_changed', documentId: 'a', status: 'document.completed' },
      { event: 'recipient_completed', documentId: 'b', status: null },
    ]
  );
  assert.deepEqual(parseWebhook({ event: 'x', data: { id: 'c', status: 'document.viewed' } }), [
    { event: 'x', documentId: 'c', status: 'document.viewed' },
  ]);
  assert.deepEqual(parseWebhook('nope'), []);
});

test('PandaDoc statuses map onto ours, and unknown ones change nothing', () => {
  assert.equal(mapStatus('document.draft'), 'preparing');
  assert.equal(mapStatus('document.sent'), 'sent');
  assert.equal(mapStatus('document.viewed'), 'viewed');
  assert.equal(mapStatus('document.completed'), 'completed');
  assert.equal(mapStatus('document.declined'), 'declined');
  assert.equal(mapStatus('document.voided'), 'voided');
  assert.equal(mapStatus('document.something_new'), null);
  assert.equal(mapStatus(null), null);
});
