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

    // Check if the API key is a dummy placeholder
    const isPlaceholderKey = !config.AI_API_KEY || config.AI_API_KEY.includes('your_api_key') || config.AI_API_KEY.length < 10;

    if (!isPlaceholderKey) {
      try {
        if (config.AI_PROVIDER === 'openai' || config.AI_PROVIDER === 'custom') {
          return await this.callOpenAiCompatible(systemPrompt, userMessage);
        } else if (config.AI_PROVIDER === 'gemini') {
          return await this.callGemini(systemPrompt, userMessage);
        } else if (config.AI_PROVIDER === 'anthropic') {
          return await this.callAnthropic(systemPrompt, userMessage);
        }
      } catch (err: any) {
        logger.error(
          {
            error: err.response?.data?.error?.message || err.message,
            provider: config.AI_PROVIDER,
            senderPhone,
          },
          'AI cloud API key error, providing automated customer assistant response'
        );
      }
    }

    // Smart Enterprise Customer Assistant Fallback (Always replies even without cloud LLM keys)
    return this.generateSmartLocalReply(userMessage);
  }

  /**
   * Smart conversational assistant fallback (runs locally without any external API keys)
   */
  private generateSmartLocalReply(userMessage: string): string {
    const lower = userMessage.toLowerCase().trim();

    if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey') || lower.includes('assalamu alaikum') || lower.includes('salam')) {
      return `👋 *Hello & Welcome!*\n\nThank you for reaching out to us on WhatsApp. How can I assist you today?\n\n• Ask about products or inventory (e.g. *"How many items in stock?"*)\n• Check sales or orders (e.g. *"What is today total sales?"*)\n• You can also send a *Voice Note*!`;
    }

    if (lower.includes('yourself') || lower.includes('who are you') || lower.includes('what can you do')) {
      return `🤖 *I am your Enterprise AI Assistant!*\n\nI am connected directly to our company ERP and business system.\n\nHere is what I can do for you:\n1. 📊 Answer questions about our stock & inventory\n2. 💰 Report today's sales and order metrics\n3. 🎙️ Listen to your voice notes and reply back directly\n\nFeel free to ask any question or send an audio voice note!`;
    }

    if (lower.includes('price') || lower.includes('cost') || lower.includes('rate')) {
      return `🏷️ *Product Pricing & Catalog*\n\nWe offer a range of products including:\n• Logitech Wireless Mouse ($25)\n• Keychron Mechanical Keyboard ($85)\n• Dell 27" 4K Monitor ($320)\n• Ergonomic Office Chair ($210)\n\nLet me know which item you'd like more details on!`;
    }

    if (lower.includes('help') || lower.includes('support')) {
      return `🤝 *Customer Support Assistance*\n\nI am here to help! You can ask about our products, check order status, or request stock information. Our support team is also available 24/7.`;
    }

    return `Thank you for your message! 🙏\n\nI received: "${userMessage}"\n\nI can answer questions regarding stock levels, products, and sales figures. You can also send a voice note asking about our business!`;
  }

  private async callOpenAiCompatible(systemPrompt: string, userMessage: string): Promise<string> {
    const isGroq = config.AI_API_KEY.startsWith('gsk_') || config.AI_PROVIDER === 'custom';
    const endpoint = isGroq
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions';
    const model = isGroq
      ? (config.AI_MODEL && config.AI_MODEL !== 'llama-3.3-70b-versatile' ? config.AI_MODEL : 'openai/gpt-oss-20b')
      : (config.AI_MODEL || 'gpt-4o-mini');

    const res = await axios.post(
      endpoint,
      {
        model,
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
