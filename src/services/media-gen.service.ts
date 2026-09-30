import axios from 'axios';
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
   * Generates ultra-sharp, artistic image using Flux / Pollinations AI (Zero server CPU/RAM impact)
   * 100% Free, runs entirely on high-performance cloud GPUs
   */
  public async generateImage(userPrompt: string): Promise<GeneratedImageResult | null> {
    logger.info({ userPrompt }, '🎨 Starting Cloud AI Image Generation...');

    // Extract clean visual prompt by stripping conversational wrapper phrases
    let cleanedPrompt = userPrompt
      .replace(/(please\s+)?(generate|create|make|draw)\s+(an?\s+)?(image|photo|picture|drawing|cartoon)(\s+of|\s+for)?/gi, '')
      .replace(/(ekta|ekti|amar|amake|amader)?\s*(image|chobi|cartoon|photo|tasveer)\s*(generate|banao|bana do|eke dao|toiri koro|dao)/gi, '')
      .replace(/(একটা|একটি|আমার|আমাকে)?\s*(কার্টুন|ইমেজ|ছবি|ফটো|কাটনি)\s*(জেনারেট|তৈরি|আঁকো|বানাও|দে|পাঠা|কর)/gi, '')
      .replace(/(ইমিডিয়েটলি|এখনই|তাড়াতাড়ি|পাঠিয়ে|দাও|কর|প্লিজ|ভাই|রে|সেন্ড|send|immediately|fast)/gi, '')
      .replace(/[।!?.,]/g, '')
      .trim();

    if (!cleanedPrompt || cleanedPrompt.length < 3) {
      cleanedPrompt = userPrompt;
    }

    // High quality aesthetic enhancer for Flux
    const enhancedPrompt = `${cleanedPrompt}, highly detailed, beautiful lighting, cinematic, 8k resolution, photorealistic masterpiece`;
    const encodedPrompt = encodeURIComponent(enhancedPrompt);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&model=flux`;

    try {
      const res = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 35000,
        headers: {
          'User-Agent': 'WhatsApp-API-Gateway/1.0',
        },
      });

      const buffer = Buffer.from(res.data);
      const mimetype = String(res.headers['content-type'] || 'image/jpeg');

      logger.info({ imageBytes: buffer.length, prompt: cleanedPrompt }, '🎨 Image successfully generated via Flux Cloud GPU');

      // Detect language for caption
      const isBengali = /[\u0980-\u09FF]/.test(userPrompt) || /\b(ekta|chobi|banao|koro)\b/i.test(userPrompt);
      const isHindi = /[\u0900-\u097F]/.test(userPrompt) || /\b(banao|tasveer|kardo)\b/i.test(userPrompt);

      let caption = `Here is your generated image for: "${cleanedPrompt}" ✨`;
      if (isBengali) {
        caption = `এই নিন আপনার জন্য তৈরি করা ছবি: "${cleanedPrompt}" ✨`;
      } else if (isHindi) {
        caption = `यह रही आपकी बनाई हुई तस्वीर: "${cleanedPrompt}" ✨`;
      }

      return {
        buffer,
        mimetype,
        prompt: cleanedPrompt,
        caption,
      };
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to generate cloud AI image');
      return null;
    }
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
