// Synthetic transport only. This module never opens a WhatsApp connection.
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';

if (process.env.WHATSAPP_SYNTHETIC_TEST !== '1' || !process.send) {
  throw new Error('Synthetic transport requires an isolated IPC test process');
}
const events = new EventEmitter();
export function makeWASocket() {
  const socket = {
    ev: events,
    user: { id: '5500000000001:1@s.whatsapp.net', lid: '9000000000001@lid' },
    sendMessage: async (chatId, message) => {
      process.send({ kind: 'synthetic-send', chatId, text: message.text });
      return { key: { id: `lab-${Date.now()}`, remoteJid: chatId, fromMe: true }, message };
    },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
  setTimeout(() => events.emit('connection.update', { connection: 'open' }), 10);
  return socket;
}
export async function useMultiFileAuthState(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { state: { creds: {}, keys: {} }, saveCreds: async () => {} };
}
export const fetchLatestBaileysVersion = async () => ({ version: [0, 0, 0], isLatest: false });
export const DisconnectReason = {};
export const downloadMediaMessage = async () => { throw new Error('No media transport in synthetic fixture'); };
export const getAggregateVotesInPollMessage = () => [];
export const decryptPollVote = () => ({});
export const getKeyAuthor = key => key.participant || key.remoteJid;
export const jidNormalizedUser = id => String(id || '').replace(/:\d+@/, '@');
process.on('message', command => {
  if (command?.kind === 'inject-inbound') {
    events.emit('messages.upsert', { type: 'notify', messages: command.messages });
  }
});
