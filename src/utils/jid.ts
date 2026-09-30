/**
 * Formats arbitrary user input phone numbers or JIDs into proper WhatsApp JID format.
 * Examples:
 *  - "+1 (234) 567-8900" -> "12345678900@s.whatsapp.net"
 *  - "919876543210" -> "919876543210@s.whatsapp.net"
 *  - "1234567890@s.whatsapp.net" -> "1234567890@s.whatsapp.net"
 *  - "123456789-123456@g.us" -> "123456789-123456@g.us"
 */
export function formatWhatsAppJid(to: string): string {
  if (!to) {
    throw new Error('Target phone number or JID cannot be empty');
  }

  const cleaned = to.trim();

  // If already full WhatsApp JID (user, group, broadcast, newsletter)
  if (
    cleaned.endsWith('@s.whatsapp.net') ||
    cleaned.endsWith('@g.us') ||
    cleaned.endsWith('@broadcast') ||
    cleaned.endsWith('@newsletter')
  ) {
    return cleaned;
  }

  // Remove all non-numeric characters for individual phone numbers
  let digitsOnly = cleaned.replace(/\D/g, '');

  // Handle local Bangladesh numbers starting with leading 0 (e.g. 01712345678 -> 8801712345678)
  if (digitsOnly.startsWith('01') && digitsOnly.length === 11) {
    digitsOnly = `880${digitsOnly.substring(1)}`;
  } else if (digitsOnly.startsWith('0') && digitsOnly.length >= 10) {
    // Strip redundant leading 0
    digitsOnly = digitsOnly.replace(/^0+/, '');
  }

  if (!digitsOnly || digitsOnly.length < 7 || digitsOnly.length > 15) {
    throw new Error(`Invalid phone number or JID provided: "${to}"`);
  }

  return `${digitsOnly}@s.whatsapp.net`;
}

/**
 * Extracts raw phone number or identity from a WhatsApp JID
 */
export function extractPhoneNumber(jid: string): string {
  return jid.split('@')[0];
}
