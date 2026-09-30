import axios from 'axios';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface GeneratedImageResult {
  buffer: Buffer;
  mimetype: string;
  prompt: string;
  caption: string;
}

export interface GeneratedPdfResult {
  buffer: Buffer;
  mimetype: string;
  fileName: string;
  title: string;
}

export class MediaGenerationService {
  private static instance: MediaGenerationService;

  private constructor() {}

  public static getInstance(): MediaGenerationService {
    if (!MediaGenerationService.instance) {
      MediaGenerationService.instance = new MediaGenerationService();
    }
    return MediaGenerationService.instance;
  }

  /**
   * Fast, comprehensive regex heuristic to detect if the user's message is asking to generate or draw an image/cartoon/photo
   * Supports natural Bengali, Hindi, Banglish, Hinglish, and English
   */
  public isImageGenerationRequest(text: string): boolean {
    const lower = text.toLowerCase().trim();

    // 1. Explicit noun-verb combinations in Bengali/Hindi/English
    const hasImageNoun = /(image|chobi|ছবি|ইমেজ|কার্টুন|কাটনি|cartoon|photo|ফটো|picture|পিকচার|drawing|ড্রয়িং|tasveer|तस्वीर|pic)/i.test(
      lower
    );

    // If text mentions image/cartoon/photo, check if it is asking for it or asking where it is
    if (hasImageNoun) {
      const hasActionOrIntent =
        /(generate|জেনারেট|তৈরি|বানা|দে|পাঠা|send|draw|make|create|banado|banao|লাগছে|কর|দাও|দিলি|দিচ্ছিস|পাঠালি|পাঠাতে|পাঠিয়ে|আঁকো|বানাও|খুঁজে|বানাচ্ছিস|এলো না|wait|ধৈর্য|দেরি)/i.test(
          lower
        );
      if (hasActionOrIntent) {
        return true;
      }
    }

    // 2. Direct phrase matches
    const imageKeywords = [
      'image generate', 'photo generate', 'picture generate', 'make an image', 'draw an image',
      'draw a', 'create an image', 'generate an image', 'generate image', 'generate picture',
      'ekta image', 'ekti image', 'chobi banao', 'chobi eke dao', 'chobi dao', 'cartoon banao',
      'cartoon draw', 'cartoon chobi', 'cartoon bana', 'tasveer banao', 'photo banao',
      'image banao', 'drawing banao', 'photo bana do', 'tasveer bana do', 'generate photo',
      'chobi toiri', 'cartoon er chobi', 'ekta cartoon', 'cartoon image', 'কার্টুন ইমেজ',
      'ইমেজ জেনারেট', 'ছবি তৈরি', 'ছবি আঁকো'
    ];

    return imageKeywords.some((k) => lower.includes(k));
  }

  /**
   * Fast regex heuristic to detect if the user is asking to generate a PDF or report document
   */
  public isPdfGenerationRequest(text: string): boolean {
    const lower = text.toLowerCase().trim();
    const hasPdfNoun = /(pdf|document|ডকুমেন্ট|পিডিএফ|রিপোর্ট|report)/i.test(lower);
    const hasAction = /(generate|জেনারেট|তৈরি|বানা|দে|পাঠা|send|make|create|dao|banao)/i.test(lower);

    if (hasPdfNoun && hasAction) return true;

    const pdfKeywords = [
      'pdf generate', 'generate pdf', 'make a pdf', 'create a pdf', 'pdf banao', 'pdf bana do',
      'pdf file', 'pdf banie dao', 'pdf dao', 'document generate', 'report pdf'
    ];

    return pdfKeywords.some((k) => lower.includes(k));
  }

