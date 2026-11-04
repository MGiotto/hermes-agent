import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSensitiveTextGuard } from './sensitive_text.js';

test('temporary passwords are blocked even after the short OTP privacy window', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'wa-temporary-password-lab-'));
  try {
    const statePath = path.join(work, 'private-windows.json');
    let now = Date.now();
    const guard = createSensitiveTextGuard({ statePath, now: () => now });
    const chat = '5500000000000@s.whatsapp.net';
    guard.protectOutgoing(chat, 'Senha temporária sintética: ab2cdefg3h');
    now += 24 * 60 * 60 * 1000;
    const restarted = createSensitiveTextGuard({ statePath, now: () => now });
    assert.equal(restarted.shouldBlock(chat, { conversation: 'ab2cdefg3h' }), true,
      'a first-access password has no short OTP expiration');
    assert.equal(restarted.shouldBlock(chat, { conversation: 'Preciso de ajuda com meu cadastro' }), false);
    assert.equal(readFileSync(statePath, 'utf8').includes('ab2cdefg3h'), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('format-based filtering covers wrong guesses and wrapped text without a validity oracle', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'wa-password-shape-lab-'));
  try {
    const guard = createSensitiveTextGuard({ statePath: path.join(work, 'windows.json') });
    for (const text of ['ab2cdefg3h', 'AB2CDEFG3H', 'Minha senha: ab2cdefg3h', 'ab2cd\u200befg3h', 'zz9yyyxw8v', 'ａｂ２ｃｄｅｆｇ３ｈ']) {
      assert.equal(guard.shouldBlock('9999999999@lid', { ephemeralMessage: { message: {
        extendedTextMessage: { text },
      } } }), true, 'credential-shaped text must never enter the queue');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('ordinary conversation, pure numbers and longer item identifiers remain usable', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'wa-password-controls-lab-'));
  try {
    const guard = createSensitiveTextGuard({ statePath: path.join(work, 'windows.json') });
    for (const text of ['Como solicito material?', 'abcdefghij', '0123456789', 'xab2cdefg3h', 'ab2cdefg3', 'RE 9000001']) {
      assert.equal(guard.shouldBlock('5500000000000@s.whatsapp.net', { conversation: text }), false);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
