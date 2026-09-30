import { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { formatWhatsAppJid } from '../utils/jid.js';

export interface AuthenticatedUser {
  isMaster: boolean;
  apiKey: string;
  allowedJids?: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedUser;
  }
}

/**
 * Middleware ensuring API Key security (supports X-API-Key and Bearer token)
 * Also enforces Chat-restricted multi-tenant access control
 */
export async function authenticateApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Allow public documentation, scanner, dashboard, and health check endpoints without authentication
  const path = request.url.split('?')[0];
  if (
    path === '/' ||
    path === '/dashboard' ||
    path === '/health' ||
    path === '/scan' ||
    path.startsWith('/docs') ||
    path.startsWith('/static') ||
    path === '/api/sessions' ||
    path.startsWith('/api/sessions/') ||
    path === '/api/erp/ask' ||
    path === '/api/safety/check' ||
    path === '/api/voice/transcribe' ||
    path === '/api/voice/synthesize'
  ) {
    return;
  }

  const rawHeader =
    (request.headers['x-api-key'] as string) ||
    (request.headers.authorization && request.headers.authorization.startsWith('Bearer ')
      ? request.headers.authorization.substring(7)
      : null);

  if (!rawHeader) {
    return reply.status(401).send({
      success: false,
      error: 'Unauthorized: Missing API Key. Provide via X-API-Key or Bearer token',
    });
  }

  const apiKey = rawHeader.trim();

  // 1. Check Master Key
  if (apiKey === config.MASTER_API_KEY) {
    request.auth = {
      isMaster: true,
      apiKey,
    };
    return;
  }

  // 2. Check Scoped API Keys
  const scopedAllowedJids = config.SCOPED_KEYS_MAP[apiKey];
  if (scopedAllowedJids !== undefined) {
    request.auth = {
      isMaster: false,
      apiKey,
      allowedJids: scopedAllowedJids,
    };
    return;
  }

  return reply.status(403).send({
    success: false,
    error: 'Forbidden: Invalid API Key provided',
  });
}

/**
 * Validates that an authenticated request has permission to communicate with a target JID / phone
 */
export function verifyChatPermission(
  auth: AuthenticatedUser | undefined,
  targetPhoneOrJid: string
): boolean {
  if (!auth) return false;
  if (auth.isMaster) return true;
  if (!auth.allowedJids || auth.allowedJids.length === 0) return true;

  try {
    const targetJid = formatWhatsAppJid(targetPhoneOrJid);
    return auth.allowedJids.some((allowed) => {
      try {
        return formatWhatsAppJid(allowed) === targetJid;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
