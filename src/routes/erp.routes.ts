import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { erpDatabaseService } from '../services/erp-database.service.js';
import { erpQueryAgentService } from '../services/erp-agent.service.js';
import { voiceTranscriptionService } from '../services/voice.service.js';
import { sessionManager } from '../services/session.service.js';
import { formatWhatsAppJid } from '../utils/jid.js';
import { verifyChatPermission } from '../middlewares/auth.middleware.js';

export async function erpRoutes(fastify: FastifyInstance) {
  /**
   * 1. Query ERP Database directly via natural language question
   */
  fastify.post(
    '/api/erp/ask',
    {
      schema: {
        description: 'Ask any business/ERP question in natural language (translates to safe Read-Only SQL and queries database)',
        tags: ['Voice & ERP AI'],
        body: z.object({
          question: z.string().min(1).describe("Business question e.g. 'How many items are in stock?' or 'What was today total sales?'"),
          senderPhone: z.string().optional().default('api-user'),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            question: z.string(),
            generatedSql: z.string().optional(),
            queryResults: z.any().optional(),
            formattedAnswer: z.string(),
            isDatabaseQuery: z.boolean(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { question, senderPhone } = request.body as { question: string; senderPhone?: string };
      const result = await erpQueryAgentService.processBusinessInquiry(question, senderPhone);
      return reply.send({
        success: true,
        question: result.question,
        generatedSql: result.generatedSql,
        queryResults: result.queryResults,
        formattedAnswer: result.formattedAnswer,
        isDatabaseQuery: result.isDatabaseQuery,
      });
    }
  );

  /**
   * 2. Send ERP query answer directly to a WhatsApp recipient
   */
  fastify.post(
    '/api/:sessionId/erp/reply',
    {
      schema: {
        description: 'Process an ERP inquiry and immediately send the formatted answer to a WhatsApp user',
        tags: ['Voice & ERP AI'],
        params: z.object({
          sessionId: z.string(),
        }),
        body: z.object({
          to: z.string().min(5),
          question: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const { to, question } = request.body as { to: string; question: string };

      if (!verifyChatPermission(request.auth, to)) {
        return reply.status(403).send({
          success: false,
          error: `Forbidden: API key does not have permission for "${to}"`,
        });
      }

      const formattedJid = formatWhatsAppJid(to);
      const erpResult = await erpQueryAgentService.processBusinessInquiry(question, formattedJid);

      const sent = await sessionManager.sendTextMessage(
        sessionId,
        formattedJid,
        erpResult.formattedAnswer,
        { simulatePresence: true }
      );

      return reply.send({
        success: true,
        messageId: sent?.key?.id || 'unknown',
        to: formattedJid,
        question,
        generatedSql: erpResult.generatedSql,
        formattedAnswer: erpResult.formattedAnswer,
      });
    }
  );

  /**
   * 3. Voice-to-Text Audio Transcription Endpoint
   */
  fastify.post(
    '/api/voice/transcribe',
    {
      schema: {
        description: 'Upload an audio file / voice note and transcribe to text using configured Whisper / Gemini provider',
        tags: ['Voice & ERP AI'],
      },
    },
    async (request, reply) => {
      if (!request.isMultipart()) {
        return reply.status(400).send({ success: false, error: 'Multipart file upload required' });
      }

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ success: false, error: 'No audio file found in upload' });
      }

      const buffer = await data.toBuffer();
      const mimetype = data.mimetype || 'audio/ogg';
      const filename = data.filename || 'voice-note.ogg';

      try {
        const transcribedText = await voiceTranscriptionService.transcribeAudio(
          buffer,
          mimetype,
          filename
        );

        return reply.send({
          success: true,
          transcribedText,
          audioSizeBytes: buffer.length,
          mimetype,
        });
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: `Transcription failed: ${err.message}`,
        });
      }
    }
  );

  /**
   * 4. Full Voice-to-Database / ERP Pipeline test endpoint
   * Upload audio -> Transcribes -> Runs Read-Only SQL -> Formats Answer -> (Optionally sends to WhatsApp)
   */
  fastify.post(
    '/api/voice/erp-query',
    {
      schema: {
        description: 'Full Voice-to-ERP Pipeline: Upload audio voice note, transcribe, query Read-Only DB, and return formatted response',
        tags: ['Voice & ERP AI'],
      },
    },
    async (request, reply) => {
      if (!request.isMultipart()) {
        return reply.status(400).send({ success: false, error: 'Multipart voice note upload required' });
      }

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ success: false, error: 'No voice note uploaded' });
      }

      const buffer = await data.toBuffer();
      const fields: any = data.fields;
      const targetPhone = fields?.to?.value;
      const sessionId = fields?.sessionId?.value || 'session-1';

      try {
        // Step 1: Transcribe audio
        const transcribedText = await voiceTranscriptionService.transcribeAudio(
          buffer,
          data.mimetype || 'audio/ogg',
          data.filename || 'voice.ogg'
        );

        // Step 2: Query ERP
        const erpResult = await erpQueryAgentService.processBusinessInquiry(
          transcribedText,
          targetPhone
        );

        // Step 3: If target phone provided, dispatch via WhatsApp
        let dispatchedMessageId: string | undefined;
        if (targetPhone) {
          const jid = formatWhatsAppJid(targetPhone);
          const sent = await sessionManager.sendTextMessage(
            sessionId,
            jid,
            erpResult.formattedAnswer,
            { simulatePresence: true }
          );
          dispatchedMessageId = sent?.key?.id;
        }

        return reply.send({
          success: true,
          transcribedText,
          generatedSql: erpResult.generatedSql,
          queryResults: erpResult.queryResults,
          formattedAnswer: erpResult.formattedAnswer,
          dispatchedToWhatsApp: Boolean(dispatchedMessageId),
          messageId: dispatchedMessageId,
        });
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: `Voice-to-ERP query failed: ${err.message}`,
        });
      }
    }
  );

  /**
   * 5. ERP Safe Direct SQL Query (Protected by Database Security Guard)
   */
  fastify.post(
    '/api/erp/sql-safe',
    {
      schema: {
        description: 'Execute read-only SQL query directly with strict security guardrail enforcement',
        tags: ['Voice & ERP AI'],
        body: z.object({
          sql: z.string().min(5),
        }),
      },
    },
    async (request, reply) => {
      const { sql } = request.body as { sql: string };
      const res = await erpDatabaseService.executeSafeQuery(sql);
      if (!res.success) {
        return reply.status(400).send(res);
      }
      return reply.send(res);
    }
  );

  /**
   * 6. Live Safety & Security Guardrail Tester (for UI Dashboard)
   */
  fastify.post(
    '/api/safety/check',
    {
      schema: {
        description: 'Test text against anti-abuse and confidential data leakage guardrails',
        tags: ['Voice & ERP AI'],
        body: z.object({
          text: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { text } = request.body as { text: string };
      const { aiBridgeService } = await import('../services/ai.service.js');
      const interceptedResponse = aiBridgeService.filterSensitiveOrAbusiveInput(text);

      return reply.send({
        success: true,
        inputText: text,
        isBlockedOrFlagged: Boolean(interceptedResponse),
        safetyResponse: interceptedResponse || 'Passed all safety checks (Clean & Authorized)',
      });
    }
  );

  /**
   * 7. Synthesize Speech Audio Endpoint (Generates WhatsApp Opus audio for browser playback)
   */
  fastify.post(
    '/api/voice/synthesize',
    {
      schema: {
        description: 'Synthesize text to speech audio note (WhatsApp Opus)',
        tags: ['Voice & ERP AI'],
        body: z.object({
          text: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { text } = request.body as { text: string };
      try {
        const speech = await voiceTranscriptionService.synthesizeSpeech(text);
        reply.header('Content-Type', speech.mimetype);
        return reply.send(speech.buffer);
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    }
  );

  /**
   * 8. RAG Enterprise Knowledge Search Endpoint
   */
  fastify.post(
    '/api/rag/search',
    {
      schema: {
        description: 'Search company policies, FAQs, and documentation using Enterprise RAG Engine',
        tags: ['Voice & ERP AI'],
        body: z.object({
          query: z.string().min(1),
          topK: z.number().optional().default(3),
        }),
      },
    },
    async (request, reply) => {
      const { query, topK } = request.body as { query: string; topK?: number };
      const { ragKnowledgeService } = await import('../services/rag.service.js');
      const docs = await ragKnowledgeService.searchRelevantKnowledge(query, topK);
      return reply.send({
        success: true,
        query,
        count: docs.length,
        results: docs,
      });
    }
  );

  /**
   * 9. List and Add RAG Documents Endpoint
   */
  fastify.get(
    '/api/rag/documents',
    {
      schema: {
        description: 'List all verified enterprise policy and knowledge documents',
        tags: ['Voice & ERP AI'],
      },
    },
    async (request, reply) => {
      const { ragKnowledgeService } = await import('../services/rag.service.js');
      return reply.send({
        success: true,
        documents: ragKnowledgeService.listAllDocuments(),
      });
    }
  );

  fastify.post(
    '/api/rag/documents',
    {
      schema: {
        description: 'Upload a new policy or document into the RAG knowledge store',
        tags: ['Voice & ERP AI'],
        body: z.object({
          title: z.string().min(1),
          category: z.string().default('Policy'),
          content: z.string().min(5),
          keywords: z.array(z.string()).optional(),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as { title: string; category: string; content: string; keywords?: string[] };
      const { ragKnowledgeService } = await import('../services/rag.service.js');
      const added = await ragKnowledgeService.addDocument(body);
      return reply.send({
        success: true,
        document: added,
      });
    }
  );
}
