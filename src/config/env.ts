import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  MASTER_API_KEY: z.string().default('master_secret_key_whatsapp_gateway_2026'),
  SCOPED_API_KEYS: z.string().default('{}'),
  GLOBAL_WEBHOOK_URL: z.string().url().optional().or(z.literal('')),
  WEBHOOK_SECRET: z.string().default('gateway_webhook_signature_secret_xyz'),
  PRESENCE_MIN_DELAY_MS: z.coerce.number().default(1500),
  PRESENCE_MAX_DELAY_MS: z.coerce.number().default(3000),
  QUEUE_MESSAGE_DELAY_MS: z.coerce.number().default(3000),
  AI_BRIDGE_ENABLED: z.coerce.boolean().default(false),
  AI_PROVIDER: z.enum(['openai', 'gemini', 'anthropic', 'custom']).default('openai'),
  AI_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_SYSTEM_PROMPT: z.string().default(
    'You are a helpful and polite WhatsApp customer support assistant. Keep answers concise, clear, and formatted nicely for WhatsApp.'
  ),
  SESSIONS_DIR: z.string().default('./sessions'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid environment variables:', parsedEnv.error.format());
  process.exit(1);
}

let parsedScopedKeys: Record<string, string[]> = {};
try {
  parsedScopedKeys = JSON.parse(parsedEnv.data.SCOPED_API_KEYS || '{}');
} catch (e) {
  console.warn('Failed to parse SCOPED_API_KEYS JSON. Defaulting to empty map.');
}

export const config = {
  ...parsedEnv.data,
  SCOPED_KEYS_MAP: parsedScopedKeys,
};

export type Config = typeof config;
