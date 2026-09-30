import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { aiBridgeService } from '../services/ai.service.js';
import { sessionManager } from '../services/session.service.js';
import { formatWhatsAppJid } from '../utils/jid.js';
import { verifyChatPermission } from '../middlewares/auth.middleware.js';

export async function aiRoutes(fastify: FastifyInstance) {
  // Test AI prompt / generation directly
  fastify.post(
    '/api/ai/ask',
    {
      schema: {
        description: 'Directly test the AI Chatbot bridge with a customer inquiry',
        tags: ['AI Bridge'],
        body: z.object({
          message: z.string().min(1),
          senderPhone: z.string().default('tester'),
          customPrompt: z.string().optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            response: z.string().nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { message, senderPhone, customPrompt } = request.body as {
        message: string;
        senderPhone: string;
        customPrompt?: string;
      };

      const response = await aiBridgeService.generateReply(message, senderPhone, customPrompt);
      return reply.send({
        success: true,
        response,
      });
    }
  );

  // Send an AI-generated answer directly to a WhatsApp user
  fastify.post(
    '/api/:sessionId/ai/reply',
    {
      schema: {
        description: 'Generate an AI answer and immediately dispatch it to a customer on WhatsApp',
        tags: ['AI Bridge'],
        params: z.object({
          sessionId: z.string(),
        }),
        body: z.object({
          to: z.string().min(5),
          prompt: z.string().min(1),
          customSystemPrompt: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const { to, prompt, customSystemPrompt } = request.body as {
        to: string;
        prompt: string;
        customSystemPrompt?: string;
      };

      if (!verifyChatPermission(request.auth, to)) {
        return reply.status(403).send({
          success: false,
          error: `Forbidden: API key does not have permission for "${to}"`,
        });
      }

      const formattedJid = formatWhatsAppJid(to);
      const aiReply = await aiBridgeService.generateReply(prompt, formattedJid, customSystemPrompt);

      if (!aiReply) {
        return reply.status(500).send({
          success: false,
          error: 'AI service failed to generate reply or AI is not enabled',
        });
      }

      const sent = await sessionManager.sendTextMessage(sessionId, formattedJid, aiReply, {
        simulatePresence: true,
      });

      return reply.send({
        success: true,
        messageId: sent?.key?.id || 'unknown',
        aiResponse: aiReply,
        to: formattedJid,
      });
    }
  );
}