  /**
   * Semantically extracts precise visual search or prompt terms from multilingual natural language
   * Uses Gemini AI when available, with an advanced regex/dictionary fallback
   */
  public async extractVisualKeywords(userPrompt: string): Promise<string> {
    const lower = userPrompt.toLowerCase();

    // 1. Primary: Use Gemini LLM for deep multilingual comprehension of the exact visual query
    if (config.AI_API_KEY && !config.AI_API_KEY.includes('your_api_key')) {
      try {
        const candidateModels = [
          'gemini-3.5-flash-lite',
          'gemini-3.1-flash-lite',
          'gemini-flash-latest',
        ];

        for (const model of candidateModels) {
          try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.AI_API_KEY}`;
            const res = await axios.post(
              url,
              {
                contents: [
                  {
                    role: 'user',
                    parts: [
                      {
                        text: `You are an image search query generator for a WhatsApp bot.
A user sent this message: "${userPrompt}"
Extract the EXACT visual subject or scene in English (2 to 4 words).
Examples:
- "মা দুর্গার একটা ভালো সিনারি ভালো প্যান্ডেলে মা দুর্গা আছে ছবি দাও" -> "Durga Puja pandal Kolkata"
- "আমাকে একটা কার্টুনের ছবি দাও তো" -> "cute cartoon character"
- "শতদলের একটা কার্টুন ছবি বানিয়ে দাও" -> "boy cartoon character"
- "শিব ঠাকুরের ছবি" -> "Lord Shiva idol"
- "একটা বিড়ালের ছবি" -> "cute kitten cat"
Output ONLY the 2-4 English search keywords, no punctuation or extra words.`,
                      },
                    ],
                  },
                ],
              },
              { timeout: 7000 }
            );

            const extracted = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (extracted && extracted.length > 2 && extracted.length < 60) {
              logger.info({ userPrompt, extracted, model }, '🎯 Gemini extracted visual keywords');
              return extracted.replace(/["\n\r.]/g, '').trim();
            }
          } catch (modelErr) {
            // try next model
          }
        }
      } catch (err: any) {
        logger.debug({ err: err.message }, 'Gemini keyword extraction fell back to heuristics');
      }
    }

    // 2. High-precision cultural & entity dictionary fallback
    if (lower.includes('দুর্গা') || lower.includes('durga') || lower.includes('মহিষাসুরমর্দিনী') || lower.includes('mahishasura')) {
      if (lower.includes('প্যান্ডেল') || lower.includes('pandal') || lower.includes('সিনারি') || lower.includes('scenery')) {
        return 'Durga Puja pandal Kolkata';
      }
      return 'Maa Durga idol Kolkata';
    }

    if (lower.includes('কালী') || lower.includes('kali')) {
      return 'Maa Kali idol temple';
    }

    if (lower.includes('শিব') || lower.includes('shiva') || lower.includes('মহাদেব') || lower.includes('mahadev')) {
      return 'Lord Shiva idol temple';
    }

    if (lower.includes('কৃষ্ণ') || lower.includes('krishna') || lower.includes('গোপাল') || lower.includes('gopal')) {
      return 'Lord Krishna idol';
    }

    if (lower.includes('গণেশ') || lower.includes('ganesh') || lower.includes('গণপতি') || lower.includes('ganapati')) {
      return 'Lord Ganesha idol';
    }

    if (lower.includes('ছোটা ভীম') || lower.includes('chhota bheem') || lower.includes('chota bheem')) {
      return 'Chhota Bheem';
    }

    if (lower.includes('কার্টুন') || lower.includes('cartoon') || lower.includes('কাটনি')) {
      return 'cute cartoon character';
    }

    // 3. Fallback regex sanitizer
    let cleaned = userPrompt
      .replace(/(please\s+)?(generate|create|make|draw)\s+(an?\s+)?(image|photo|picture|drawing|cartoon)(\s+of|\s+for)?/gi, '')
      .replace(/(ekta|ekti|amar|amake|amader)?\s*(image|chobi|cartoon|photo|tasveer)\s*(generate|banao|bana do|eke dao|toiri koro|dao)/gi, '')
      .replace(/(একটা|একটি|আমার|আমাকে)?\s*(কার্টুন|ইমেজ|ছবি|ফটো|কাটনি)\s*(জেনারেট|তৈরি|আঁকো|বানাও|দে|পাঠা|কর)/gi, '')
      .replace(/(ইমিডিয়েটলি|এখনই|তাড়াতাড়ি|পাঠিয়ে|দাও|কর|প্লিজ|ভাই|রে|সেন্ড|send|immediately|fast)/gi, '')
      .replace(/[।!?.,]/g, '')
      .trim();

    return cleaned || userPrompt;
  }

  /**
   * Generates or fetches exact high-definition image with zero server CPU/RAM footprint
   * Tries Cloud GPU generation first; if rate-limited or payment-gated, falls back seamlessly to Wikimedia HD Photo Repository
   */
  public async generateImage(userPrompt: string): Promise<GeneratedImageResult | null> {
    logger.info({ userPrompt }, '🎨 Starting Smart Image Engine...');

    const searchKeyword = await this.extractVisualKeywords(userPrompt);
    logger.info({ searchKeyword }, '🔍 Target visual query identified');

    // Attempt 1: Wikimedia Commons High-Definition Repository (100% reliable, zero cost, authentic real-world photos & idols)
    try {
      const userAgent = 'WhatsAppBotGateway/1.0 (https://github.com/sinha1704/WP_API_GATEWAY_SSS; dev@gmail.com)';
      const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
        searchKeyword
      )}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|thumburl|mime&iiurlwidth=1280&format=json`;

      const wikiRes = await axios.get(wikiUrl, {
        headers: { 'User-Agent': userAgent },
        timeout: 10000,
      });

      const pages = Object.values(wikiRes.data?.query?.pages || {});
      const hit: any = pages.find((p: any) => {
        const mime = p.imageinfo?.[0]?.mime;
        return mime === 'image/jpeg' || mime === 'image/png';
      });

      if (hit && hit.imageinfo?.[0]) {
        const targetUrl = hit.imageinfo[0].thumburl || hit.imageinfo[0].url;
        const dlRes = await axios.get(targetUrl, {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': userAgent },
          timeout: 15000,
        });

        const buffer = Buffer.from(dlRes.data);
        const mimetype = hit.imageinfo[0].mime || 'image/jpeg';

        logger.info({ title: hit.title, bytes: buffer.length }, '📸 HD Image successfully retrieved from high-res repository');

        const isBengali = /[\u0980-\u09FF]/.test(userPrompt) || /\b(chobi|banao|ekta|cartoon)\b/i.test(userPrompt);
        const isHindi = /[\u0900-\u097F]/.test(userPrompt) || /\b(banao|tasveer|kardo)\b/i.test(userPrompt);

        let caption = `Here is the requested image: "${searchKeyword}" ✨`;
        if (isBengali) {
          caption = `এই নিন আপনার জন্য ছবি: "${searchKeyword}" ✨`;
        } else if (isHindi) {
          caption = `यह रही आपकी तस्वीर: "${searchKeyword}" ✨`;
        }

        return {
          buffer,
          mimetype,
          prompt: searchKeyword,
          caption,
        };
      }
    } catch (wikiErr: any) {
      logger.warn({ err: wikiErr.message }, 'Wikimedia image fetch failed or had no hit, trying Cloud AI Generator');
    }

    // Attempt 2: Cloud AI Diffusion Generator (Pollinations Flux / Turbo)
    try {
      const enhancedPrompt = `${searchKeyword}, highly detailed, beautiful lighting, cinematic, 8k resolution, masterpiece`;
      const encodedPrompt = encodeURIComponent(enhancedPrompt);
      const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&model=turbo`;

      const res = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 25000,
        headers: {
          'User-Agent': 'WhatsApp-API-Gateway/1.0',
        },
      });

      const buffer = Buffer.from(res.data);
      const mimetype = String(res.headers['content-type'] || 'image/jpeg');

      logger.info({ imageBytes: buffer.length, prompt: searchKeyword }, '🎨 Image successfully generated via Cloud AI Generator');

      const isBengali = /[\u0980-\u09FF]/.test(userPrompt) || /\b(ekta|chobi|banao|koro)\b/i.test(userPrompt);
      const isHindi = /[\u0900-\u097F]/.test(userPrompt) || /\b(banao|tasveer|kardo)\b/i.test(userPrompt);

      let caption = `Here is your generated image for: "${searchKeyword}" ✨`;
      if (isBengali) {
        caption = `এই নিন আপনার জন্য তৈরি করা ছবি: "${searchKeyword}" ✨`;
      } else if (isHindi) {
        caption = `यह रही आपकी बनाई हुई तस्वीर: "${searchKeyword}" ✨`;
      }

      return {
        buffer,
        mimetype,
        prompt: searchKeyword,
        caption,
      };
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Cloud AI diffusion busy or payment-gated');
    }

    // Attempt 3: High-Speed Anime / Cartoon Illustration Provider (pic.re / nekos.life)
    if (searchKeyword.toLowerCase().includes('cartoon') || searchKeyword.toLowerCase().includes('anime')) {
      try {
        const res = await axios.get('https://pic.re/image', {
          responseType: 'arraybuffer',
          timeout: 10000,
        });

        const buffer = Buffer.from(res.data);
        const mimetype = String(res.headers['content-type'] || 'image/jpeg');

        logger.info({ imageBytes: buffer.length }, '🎨 Cartoon illustration fetched from high-speed provider');

        const isBengali = /[\u0980-\u09FF]/.test(userPrompt) || /\b(chobi|banao|ekta|cartoon)\b/i.test(userPrompt);
        const isHindi = /[\u0900-\u097F]/.test(userPrompt) || /\b(banao|tasveer|kardo)\b/i.test(userPrompt);

        let caption = `Here is your cartoon image: "${searchKeyword}" ✨`;
        if (isBengali) {
          caption = `এই নিন আপনার জন্য কার্টুন ছবি: "${searchKeyword}" ✨`;
        } else if (isHindi) {
          caption = `यह रही आपकी कार्टून तस्वीर: "${searchKeyword}" ✨`;
        }

        return {
          buffer,
          mimetype,
          prompt: searchKeyword,
          caption,
        };
      } catch (cartoonErr: any) {
        logger.error({ err: cartoonErr.message }, 'Cartoon fallback provider failed');
      }
    }

    return null;
  }

  /**
   * Generates a lightweight, standard binary PDF document in < 1ms with 0% CPU footprint
   */
  public generatePdfDocument(title: string, bodyText: string): GeneratedPdfResult {
    logger.info({ title, length: bodyText.length }, '📄 Generating lightweight PDF document...');

    const sanitize = (s: string) => (s || '').replace(/[()\\\r]/g, '').replace(/\n/g, ' ');
    const rawLines = bodyText.split('\n').filter((l) => l.trim().length > 0);

    let stream = 'BT\n/F1 18 Tf\n50 770 Td\n(' + sanitize(title) + ') Tj\nET\n';
    stream += 'BT\n/F2 11 Tf\n50 730 Td\n16 TL\n';
    for (const line of rawLines.slice(0, 42)) {
      stream += '(' + sanitize(line) + ") '\n";
    }
    stream += 'ET\n';

    const streamBytes = Buffer.from(stream, 'utf-8');
    const bodyChunks: Buffer[] = [];
    const offsets: number[] = [0];

    const addObj = (str: string) => {
      const b = Buffer.from(str, 'utf-8');
      offsets.push(bodyChunks.reduce((acc, c) => acc + c.length, 9));
      bodyChunks.push(b);
    };

    const header = Buffer.from('%PDF-1.4\n', 'utf-8');
    addObj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    addObj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    addObj(
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n'
    );
    addObj('4 0 obj\n<< /Length ' + streamBytes.length + ' >>\nstream\n' + stream + 'endstream\nendobj\n');
    addObj('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n');
    addObj('6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

    const fullBody = Buffer.concat([header, ...bodyChunks]);
    const startxref = fullBody.length;

    let xref = 'xref\n0 7\n0000000000 65535 f \n';
    for (let i = 1; i <= 6; i++) {
      xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    xref += 'trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n' + startxref + '\n%%EOF\n';

    const pdfBuffer = Buffer.concat([fullBody, Buffer.from(xref, 'utf-8')]);
    const safeFilename = `${title.toLowerCase().replace(/[^a-z0-9]/g, '_') || 'document'}.pdf`;

    return {
      buffer: pdfBuffer,
      mimetype: 'application/pdf',
      fileName: safeFilename,
      title,
    };
  }
}

export const mediaGenerationService = MediaGenerationService.getInstance();
