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
  // Voice Transcription & Audio Response Config
  VOICE_QUERY_ENABLED: z.coerce.boolean().default(true),
  VOICE_TRANSCRIPTION_PROVIDER: z.enum(['groq', 'openai', 'gemini', 'local_whisper']).default('groq'),
  VOICE_REPLY_MODE: z.enum(['voice', 'text', 'both']).default('voice'),
  TTS_PROVIDER: z.enum(['google', 'openai', 'elevenlabs']).default('google'),
  ELEVENLABS_API_KEY: z.string().optional().default(''),
  GROQ_API_KEY: z.string().optional().default(''),
  GROQ_MODEL: z.string().default('openai/gpt-oss-20b'),
  GROQ_WHISPER_MODEL: z.string().default('whisper-large-v3'),
  LOCAL_WHISPER_URL: z.string().optional().default('http://localhost:8000/v1/audio/transcriptions'),
  // ERP / Database Query Config
  ERP_QUERY_ENABLED: z.coerce.boolean().default(true),
  ERP_DB_TYPE: z.enum(['mock', 'postgres']).default('mock'),
  ERP_DB_HOST: z.string().default('localhost'),
  ERP_DB_PORT: z.coerce.number().default(5432),
  ERP_DB_USER: z.string().default('ai_reader'),
  ERP_DB_PASSWORD: z.string().default(''),
  ERP_DB_NAME: z.string().default('erp_database'),
  ERP_DB_SSL: z.coerce.boolean().default(false),
  // ERP LLM Provider for Text-to-SQL & Answer Formatting
  ERP_LLM_PROVIDER: z.enum(['groq', 'gemini', 'openai']).default('groq'),
  ERP_LLM_MODEL: z.string().default('openai/gpt-oss-20b'),
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
