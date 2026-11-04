// Used only to validate a provider answer, never to invent a send destination.
function phoneFamily(phone) {
  return phone.startsWith('55') && phone.length === 13 && phone[4] === '9'
    ? phone.slice(0, 4) + phone.slice(5) : phone;
}

// Resolve a phone through the owning socket; never guess a different number.
export async function resolveSensitiveRecipient(socket, chatId, timeoutMs = 3000) {
  if (!chatId.endsWith('@s.whatsapp.net')) return chatId;
  const phone = chatId.slice(0, -'@s.whatsapp.net'.length);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Sensitive recipient lookup timed out')), timeoutMs);
  });
  try {
    const matches = await Promise.race([socket.onWhatsApp(phone), deadline]);
    if (!Array.isArray(matches) || matches.length !== 1 || matches[0]?.exists !== true
        || typeof matches[0].jid !== 'string' || !/^[1-9][0-9]{9,14}@s\.whatsapp\.net$/.test(matches[0].jid)
        || phoneFamily(matches[0].jid.split('@')[0]) !== phoneFamily(phone)) {
      throw new Error('Sensitive recipient could not be resolved');
    }
    return matches[0].jid;
  } finally {
    clearTimeout(timer);
  }
}
