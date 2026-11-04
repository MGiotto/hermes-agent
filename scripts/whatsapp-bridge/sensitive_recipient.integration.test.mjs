import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const directory = path.dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('sensitive HTTP send uses the provider canonical recipient before delivery', { timeout: 15000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'wa-recipient-lab-'));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = fork(path.join(directory, 'bridge.js'), ['--mode', 'bot', '--port', String(port), '--session', path.join(work, 'session')], {
    execArgv: ['--import', path.join(directory, 'test_fixtures/synthetic_import_hook.mjs')],
    env: { PATH: process.env.PATH, HOME: work, TMPDIR: work, WHATSAPP_SYNTHETIC_TEST: '1', WHATSAPP_DM_POLICY: 'open', WHATSAPP_ALLOWED_USERS: '*' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const sent = [];
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.on('message', event => { if (event.kind === 'synthetic-send') sent.push(event); });
  try {
    let connected = false;
    for (let i = 0; i < 80; i += 1) {
      assert.equal(child.exitCode, null, 'Synthetic bridge must stay alive');
      try { connected = (await (await fetch(`${base}/health`)).json()).status === 'connected'; } catch {}
      if (connected) break;
      await delay(30);
    }
    assert.equal(connected, true);
    // Invalid DDD 00 deliberately keeps this fixture away from real accounts.
    const phone = '5500999990000';
    const requested = `${phone}@s.whatsapp.net`;
    const canonical = `${phone.slice(0, 4) + phone.slice(5)}@s.whatsapp.net`;
    const result = await (await fetch(`${base}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: requested, message: 'Synthetic code: 246802', sensitive: true }),
    })).json();
    assert.equal(result.success, true);
    for (let i = 0; !sent.length && i < 30; i += 1) await delay(10);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, canonical, 'Use the provider recipient, not the literal form number');
    child.send({ kind: 'inject-inbound', messages: [
      { key: { id: 'requested-private', remoteJid: requested }, message: { conversation: '246802' } },
      { key: { id: 'canonical-private', remoteJid: canonical }, message: { conversation: '246802' } },
      { key: { id: 'canonical-normal', remoteJid: canonical }, message: { conversation: 'Conversation still works' } },
    ] });
    await delay(120);
    const queue = await (await fetch(`${base}/messages`)).json();
    assert.deepEqual(queue.map(item => item.body), ['Conversation still works']);
    assert.equal(output.includes('246802'), false);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(work, { recursive: true, force: true });
  }
});
