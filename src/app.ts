import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from 'fastify-type-provider-zod';

import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import { authenticateApiKey } from './middlewares/auth.middleware.js';
import { sessionRoutes } from './routes/session.routes.js';
import { messageRoutes } from './routes/message.routes.js';
import { aiRoutes } from './routes/ai.routes.js';
import { erpRoutes } from './routes/erp.routes.js';

export async function buildApp() {
  const app = Fastify({
    logger: false, // handled via custom pino logger
    bodyLimit: 104857600, // 100MB for media uploads
  });

  // Setup Zod Type Provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Security Plugins
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
    },
  });

  // Global rate limiter
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  // Swagger Documentation configuration
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Production WhatsApp API Gateway',
        description:
          'High-speed, multi-account WhatsApp REST API Gateway built on Baileys with Anti-Ban throttled queues, Webhooks, and AI Chatbot integration.',
        version: '1.0.0',
      },
      servers: [
        {
          url: `http://localhost:${config.PORT}`,
          description: 'Local gateway',
        },
      ],
      components: {
        securitySchemes: {
          apiKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
            description: 'Master or Chat-scoped API Key',
          },
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'Bearer token format for API Key',
          },
        },
      },
      security: [{ apiKeyAuth: [] }, { bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
  });

  // Centralized Authentication Hook
  app.addHook('preHandler', authenticateApiKey);

  // Health and root endpoint
  app.get('/health', async () => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };
  });

  app.get('/', async (request, reply) => {
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>WhatsApp API Gateway</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b141a; color: #e9edef; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #111b21; border: 1px solid #202c33; padding: 2.5rem; border-radius: 14px; max-width: 520px; width: 90%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); text-align: center; }
            h1 { color: #00a884; margin-top: 0; font-size: 1.8rem; }
            p { color: #8696a0; line-height: 1.6; font-size: 0.95rem; }
            .actions { display: flex; gap: 12px; justify-content: center; margin-top: 20px; flex-wrap: wrap; }
            .btn { display: inline-block; padding: 12px 24px; background: #00a884; color: #111b21; text-decoration: none; border-radius: 8px; font-weight: 700; transition: opacity 0.2s; }
            .btn:hover { opacity: 0.9; }
            .btn-secondary { background: #202c33; color: #00a884; border: 1px solid #00a884; }
            .badge { background: #202c33; color: #25d366; padding: 4px 10px; border-radius: 6px; font-size: 0.85rem; font-family: monospace; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>WhatsApp API Gateway</h1>
            <p>Production self-hosted WhatsApp API Gateway with multi-device Baileys, Anti-Ban queues, and AI bot integration.</p>
            <p>Status: <span class="badge">ONLINE</span></p>
            <div class="actions">
              <a href="/scan" class="btn">📱 Open QR Scanner UI</a>
              <a href="/docs" class="btn btn-secondary">📖 Swagger API Docs</a>
            </div>
          </div>
        </body>
      </html>
    `);
  });

  // Dedicated QR Code Scanner Dashboard
  app.get('/scan', async (request, reply) => {
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>WhatsApp Web Scanner - Link Device</title>
          <style>
            :root {
              --bg: #0b141a;
              --card: #111b21;
              --border: #202c33;
              --primary: #00a884;
              --text: #e9edef;
              --muted: #8696a0;
            }
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              background-color: var(--bg);
              color: var(--text);
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              padding: 20px;
              box-sizing: border-box;
            }
            .container {
              background: var(--card);
              border: 1px solid var(--border);
              border-radius: 16px;
              padding: 2.5rem;
              max-width: 480px;
              width: 100%;
              text-align: center;
              box-shadow: 0 16px 40px rgba(0,0,0,0.6);
            }
            h1 {
              color: var(--primary);
              margin-top: 0;
              font-size: 1.6rem;
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 10px;
            }
            p {
              color: var(--muted);
              font-size: 0.95rem;
              line-height: 1.5;
            }
            .form-group {
              margin: 20px 0;
              text-align: left;
            }
            label {
              display: block;
              font-size: 0.85rem;
              color: var(--muted);
              margin-bottom: 6px;
              font-weight: 600;
            }
            input {
              width: 100%;
              padding: 12px;
              background: #202c33;
              border: 1px solid #2a3942;
              border-radius: 8px;
              color: var(--text);
              font-size: 0.95rem;
              box-sizing: border-box;
              outline: none;
            }
            input:focus {
              border-color: var(--primary);
            }
            button {
              width: 100%;
              padding: 12px;
              background: var(--primary);
              border: none;
              border-radius: 8px;
              color: #111b21;
              font-weight: 700;
              font-size: 1rem;
              cursor: pointer;
              transition: opacity 0.2s;
            }
            button:hover {
              opacity: 0.9;
            }
            .qr-box {
              background: #ffffff;
              padding: 16px;
              border-radius: 12px;
              display: inline-block;
              margin: 20px 0;
              min-width: 260px;
              min-height: 260px;
              position: relative;
            }
            .qr-box img {
              display: block;
              width: 260px;
              height: 260px;
            }
            .status-badge {
              display: inline-block;
              padding: 6px 14px;
              border-radius: 20px;
              font-size: 0.85rem;
              font-weight: 600;
              letter-spacing: 0.5px;
            }
            .status-init { background: #eab308; color: #111b21; }
            .status-connected { background: var(--primary); color: #111b21; }
            .status-disconnected { background: #ef4444; color: #fff; }
            .instructions {
              text-align: left;
              background: #182229;
              padding: 14px 18px;
              border-radius: 8px;
              font-size: 0.85rem;
              color: var(--muted);
              margin-top: 20px;
            }
            .instructions ol {
              margin: 0;
              padding-left: 20px;
            }
            .instructions li {
              margin-bottom: 6px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1><span>📱</span> WhatsApp QR Scanner</h1>
            <p>Pair any WhatsApp number to create an active API session.</p>

            <div class="form-group">
              <label for="sessionId">Session ID:</label>
              <input type="text" id="sessionId" value="session-1" placeholder="e.g. sales-number-1" />
            </div>

            <div class="form-group">
              <label for="apiKey">Master or API Key:</label>
              <input type="password" id="apiKey" value="master_secret_key_whatsapp_gateway_2026" />
            </div>

            <button onclick="startSession()">Generate QR Code</button>

            <div id="qrArea" style="display: none;">
              <div class="qr-box">
                <img id="qrImage" src="" alt="Scanning QR..." />
              </div>
              <div>
                <span id="statusBadge" class="status-badge status-init">WAITING FOR SCAN</span>
              </div>
            </div>

            <div class="instructions">
              <strong style="color: var(--text);">How to scan:</strong>
              <ol>
                <li>Open <strong>WhatsApp</strong> on your mobile phone.</li>
                <li>Tap <strong>Settings / Three dots</strong> &gt; <strong>Linked Devices</strong>.</li>
                <li>Tap <strong>Link a Device</strong> and point your camera at this QR code.</li>
              </ol>
            </div>
          </div>

          <script>
            let pollInterval = null;

            async function startSession() {
              const sessionId = document.getElementById('sessionId').value.trim();
              const apiKey = document.getElementById('apiKey').value.trim();

              if (!sessionId) {
                alert('Please enter a session ID');
                return;
              }

              // 1. Initialize session
              try {
                const res = await fetch('/api/sessions/start', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': apiKey
                  },
                  body: JSON.stringify({ sessionId })
                });

                const data = await res.json();
                if (!res.ok) {
                  alert('Error starting session: ' + (data.error || 'Unknown error'));
                  return;
                }

                document.getElementById('qrArea').style.display = 'block';
                pollQr(sessionId, apiKey);
              } catch (err) {
                alert('Network error starting session: ' + err.message);
              }
            }

            function pollQr(sessionId, apiKey) {
              if (pollInterval) clearInterval(pollInterval);

              const check = async () => {
                try {
                  const res = await fetch('/api/sessions/' + sessionId + '/qr?format=json', {
                    headers: { 'X-API-Key': apiKey }
                  });
                  const data = await res.json();

                  const statusBadge = document.getElementById('statusBadge');

                  if (data.status === 'CONNECTED') {
                    statusBadge.className = 'status-badge status-connected';
                    statusBadge.innerText = '✅ CONNECTED';
                    document.getElementById('qrImage').style.display = 'none';
                    clearInterval(pollInterval);
                    return;
                  }

                  if (data.qrDataUrl) {
                    document.getElementById('qrImage').src = data.qrDataUrl;
                    document.getElementById('qrImage').style.display = 'block';
                    statusBadge.className = 'status-badge status-init';
                    statusBadge.innerText = '⏳ SCAN QR CODE NOW';
                  } else {
                    statusBadge.innerText = 'GENERATING QR...';
                  }
                } catch (e) {
                  console.error(e);
                }
              };

              check();
              pollInterval = setInterval(check, 3000);
            }
          </script>
        </body>
      </html>
    `);
  });

  // Register feature routes
  await app.register(sessionRoutes);
  await app.register(messageRoutes);
  await app.register(aiRoutes);
  await app.register(erpRoutes);

  // Centralized Error Handling
  app.setErrorHandler((error: any, request, reply) => {
    logger.error({ err: error, url: request.raw.url }, 'API Gateway Error caught');
    return reply.status(error.statusCode || 500).send({
      success: false,
      error: error.message || 'Internal Server Error',
    });
  });

  return app;
}
