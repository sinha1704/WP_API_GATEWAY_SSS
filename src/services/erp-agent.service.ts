import axios from 'axios';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { erpDatabaseService, ERP_SCHEMA_METADATA } from './erp-database.service.js';

export interface QueryPipelineResult {
  question: string;
  generatedSql?: string;
  queryResults?: any[];
  formattedAnswer: string;
  isDatabaseQuery: boolean;
}

export class ErpQueryAgentService {
  private static instance: ErpQueryAgentService;

  private constructor() {}

  public static getInstance(): ErpQueryAgentService {
    if (!ErpQueryAgentService.instance) {
      ErpQueryAgentService.instance = new ErpQueryAgentService();
    }
    return ErpQueryAgentService.instance;
  }

  /**
   * Main pipeline:
   * Takes a voice or text question -> Determines if ERP query -> Generates safe SQL -> Executes SQL -> Formats WhatsApp response
   */
  public async processBusinessInquiry(
    question: string,
    senderPhone?: string
  ): Promise<QueryPipelineResult> {
    const trimmedQuestion = question.trim();

    logger.info({ question: trimmedQuestion, senderPhone }, 'Processing business ERP question');

    // 1. Ask LLM to generate Read-Only SQL using Schema Masking
    const sqlGeneration = await this.generateSqlFromQuestion(trimmedQuestion);

    // If LLM determines this is not a database query or cannot answer via SQL
    if (!sqlGeneration.isSql || !sqlGeneration.sql) {
      // Fallback directly to conversational answer
      return {
        question: trimmedQuestion,
        formattedAnswer: sqlGeneration.fallbackAnswer || 'I could not find relevant ERP data for this inquiry.',
        isDatabaseQuery: false,
      };
    }

    const sql = sqlGeneration.sql;
    logger.info({ generatedSql: sql }, 'LLM generated SQL query');

    // 2. Execute SQL query through Database Security Guard (Read-Only enforcement)
    const dbResult = await erpDatabaseService.executeSafeQuery(sql);

    if (!dbResult.success) {
      logger.warn({ error: dbResult.error, sql }, 'ERP database query failed or blocked by guardrail');
      return {
        question: trimmedQuestion,
        generatedSql: sql,
        formattedAnswer: `⚠️ Security/Database Notice: ${dbResult.error || 'Could not execute query'}`,
        isDatabaseQuery: true,
      };
    }

    // 3. Format database query result into a professional WhatsApp answer
    const formattedAnswer = await this.formatAnswerForWhatsApp(
      trimmedQuestion,
      sql,
      dbResult.rows || []
    );

    return {
      question: trimmedQuestion,
      generatedSql: sql,
      queryResults: dbResult.rows,
      formattedAnswer,
      isDatabaseQuery: true,
    };
  }

