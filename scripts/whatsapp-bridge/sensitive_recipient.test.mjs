import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSensitiveRecipient } from './sensitive_recipient.js';

test('recipient lookup cannot redirect a sensitive message to an unrelated phone', async () => {
  const socket = { onWhatsApp: async () => [{ jid: '5500777770000@s.whatsapp.net', exists: true }] };
  await assert.rejects(resolveSensitiveRecipient(socket, '5500999990000@s.whatsapp.net'), /could not be resolved/);
});

test('late recipient lookup is rejected before a sensitive message can be sent', async () => {
  const socket = { onWhatsApp: async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
    return [{ jid: '5500999990000@s.whatsapp.net', exists: true }];
  } };
  await assert.rejects(resolveSensitiveRecipient(socket, '5500999990000@s.whatsapp.net', 10), /timed out/);
});

test('missing, unregistered, malformed and ambiguous lookup answers fail closed', async () => {
  for (const answer of [undefined, [], [{ exists: false, jid: '5500999990000@s.whatsapp.net' }],
    [{ exists: true, jid: 'not-a-phone@s.whatsapp.net' }],
    [{ exists: true, jid: '5500999990000@other.invalid' }],
    [{ exists: true, jid: '5500999990000@s.whatsapp.net' }, { exists: true, jid: '550099990000@s.whatsapp.net' }]]) {
    await assert.rejects(resolveSensitiveRecipient({ onWhatsApp: async () => answer }, '5500999990000@s.whatsapp.net'), /could not be resolved/);
  }
});

test('non-phone sensitive destinations retain their existing transport contract', async () => {
  assert.equal(await resolveSensitiveRecipient({}, 'synthetic-group@g.us'), 'synthetic-group@g.us');
});
