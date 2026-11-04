// Used only to validate/query a mobile alias, never to invent a send destination.
function phoneFamily(phone) {
  return /^55[0-9]{2}9[6-9][0-9]{7}$/.test(phone)
    ? phone.slice(0, 4) + phone.slice(5) : phone;
}

// Resolve through the owning socket; require one registered canonical identity.
export async function resolveSensitiveRecipient(socket, chatId, timeoutMs = 3000) {
  if (!chatId.endsWith('@s.whatsapp.net')) return chatId;
  const phone = chatId.slice(0, -'@s.whatsapp.net'.length);
  const family = phoneFamily(phone);
  const phones = [phone];
  if (family !== phone) phones.push(family);
  else if (/^55[0-9]{2}[6-9][0-9]{7}$/.test(phone)) phones.push(phone.slice(0, 4) + '9' + phone.slice(4));
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Sensitive recipient lookup timed out')), timeoutMs);
  });
  try {
    const matches = await Promise.race([socket.onWhatsApp(...phones), deadline]);
    if (!Array.isArray(matches) || matches.length > phones.length) throw new Error('Sensitive recipient could not be resolved');
    const registered = matches.filter(match => match?.exists === true);
    if (registered.some(match => typeof match.jid !== 'string'
        || !/^[1-9][0-9]{9,14}@s\.whatsapp\.net$/.test(match.jid)
        || phoneFamily(match.jid.split('@')[0]) !== family)) {
      throw new Error('Sensitive recipient could not be resolved');
    }
    const recipients = new Set(registered.map(match => match.jid));
    if (recipients.size !== 1) throw new Error('Sensitive recipient could not be resolved');
    return [...recipients][0];
  } finally {
    clearTimeout(timer);
  }
}