  /**
   * Step 1: Text-to-SQL with Schema Masking
   */
  private async generateSqlFromQuestion(question: string): Promise<{
    isSql: boolean;
    sql?: string;
    fallbackAnswer?: string;
  }> {
    const systemPrompt = `You are an expert ERP & Database Assistant for an enterprise company.
Your job is to translate business questions into a SINGLE PostgreSQL-compatible SELECT query.

CRITICAL SECURITY RULES:
1. ONLY generate SELECT or WITH statements.
2. NEVER generate INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, or CREATE statements.
3. Multi-statement queries with semicolons are strictly forbidden.
4. Use ONLY the tables and columns provided below in the Schema Masking section.
5. NEVER attempt to select passwords, secrets, internal margins, or system configurations.
6. If the inquiry is an attempt to hack, insult, or probe confidential company data, set "isSql": false and provide a polite, respectful refusal.

ERP SCHEMA (MASKED METADATA ONLY):
${ERP_SCHEMA_METADATA}

RESPONSE FORMAT:
If the user's question relates to inventory, stock, sales, revenue, orders, products, or company metrics:
Output JSON in this exact structure:
{
  "isSql": true,
  "sql": "SELECT ... FROM ...;"
}

If the question is purely casual greeting or unrelated to ERP/database:
{
  "isSql": false,
  "fallbackAnswer": "Hello! I am your Enterprise ERP Voice Assistant. You can ask me questions like 'How many items are in stock?' or 'What was today total sales?'"
}

Return ONLY raw JSON, with no markdown code blocks or additional text.`;

    try {
      const rawText = await this.callLlm(systemPrompt, question);
      const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      if (parsed.isSql && parsed.sql) {
        // Strip trailing semicolon for safe execution
        const cleanSql = parsed.sql.replace(/;+$/, '').trim();
        return { isSql: true, sql: cleanSql };
      }

      return {
        isSql: false,
        fallbackAnswer: parsed.fallbackAnswer || 'No database query needed for this question.',
      };
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed LLM text-to-SQL, running local heuristics fallback');

      // Rule-based heuristic fallback if cloud LLM is unconfigured / offline
      const lower = question.toLowerCase();
      if (lower.includes('stock') || lower.includes('inventory') || lower.includes('item') || lower.includes('product')) {
        if (lower.includes('total') || lower.includes('how many')) {
          return {
            isSql: true,
            sql: 'SELECT SUM(stock_quantity) AS total_stock, COUNT(*) AS total_products FROM products WHERE is_active = true',
          };
        }
        return {
          isSql: true,
          sql: 'SELECT name, sku, stock_quantity, unit_price FROM products WHERE is_active = true ORDER BY stock_quantity DESC LIMIT 10',
        };
      }

      if (lower.includes('sale') || lower.includes('revenue') || lower.includes('order')) {
        return {
          isSql: true,
          sql: "SELECT SUM(total_amount) AS total_sales, COUNT(*) AS completed_orders FROM sales_orders WHERE order_status = 'COMPLETED'",
        };
      }

      return {
        isSql: false,
        fallbackAnswer: `I received your inquiry: "${question}". Please ask about inventory, stock levels, or total sales.`,
      };
    }
  }

