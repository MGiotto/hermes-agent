import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const loaded = await import('./sensitive_text.js').catch(() => null);

test('corrupt privacy metadata refuses startup instead of permitting secret replies', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-sensitive-lab-'));
  try {
    const statePath = path.join(dir, 'private-windows.json');
    writeFileSync(statePath, JSON.stringify({version: 2, windows: []}), {mode: 0o600});
    assert.throws(() => loaded.createSensitiveTextGuard({statePath}), /Invalid private message metadata/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a persistence failure prevents preparing a confidential outbound message', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-sensitive-lab-'));
  try {
    const statePath = path.join(dir, 'absent-directory', 'private-windows.json');
    const guard = loaded.createSensitiveTextGuard({statePath});
    assert.throws(() => guard.protectOutgoing('5500000000000@s.whatsapp.net', 'Código sintético: 246802'), {code: 'ENOENT'});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('phone aliases and unresolved LIDs cannot bypass an active privacy window', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-sensitive-lab-'));
  try {
    const guard = loaded.createSensitiveTextGuard({ statePath: path.join(dir, 'private-windows.json') });
    guard.protectOutgoing('5500000000000@s.whatsapp.net', 'Código sintético: 246802');
    assert.equal(guard.shouldBlock(['9999999999@lid', '5500000000000@s.whatsapp.net'], { conversation: '246802' }), true);
    assert.equal(guard.shouldBlock(['9999999999@lid'], { conversation: '246802' }), true);
    assert.equal(guard.shouldBlock(['5500000000001@s.whatsapp.net'], { conversation: '246802' }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('confidential replies are blocked before entering the agent queue', () => {
  assert.equal(typeof loaded?.createSensitiveTextGuard, 'function', 'sensitive text guard is missing');
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-sensitive-lab-'));
  try {
    const guard = loaded.createSensitiveTextGuard({ statePath: path.join(dir, 'private-windows.json') });
    const chat = '5500000000000@s.whatsapp.net';
    const outgoing = guard.protectOutgoing(chat, 'Código sintético de confirmação: 246802');
    const incoming = { extendedTextMessage: { text: 'Onde digito?', contextInfo: {
      quotedMessage: { conversation: outgoing },
    } } };
    assert.equal(guard.shouldBlock(chat, incoming), true);
    assert.equal(guard.shouldBlock(chat, { conversation: 'Pode explicar o inventário?' }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('active code replies remain private across bridge restarts without storing secrets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-sensitive-lab-'));
  try {
    const statePath = path.join(dir, 'private-windows.json');
    const chat = '5500000000000@s.whatsapp.net';
    let now = Date.now();
    const options = { statePath, now: () => now };
    const guard = loaded.createSensitiveTextGuard(options);
    guard.protectOutgoing(chat, 'Código sintético: 246802');
    const restarted = loaded.createSensitiveTextGuard(options);
    assert.equal(restarted.shouldBlock(chat, { conversation: 'meu código é 246802' }), true);
    assert.equal(restarted.shouldBlock('5500000000001@s.whatsapp.net', { conversation: '246802' }), false);
    const saved = readFileSync(statePath, 'utf8');
    assert.equal(saved.includes(chat), false);
    const metadata = JSON.parse(saved);
    assert.deepEqual(Object.keys(metadata).sort(), ['version', 'windows']);
    assert.equal(metadata.windows.length, 1);
    assert.match(metadata.windows[0][0], /^[a-f0-9]{64}$/);
    assert.equal(typeof metadata.windows[0][1], 'number');
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    now += 20 * 60 * 1000;
    assert.equal(restarted.shouldBlock(chat, { conversation: '246802' }), false);
    assert.equal(restarted.shouldBlock(chat, { conversation: `${loaded.SENSITIVE_TEXT_MARKER}\nCódigo: 246802` }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
