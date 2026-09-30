import axios from 'axios';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class AiBridgeService {
  private static instance: AiBridgeService;

  private constructor() {}

  public static getInstance(): AiBridgeService {
    if (!AiBridgeService.instance) {
      AiBridgeService.instance = new AiBridgeService();
    }
    return AiBridgeService.instance;
  }

  /**
   * Generates response using configured LLM Provider (OpenAI, Gemini, Anthropic, or Custom)
   */
  public async generateReply(
    userMessage: string,
    senderPhone: string,
    customPrompt?: string
  ): Promise<string | null> {
    if (!config.AI_BRIDGE_ENABLED) {
      return null;
    }

    if (!config.AI_API_KEY) {
      logger.warn('AI Bridge is enabled but AI_API_KEY is not configured');
      return null;
    }

    const systemPrompt = customPrompt || config.AI_SYSTEM_PROMPT;

    try {
      if (config.AI_PROVIDER === 'openai' || config.AI_PROVIDER === 'custom') {
        return await this.callOpenAiCompatible(systemPrompt, userMessage);
      } else if (config.AI_PROVIDER === 'gemini') {
        return await this.callGemini(systemPrompt, userMessage);
      } else if (config.AI_PROVIDER === 'anthropic') {
        return await this.callAnthropic(systemPrompt, userMessage);
      }
      return null;
    } catch (err: any) {
      logger.error(
        {
          error: err.response?.data || err.message,
          provider: config.AI_PROVIDER,
          senderPhone,
        },
        'Failed to generate response from AI Bridge'
      );
      return null;
    }
  }

  private async callOpenAiCompatible(systemPrompt: string, userMessage: string): Promise<string> {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: config.AI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.AI_API_KEY}`,
        },
        timeout: 20000,
      }
    );

    return res.data?.choices?.[0]?.message?.content?.trim() || '';
  }

  private async callGemini(systemPrompt: string, userMessage: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.AI_MODEL || 'gemini-1.5-flash'}:generateContent?key=${config.AI_API_KEY}`;
    const res = await axios.post(
      url,
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\nCustomer question: ${userMessage}` }],
          },
        ],
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );

    return (
      res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
    );
  }

  private async callAnthropic(systemPrompt: string, userMessage: string): Promise<string> {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: config.AI_MODEL || 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          'x-api-key': config.AI_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    return res.data?.content?.[0]?.text?.trim() || '';
  }
}

export const aiBridgeService = AiBridgeService.getInstance();