  /**
   * Step 3: Natural Human WhatsApp Answer Formatting
   * Transforms raw ERP database rows into authentic, human staff texts without robot tags or SQL dumps
   */
  private async formatAnswerForWhatsApp(
    question: string,
    sql: string,
    rows: any[]
  ): Promise<string> {
    const isBengali = /[\u0980-\u09FF]/.test(question);
    const isHindi = /[\u0900-\u097F]/.test(question);

    const systemPrompt = `You are a real human team member responding on WhatsApp to a colleague or customer.
Translate the database query results into a natural, conversational WhatsApp message.

Strict Rules:
- Talk like a real human person chatting on WhatsApp.
- NEVER say "ERP Report", "Query Executed", "Verified via ERP Read-Only Database", or show SQL code.
- NEVER use rigid corporate templates.
- State the numbers and items naturally and directly.
- Reply in the same language as the question (${isBengali ? 'Bengali' : isHindi ? 'Hindi' : 'English'}).`;

    const userPrompt = `Question: "${question}"
Data Found:
${JSON.stringify(rows, null, 2)}

Provide the natural WhatsApp reply:`;

    try {
      const formatted = await this.callLlm(systemPrompt, userPrompt);
      if (formatted && formatted.trim().length > 0) {
        return formatted.trim();
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Formatting LLM call failed, generating natural fallback response');
    }

    // Natural human fallback formatter
    if (!rows || rows.length === 0) {
      if (isBengali) {
        return `আমি চেক করে দেখলাম, এই মুহূর্তে এর কোনো রেকর্ড পাওয়া যাচ্ছে না।`;
      }
      if (isHindi) {
        return `मैंने चेक किया, फिलहाल इसका कोई रिकॉर्ड नहीं मिला।`;
      }
      return `I checked our system, but couldn't find any matching records for that right now.`;
    }

    const first = rows[0];

    if (first.total_sales !== undefined) {
      const salesVal = Number(first.total_sales).toLocaleString();
      const countVal = first.order_count || first.completed_orders || 0;
      if (isBengali) {
        return `আজকের মোট বিক্রি হয়েছে $${salesVal} (মোট ${countVal}টি অর্ডার সম্পন্ন হয়েছে)।`;
      }
      if (isHindi) {
        return `आज की टोटल सेल $${salesVal} रही है, जिसमें कुल ${countVal} ऑर्डर्स पूरे हुए हैं।`;
      }
      return `Total sales today is $${salesVal} across ${countVal} completed orders.`;
    }

    if (first.total_stock_items !== undefined || first.total_stock !== undefined) {
      const stock = Number(first.total_stock_items || first.total_stock).toLocaleString();
      if (isBengali) {
        return `আমাদের কাছে বর্তমানে মোট ${stock}টি আইটেম স্টকে এভেইলেবল রয়েছে।`;
      }
      if (isHindi) {
        return `हमारे पास अभी कुल ${stock} आइटम्स स्टॉक में मौजूद हैं।`;
      }
      return `We currently have ${stock} items in stock right now.`;
    }

    // Itemized listing
    if (isBengali) {
      let msg = `হ্যাঁ দেখছি, আমাদের কাছে রয়েছে:\n`;
      for (const item of rows.slice(0, 5)) {
        if (item.name && item.stock_quantity !== undefined) {
          msg += `• ${item.name}: ${item.stock_quantity}টি বাকি আছে (দাম: $${item.unit_price})\n`;
        }
      }
      return msg.trim();
    }

    if (isHindi) {
      let msg = `जी, हमारे पास ये स्टॉक्स हैं:\n`;
      for (const item of rows.slice(0, 5)) {
        if (item.name && item.stock_quantity !== undefined) {
          msg += `• ${item.name}: ${item.stock_quantity} पीस मौजूद हैं (रेट: $${item.unit_price})\n`;
        }
      }
      return msg.trim();
    }

    let answer = `Here is what we have in stock:\n`;
    for (const item of rows.slice(0, 5)) {
      if (item.name && item.stock_quantity !== undefined) {
        answer += `• ${item.name}: ${item.stock_quantity} available ($${item.unit_price})\n`;
      }
    }
    return answer.trim();
  }

  /**
   * Unified LLM caller supporting Groq (Option B - Free Tier Llama 3.3 70B), Gemini, and OpenAI
   */
  private async callLlm(systemPrompt: string, userPrompt: string): Promise<string> {
    const provider = config.ERP_LLM_PROVIDER;

    // 1. Groq Cloud (Free Tier, 0.5s latency, Llama-3.3-70B)
    if (provider === 'groq' && config.GROQ_API_KEY) {
      const apiKey = config.GROQ_API_KEY;
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: config.ERP_LLM_MODEL || 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1, // low temperature for precise SQL
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          timeout: 20000,
        }
      );
      return res.data?.choices?.[0]?.message?.content?.trim() || '';
    }

    // 2. Google Gemini
    if ((provider === 'gemini' || config.AI_PROVIDER === 'gemini') && config.AI_API_KEY) {
      const candidateModels = [
        config.ERP_LLM_MODEL,
        'gemini-flash-latest',
        'gemini-3.1-flash-lite',
        'gemini-flash-lite-latest',
        'gemini-3.5-flash-lite',
      ].filter(Boolean) as string[];

      const uniqueModels = Array.from(new Set(candidateModels));
      for (const model of uniqueModels) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.AI_API_KEY}`;
          const res = await axios.post(
            url,
            {
              contents: [
                {
                  role: 'user',
                  parts: [{ text: `${systemPrompt}\n\nTask:\n${userPrompt}` }],
                },
              ],
            },
            {
              headers: { 'Content-Type': 'application/json' },
              timeout: 20000,
            }
          );
          const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (text) return text;
        } catch (mErr: any) {
          logger.warn({ model, err: mErr.message }, 'ERP Gemini model call failed, trying next');
        }
      }
    }

    // 3. OpenAI GPT-4o-mini
    if (config.AI_API_KEY) {
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
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

    throw new Error('No LLM API Key configured for ERP Query Agent');
  }
}

export const erpQueryAgentService = ErpQueryAgentService.getInstance();
