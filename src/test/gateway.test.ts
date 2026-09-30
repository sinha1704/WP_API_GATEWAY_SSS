import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatWhatsAppJid, extractPhoneNumber } from '../utils/jid.js';
import { verifyChatPermission } from '../middlewares/auth.middleware.js';
import { webhookService } from '../services/webhook.service.js';

describe('WhatsApp API Gateway Core Test Suite', () => {
  describe('JID & Phone Number Formatting', () => {
    it('should format clean numeric numbers to WhatsApp JID', () => {
      assert.strictEqual(formatWhatsAppJid('1234567890'), '1234567890@s.whatsapp.net');
      assert.strictEqual(formatWhatsAppJid('+1 (234) 567-890'), '1234567890@s.whatsapp.net');
      assert.strictEqual(formatWhatsAppJid('+91 98765-43210'), '919876543210@s.whatsapp.net');
    });

    it('should preserve valid existing WhatsApp JIDs', () => {
      assert.strictEqual(
        formatWhatsAppJid('1234567890@s.whatsapp.net'),
        '1234567890@s.whatsapp.net'
      );
      assert.strictEqual(
        formatWhatsAppJid('123456789-987654@g.us'),
        '123456789-987654@g.us'
      );
    });

    it('should reject invalid numbers', () => {
      assert.throws(() => formatWhatsAppJid(''));
      assert.throws(() => formatWhatsAppJid('abc'));
      assert.throws(() => formatWhatsAppJid('123')); // too short
    });

    it('should extract correct phone number from JID', () => {
      assert.strictEqual(extractPhoneNumber('1234567890@s.whatsapp.net'), '1234567890');
    });
  });

  describe('Multi-Tenant API Key & Chat Permissions', () => {
    it('Master key should allow all chats', () => {
      const auth = { isMaster: true, apiKey: 'master_key' };
      assert.strictEqual(verifyChatPermission(auth, '1234567890'), true);
      assert.strictEqual(verifyChatPermission(auth, '9876543210@s.whatsapp.net'), true);
    });

    it('Scoped key should allow specified chats only', () => {
      const auth = {
        isMaster: false,
        apiKey: 'scoped_key',
        allowedJids: ['1234567890@s.whatsapp.net'],
      };
      // Permitted
      assert.strictEqual(verifyChatPermission(auth, '1234567890'), true);
      assert.strictEqual(verifyChatPermission(auth, '+1 (234) 567-890'), true);
      // Denied
      assert.strictEqual(verifyChatPermission(auth, '9999999999'), false);
    });
  });

  describe('Webhook Signature Verification', () => {
    it('should generate consistent SHA256 HMAC signature', () => {
      const payload = JSON.stringify({ event: 'test', sessionId: 's1' });
      const secret = 'test_secret';
      const sig1 = webhookService.generateSignature(payload, secret);
      const sig2 = webhookService.generateSignature(payload, secret);
      assert.strictEqual(sig1, sig2);
      assert.strictEqual(sig1.length, 64);
    });
  });

  describe('Security & SSRF Guard Validation', () => {
    it('should block private, loopback, and cloud metadata URLs', async () => {
      const { isSafePublicUrl } = await import('../utils/security.js');
      assert.strictEqual(isSafePublicUrl('http://127.0.0.1/secret'), false);
      assert.strictEqual(isSafePublicUrl('http://localhost:3000/api'), false);
      assert.strictEqual(isSafePublicUrl('http://169.254.169.254/latest/meta-data'), false);
      assert.strictEqual(isSafePublicUrl('http://192.168.1.1/admin'), false);
      assert.strictEqual(isSafePublicUrl('http://10.0.0.5/api'), false);
      assert.strictEqual(isSafePublicUrl('file:///etc/passwd'), false);
    });

    it('should allow legitimate public HTTPS URLs', async () => {
      const { isSafePublicUrl } = await import('../utils/security.js');
      assert.strictEqual(isSafePublicUrl('https://images.unsplash.com/photo-123.jpg'), true);
      assert.strictEqual(isSafePublicUrl('https://example.com/invoice.pdf'), true);
    });

    it('should correctly format Bangladesh 017 local numbers to 88017', () => {
      assert.strictEqual(formatWhatsAppJid('01712345678'), '8801712345678@s.whatsapp.net');
      assert.strictEqual(formatWhatsAppJid('+880 1712-345678'), '8801712345678@s.whatsapp.net');
    });
  });
});
