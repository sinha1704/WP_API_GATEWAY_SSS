import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionManager } from '../services/session.service.js';

export async function sessionRoutes(fastify: FastifyInstance) {
  // Start or initialize session
  fastify.post(
    '/api/sessions/start',
    {
      schema: {
        description: 'Initialize a new WhatsApp session or connect an existing one',
        tags: ['Sessions'],
        body: z.object({
          sessionId: z
            .string()
            .min(1)
            .regex(/^[a-zA-Z0-9_-]+$/, 'SessionId must only contain alphanumeric characters, dashes, and underscores')
            .describe('Unique identifier for this WhatsApp account session'),
          webhookUrl: z.string().url().optional().describe('Custom webhook URL for session events'),
          webhookSecret: z.string().optional().describe('Secret used to sign outbound webhooks'),
          aiEnabled: z.boolean().optional().describe('Enable automated AI replies for incoming chats'),
          aiPrompt: z.string().optional().describe('Custom system prompt for AI chatbot'),
          phoneNumber: z.string().optional().describe('Target phone number for Pairing Code link'),
          accessMode: z.enum(['all', 'restricted']).optional().default('all').describe("RBAC access mode: 'all' communicates with everyone; 'restricted' only interacts with allowedContacts"),
          allowedContacts: z.array(z.string()).optional().default([]).describe('Whitelist of permitted phone numbers or JIDs if accessMode is restricted'),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string(),
            status: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        sessionId: string;
        webhookUrl?: string;
        webhookSecret?: string;
        aiEnabled?: boolean;
        aiPrompt?: string;
        phoneNumber?: string;
        accessMode?: 'all' | 'restricted';
        allowedContacts?: string[];
      };

      const session = await sessionManager.initSession(body.sessionId, {
        webhookUrl: body.webhookUrl,
        webhookSecret: body.webhookSecret,
        aiEnabled: body.aiEnabled,
        aiPrompt: body.aiPrompt,
        phoneNumber: body.phoneNumber,
        accessMode: body.accessMode,
        allowedContacts: body.allowedContacts,
      });

      return reply.send({
        success: true,
        sessionId: session.id,
        status: session.status,
        message:
          session.status === 'CONNECTED'
            ? 'Session is already connected.'
            : 'Session initialized. Call /api/sessions/:sessionId/qr to retrieve pairing QR code.',
      });
    }
  );

  // List all registered sessions
  fastify.get(
    '/api/sessions',
    {
      schema: {
        description: 'List all registered sessions and their connection health',
        tags: ['Sessions'],
        response: {
          200: z.object({
            success: z.boolean(),
            sessions: z.array(
              z.object({
                id: z.string(),
                status: z.string(),
                user: z
                  .object({
                    id: z.string(),
                    name: z.string().optional(),
                  })
                  .optional(),
                hasQrCode: z.boolean(),
                queueLength: z.number(),
              })
            ),
          }),
        },
      },
    },
    async (request, reply) => {
      const sessions = sessionManager.listSessions();
      return reply.send({
        success: true,
        sessions,
      });
    }
  );

  // Get session status
  fastify.get(
    '/api/sessions/:sessionId/status',
    {
      schema: {
        description: 'Check status and health of a specific WhatsApp session',
        tags: ['Sessions'],
        params: z.object({
          sessionId: z.string(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string(),
            status: z.string(),
            user: z
              .object({
                id: z.string(),
                name: z.string().optional(),
              })
              .optional(),
            hasQrCode: z.boolean(),
            pairingCode: z.string().optional(),
            accessMode: z.string().optional(),
            allowedContacts: z.array(z.string()).optional(),
          }),
          404: z.object({
            success: z.boolean(),
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const session = sessionManager.getSession(sessionId);

      if (!session) {
        return reply.status(404).send({
          success: false,
          error: `Session "${sessionId}" not found.`,
        });
      }

      return reply.send({
        success: true,
        sessionId: session.id,
        status: session.status,
        user: session.user,
        hasQrCode: Boolean(session.qrCodeRaw),
        pairingCode: session.pairingCode,
        accessMode: session.accessMode || 'all',
        allowedContacts: session.allowedContacts || [],
      });
    }
  );

  /**
   * Update RBAC Access Control configuration for a session node
   */
  fastify.put(
    '/api/sessions/:sessionId/access',
    {
      schema: {
        description: 'Configure enterprise RBAC access rules (All contacts vs Restricted whitelist)',
        tags: ['Sessions'],
        params: z.object({
          sessionId: z.string(),
        }),
        body: z.object({
          accessMode: z.enum(['all', 'restricted']),
          allowedContacts: z.array(z.string()).default([]),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const { accessMode, allowedContacts } = request.body as {
        accessMode: 'all' | 'restricted';
        allowedContacts: string[];
      };

      const updated = sessionManager.updateAccessControl(sessionId, accessMode, allowedContacts);
      if (!updated) {
        return reply.status(404).send({ success: false, error: `Session "${sessionId}" not found` });
      }

      return reply.send({
        success: true,
        sessionId,
        accessMode,
        allowedContacts,
        message: `RBAC access rules updated for ${sessionId}`,
      });
    }
  );

  // Get QR Code
  fastify.get(
    '/api/sessions/:sessionId/qr',
    {
      schema: {
        description: 'Retrieve current pairing QR Code (Base64 data URL, SVG, and raw string)',
        tags: ['Sessions'],
        params: z.object({
          sessionId: z.string(),
        }),
        querystring: z.object({
          format: z.enum(['json', 'svg', 'image', 'html']).default('json'),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const { format } = (request.query as { format?: string }) || {};
      const session = sessionManager.getSession(sessionId);

      if (!session) {
        return reply.status(404).send({
          success: false,
          error: `Session "${sessionId}" not found. Call POST /api/sessions/start first.`,
        });
      }

      if (session.status === 'CONNECTED') {
        return reply.send({
          success: true,
          status: 'CONNECTED',
          message: 'Device is already paired and connected.',
        });
      }

      if (!session.qrCodeRaw) {
        return reply.status(202).send({
          success: false,
          status: session.status,
          message: 'QR code is not ready yet. Please retry in 1-2 seconds.',
        });
      }

      if (format === 'svg' && session.qrCodeSvg) {
        return reply.type('image/svg+xml').send(session.qrCodeSvg);
      }

      if (format === 'image' && session.qrCodeDataUrl) {
        const base64Data = session.qrCodeDataUrl.replace(/^data:image\/png;base64,/, '');
        const imgBuffer = Buffer.from(base64Data, 'base64');
        return reply.type('image/png').send(imgBuffer);
      }

      if (format === 'html') {
        const html = `
          <!DOCTYPE html>
          <html>
            <head>
              <title>WhatsApp Gateway - Pair Session ${sessionId}</title>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
                .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); text-align: center; max-width: 400px; width: 90%; }
                h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #22c55e; }
                p { color: #94a3b8; font-size: 0.9rem; margin-bottom: 1.5rem; }
                .qr-container { background: #fff; padding: 1rem; border-radius: 0.5rem; display: inline-block; margin-bottom: 1.5rem; }
                .qr-container img { display: block; max-width: 100%; height: auto; }
                .status { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; background: #eab308; color: #000; font-weight: 600; font-size: 0.8rem; }
              </style>
            </head>
            <body>
              <div class="card">
                <h1>Link WhatsApp Device</h1>
                <p>Scan this QR code with WhatsApp on your phone (Linked Devices &rarr; Link a Device).</p>
                <div class="qr-container">
                  <img src="${session.qrCodeDataUrl}" alt="Scan QR Code" width="260" height="260" />
                </div>
                <div>
                  <span class="status">STATUS: ${session.status}</span>
                </div>
              </div>
              <script>
                // Auto refresh status every 4 seconds
                setInterval(async () => {
                  const res = await fetch('/api/sessions/${sessionId}/status', {
                    headers: { 'X-API-Key': '${request.headers['x-api-key'] || ''}' }
                  });
                  const data = await res.json();
                  if (data.status === 'CONNECTED') {
                    window.location.reload();
                  }
                }, 4000);
              </script>
            </body>
          </html>
        `;
        return reply.type('text/html').send(html);
      }

      return reply.send({
        success: true,
        sessionId: session.id,
        status: session.status,
        qrRaw: session.qrCodeRaw,
        qrDataUrl: session.qrCodeDataUrl,
        instructions: 'Open WhatsApp -> Linked Devices -> Link a Device and scan the QR code.',
      });
    }
  );

  // Logout session
  fastify.post(
    '/api/sessions/:sessionId/logout',
    {
      schema: {
        description: 'Disconnect, logout from WhatsApp servers, and purge session keys',
        tags: ['Sessions'],
        params: z.object({
          sessionId: z.string(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      await sessionManager.logoutSession(sessionId);
      return reply.send({
        success: true,
        message: `Session "${sessionId}" disconnected and data purged.`,
      });
    }
  );
}
