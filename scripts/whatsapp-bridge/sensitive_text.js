import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expandWhatsAppIdentifiers, normalizeWhatsAppIdentifier } from './allowlist.js';

// Keep confidential transport text out of the agent's inbound queue.
export const SENSITIVE_TEXT_MARKER = '[HERMES_PRIVATE]';
export const SENSITIVE_TEXT_WINDOW_SECONDS = 20 * 60;

function textContainsMarker(value) {
  return value.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').includes(SENSITIVE_TEXT_MARKER);
}

function messageContains(message, predicate) {
  const seen = new WeakSet();
  let visited = 0;
  function scan(value, depth = 0) {
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (++visited > 1024 || depth > 16) return true; // Don't inspect unbounded input permissively.
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && ['conversation', 'text', 'caption', 'contentText'].includes(key)) {
        if (predicate(child)) return true;
      } else if (child && typeof child === 'object' && scan(child, depth + 1)) {
        return true;
      }
    }
    return false;
  }
  return scan(message);
}

const PRIVATE_WINDOW_MS = SENSITIVE_TEXT_WINDOW_SECONDS * 1000;
const MAX_WINDOWS = 4096;

function chatKey(chatId) {
  return createHash('sha256').update(normalizeWhatsAppIdentifier(chatId)).digest('hex');
}

function loadWindows(statePath, now) {
  if (!existsSync(statePath)) return new Map();
  if (statSync(statePath).size > 1024 * 1024) throw new Error('Invalid private message metadata');
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  if (saved.version !== 1 || !Array.isArray(saved.windows) || saved.windows.length > MAX_WINDOWS) {
    throw new Error('Invalid private message metadata');
  }
  const active = new Map();
  for (const entry of saved.windows) {
    if (!Array.isArray(entry) || entry.length !== 2 || !/^[a-f0-9]{64}$/.test(entry[0]) || !Number.isFinite(entry[1])) {
      throw new Error('Invalid private message metadata');
    }
    if (entry[1] > now()) active.set(entry[0], entry[1]);
  }
  return active;
}

function saveWindows(statePath, windows) {
  const temporary = `${statePath}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, windows: [...windows] }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, statePath);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function textContainsCode(value) {
  const compact = value.normalize('NFKC').replace(/[\s\-\u200B-\u200D\uFEFF]/g, '');
  return /(?<![0-9])[0-9]{6}(?![0-9])/u.test(compact);
}

export function createSensitiveTextGuard({ statePath, now = Date.now }) {
  let windows = loadWindows(statePath, now);
  return {
    protectOutgoing(chatId, text) {
      const current = now();
      const next = new Map([...windows].filter(([, expiry]) => expiry > current));
      next.set(chatKey(chatId), current + PRIVATE_WINDOW_MS);
      if (next.size > MAX_WINDOWS) throw new Error('Private message capacity reached');
      // Register privacy before sending: an immediate reply must already be covered.
      saveWindows(statePath, next);
      windows = next;
      return `${SENSITIVE_TEXT_MARKER}\n${text}`;
    },
    shouldBlock(chatId, message) {
      if (messageContains(message, textContainsMarker)) return true;
      const rawIds = (Array.isArray(chatId) ? chatId : [chatId]).filter(Boolean);
      const ids = new Set(rawIds.flatMap(id => [...expandWhatsAppIdentifiers(id, path.dirname(statePath))]));
      const current = now();
      let active = [...ids].some(id => (windows.get(chatKey(id)) || 0) > current);
      const unresolvedLid = rawIds.some(id => id.endsWith('@lid'))
        && !rawIds.some(id => id.endsWith('@s.whatsapp.net'))
        && ids.size === new Set(rawIds.map(normalizeWhatsAppIdentifier)).size;
      // First contact may omit both PN and mapping. Prefer privacy to guessing an identity.
      if (unresolvedLid) active ||= [...windows.values()].some(expiry => expiry > current);
      return active && messageContains(message, textContainsCode);
    },
  };
}
