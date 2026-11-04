import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const directory = path.dirname(fileURLToPath(import.meta.url));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('native HTTP send and real inbound pipeline isolate confidential text, echoes and quotes', { timeout: 15000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'wa-native-private-lab-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = fork(path.join(directory, 'bridge.js'), ['--mode', 'bot', '--port', String(port), '--session', path.join(work, 'session')], {
    execArgv: ['--import', path.join(directory, 'test_fixtures/synthetic_import_hook.mjs')],
    env: { PATH: process.env.PATH, HOME: work, TMPDIR: work, WHATSAPP_SYNTHETIC_TEST: '1', WHATSAPP_DM_POLICY: 'open', WHATSAPP_ALLOWED_USERS: '*', WHATSAPP_DEBUG: 'true' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let diagnosticOutput = '';
  const sent = [];
  child.stdout.on('data', data => { diagnosticOutput += data; });
  child.stderr.on('data', data => { diagnosticOutput += data; });
  child.on('message', event => { if (event.kind === 'synthetic-send') sent.push(event); });
  try {
    let health;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (child.exitCode !== null) assert.fail(`Synthetic bridge exited before readiness (exit ${child.exitCode})`);
      try { health = await (await fetch(`${base}/health`)).json(); } catch {}
      if (health?.status === 'connected') break;
      await delay(50);
    }
    assert.equal(health?.status, 'connected', 'Synthetic bridge must start without real credentials');
    assert.equal(health.accountFingerprint, createHash('sha256').update('5500000000001@s.whatsapp.net').digest('hex'));
    assert.equal(health.capabilities.sensitiveText, 'v1', 'Old bridges must not accept recovery traffic');
    assert.equal(health.capabilities.sensitiveTemporaryPasswords, 'v1');
    const chat = '5500000000000@s.whatsapp.net';
    const code = '246802';
    const result = await (await fetch(`${base}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: chat, message: `Código sintético: ${code}`, sensitive: true }),
    })).json();
    assert.equal(result.success, true);
    for (let attempt = 0; !sent.length && attempt < 20; attempt += 1) await delay(10);
    assert.ok(sent[0].text.includes('[HERMES_PRIVATE]'));
    const password = 'ab2cdefg3h';
    const temporary = await (await fetch(`${base}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: chat, message: `Senha temporária sintética: ${password}`, sensitive: true }),
    })).json();
    assert.equal(temporary.success, true);
    for (let attempt = 0; sent.length < 2 && attempt < 20; attempt += 1) await delay(10);
    assert.equal(sent.length, 2);
    const quoted = { extendedTextMessage: { text: 'Onde digito?', contextInfo: { quotedMessage: { conversation: sent[0].text } } } };
    child.send({ kind: 'inject-inbound', messages: [
      { key: { id: 'in-private', remoteJid: chat }, message: { conversation: code } },
      { key: { id: 'in-quote', remoteJid: chat }, message: quoted },
      { key: { id: 'in-lid', remoteJid: '9999999999@lid', remoteJidAlt: chat }, message: { conversation: code } },
      { key: { id: 'in-password', remoteJid: chat }, message: { conversation: password } },
      { key: { id: 'in-password-lid', remoteJid: '9999999999@lid' }, message: { conversation: password } },
      { key: { id: 'in-password-wrapped', remoteJid: chat }, message: { ephemeralMessage: { message: { conversation: password } } } },
      { key: { id: 'in-password-quote', remoteJid: chat }, message: { extendedTextMessage: { text: 'Como uso?', contextInfo: {
        quotedMessage: { conversation: sent[1].text },
      } } } },
      { key: { id: 'in-normal', remoteJid: chat }, message: { conversation: 'Como funciona o inventário?' } },
      { key: { id: result.messageId, remoteJid: chat, fromMe: true }, message: { conversation: sent[0].text } },
    ] });
    await delay(200);
    const queue = await (await fetch(`${base}/messages`)).json();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].body, 'Como funciona o inventário?');
    assert.equal(JSON.stringify(queue).includes(code), false);
    assert.equal(diagnosticOutput.includes(code), false);
    assert.equal(JSON.stringify(queue).includes(password), false);
    assert.equal(diagnosticOutput.includes(password), false);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(work, { recursive: true, force: true });
  }
});
