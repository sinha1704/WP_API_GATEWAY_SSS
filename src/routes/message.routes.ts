import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionManager } from '../services/session.service.js';
import { formatWhatsAppJid } from '../utils/jid.js';
import { verifyChatPermission } from '../middlewares/auth.middleware.js';
import { isSafePublicUrl } from '../utils/security.js';

export async function messageRoutes(fastify: FastifyInstance) {
  // Common handler for text messages
  const handleSendTextMessage = async (
    request: any,
    reply: any,
    sessionIdInput?: string
  ) => {
    const body = request.body as {
      sessionId?: string;
      to: string;
      message: string;
      simulatePresence?: boolean;
      quotedMessageId?: string;
    };

    const sessionId = sessionIdInput || body.sessionId || 'session-1';

    if (!verifyChatPermission(request.auth, body.to)) {
      return reply.status(403).send({
        success: false,
        error: `Forbidden: API key does not have permission to send messages to "${body.to}"`,
      });
    }

    let formattedJid: string;
    try {
      formattedJid = formatWhatsAppJid(body.to);
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err.message,
      });
    }

    try {
      const sent = await sessionManager.sendTextMessage(
        sessionId,
        formattedJid,
        body.message,
        {
          simulatePresence: body.simulatePresence ?? true,
          quotedMessageId: body.quotedMessageId,
        }
      );

      return reply.send({
        success: true,
        sessionId,
        messageId: sent?.key?.id || 'unknown',
        to: formattedJid,
        timestamp: Number(sent?.messageTimestamp) * 1000 || Date.now(),
      });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        error: err.message,
      });
    }
  };

  // Endpoint with sessionId in path: POST /api/:sessionId/messages/text
  fastify.post(
    '/api/:sessionId/messages/text',
    {
      schema: {
        description: 'Send a formatted text message to a phone number or group JID',
        tags: ['Messages'],
        params: z.object({
          sessionId: z.string().describe('Target WhatsApp session ID'),
        }),
        body: z.object({
          to: z.string().min(5).describe('Recipient phone number (+123456789) or JID'),
          message: z.string().min(1).describe('Text content of the message'),
          simulatePresence: z
            .boolean()
            .optional()
            .default(true)
            .describe('Simulate human typing indicator before sending'),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      return handleSendTextMessage(request, reply, sessionId);
    }
  );

  // Flat alias endpoint without sessionId in path: POST /api/messages/text
  fastify.post(
    '/api/messages/text',
    {
      schema: {
        description: 'Send a formatted text message (sessionId optional in body, defaults to session-1)',
        tags: ['Messages'],
        body: z.object({
          sessionId: z.string().optional().default('session-1').describe('WhatsApp session ID'),
          to: z.string().min(5).describe('Recipient phone number or JID'),
          message: z.string().min(1).describe('Text content of the message'),
          simulatePresence: z.boolean().optional().default(true),
        }),
      },
    },
    async (request, reply) => {
      return handleSendTextMessage(request, reply);
    }
  );

  // Send Media Message (URL or Multipart file upload)
  fastify.post(
    '/api/:sessionId/messages/media',
    {
      schema: {
        description: 'Send images, videos, audio/voice notes, or documents/PDFs via public URL or file',
        tags: ['Messages'],
        params: z.object({
          sessionId: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const params = (request.params || {}) as { sessionId?: string };

      // Check if multipart form
      if (request.isMultipart()) {
        const data = await request.file();
        if (!data) {
          return reply.status(400).send({ success: false, error: 'No file uploaded' });
        }

        const fields: any = data.fields;
        const sessionId = params.sessionId || fields.sessionId?.value || 'session-1';
        const to = fields.to?.value;
        const type = fields.type?.value || 'document';
        const caption = fields.caption?.value;
        const ptt = fields.ptt?.value === 'true';

        if (!to) {
          return reply.status(400).send({ success: false, error: 'Recipient "to" field is required' });
        }

        if (!verifyChatPermission(request.auth, to)) {
          return reply.status(403).send({
            success: false,
            error: `Forbidden: API key does not have permission to send messages to "${to}"`,
          });
        }

        const formattedJid = formatWhatsAppJid(to);
        const buffer = await data.toBuffer();

        try {
          const sent = await sessionManager.sendMediaMessage(sessionId, formattedJid, {
            type,
            buffer,
            caption,
            fileName: data.filename,
            mimetype: data.mimetype,
            ptt,
          });

          return reply.send({
            success: true,
            sessionId,
            messageId: sent?.key?.id || 'unknown',
            to: formattedJid,
            timestamp: Number(sent?.messageTimestamp) * 1000 || Date.now(),
          });
        } catch (err: any) {
          return reply.status(500).send({ success: false, error: err.message });
        }
      }

      // JSON payload containing public media URL
      const body = request.body as {
        sessionId?: string;
        to: string;
        type: 'image' | 'video' | 'audio' | 'document';
        url: string;
        caption?: string;
        fileName?: string;
        mimetype?: string;
        ptt?: boolean;
        simulatePresence?: boolean;
      };

      if (!body?.to || !body?.url || !body?.type) {
        return reply.status(400).send({
          success: false,
          error: 'Fields "to", "type", and "url" are required for JSON media payload',
        });
      }

      // SSRF defense: block internal IP addresses and loopback URLs
      if (!isSafePublicUrl(body.url)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid or restricted media URL. Internal networks, loopbacks, and non-HTTP protocols are blocked for security.',
        });
      }

      const rawSessionId = params.sessionId || body.sessionId || 'session-1';
      // Sanitize sessionId against directory traversal
      if (!/^[a-zA-Z0-9_-]+$/.test(rawSessionId)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid sessionId format. Only alphanumeric characters, dashes, and underscores are permitted.',
        });
      }
      const sessionId = rawSessionId;

      if (!verifyChatPermission(request.auth, body.to)) {
        return reply.status(403).send({
          success: false,
          error: `Forbidden: API key does not have permission to send messages to "${body.to}"`,
        });
      }

      const formattedJid = formatWhatsAppJid(body.to);

      try {
        const sent = await sessionManager.sendMediaMessage(
          sessionId,
          formattedJid,
          {
            type: body.type,
            url: body.url,
            caption: body.caption,
            fileName: body.fileName,
            mimetype: body.mimetype,
            ptt: body.ptt,
          },
          { simulatePresence: body.simulatePresence }
        );

        return reply.send({
          success: true,
          sessionId,
          messageId: sent?.key?.id || 'unknown',
          to: formattedJid,
          timestamp: Number(sent?.messageTimestamp) * 1000 || Date.now(),
        });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    }
  );

  // Send Message Reaction
  fastify.post(
    '/api/:sessionId/messages/reaction',
    {
      schema: {
        description: 'Send an emoji reaction to a specific WhatsApp message',
        tags: ['Messages'],
        params: z.object({
          sessionId: z.string().optional(),
        }),
        body: z.object({
          sessionId: z.string().optional(),
          to: z.string().min(5).describe('Chat JID or phone number where message exists'),
          messageId: z.string().min(1).describe('The WhatsApp message key ID to react to'),
          emoji: z.string().describe('Emoji to react with (e.g. 👍, ❤️, 🔥)'),
        }),
      },
    },
    async (request, reply) => {
      const params = (request.params || {}) as { sessionId?: string };
      const body = request.body as {
        sessionId?: string;
        to: string;
        messageId: string;
        emoji: string;
      };

      const sessionId = params.sessionId || body.sessionId || 'session-1';

      if (!verifyChatPermission(request.auth, body.to)) {
        return reply.status(403).send({
          success: false,
          error: `Forbidden: API key does not have permission to react in chat "${body.to}"`,
        });
      }

      const formattedJid = formatWhatsAppJid(body.to);

      try {
        const sent = await sessionManager.sendReaction(sessionId, formattedJid, body.messageId, body.emoji);
        return reply.send({
          success: true,
          sessionId,
          messageId: sent?.key?.id || 'unknown',
        });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    }
  );
}
