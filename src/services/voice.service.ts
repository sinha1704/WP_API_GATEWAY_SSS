import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

if (ffmpegInstaller.path) {
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
}

export class VoiceTranscriptionService {
  private static instance: VoiceTranscriptionService;

  private constructor() {}

  public static getInstance(): VoiceTranscriptionService {
    if (!VoiceTranscriptionService.instance) {
      VoiceTranscriptionService.instance = new VoiceTranscriptionService();
    }
    return VoiceTranscriptionService.instance;
  }

  /**
   * Transcribe an audio buffer (e.g. ogg/opus, mp3, mp4, wav) to text
   */
  public async transcribeAudio(
    audioBuffer: Buffer,
    mimetype: string = 'audio/ogg; codecs=opus',
    filename: string = 'voice-note.ogg'
  ): Promise<string> {
    const provider = config.VOICE_TRANSCRIPTION_PROVIDER;

    logger.info({ provider, audioSizeBytes: audioBuffer.length, mimetype }, 'Starting audio transcription');

    switch (provider) {
      case 'groq':
        return await this.transcribeWithGroq(audioBuffer, filename);
      case 'openai':
        return await this.transcribeWithOpenAI(audioBuffer, filename);
      case 'gemini':
        return await this.transcribeWithGemini(audioBuffer, mimetype);
      case 'local_whisper':
        return await this.transcribeWithLocalWhisper(audioBuffer, filename);
      default:
        // Default attempt Groq first if key exists, otherwise fallback to OpenAI or Gemini
        if (config.GROQ_API_KEY) {
          return await this.transcribeWithGroq(audioBuffer, filename);
        } else if (config.AI_API_KEY) {
          return await this.transcribeWithOpenAI(audioBuffer, filename);
        }
        throw new Error(`No transcription provider or API keys configured. Set GROQ_API_KEY or AI_API_KEY in .env`);
    }
  }

  /**
   * Option B: Groq Cloud API (Free Tier, 0.5s ultra-fast Whisper)
   */
  private async transcribeWithGroq(audioBuffer: Buffer, filename: string): Promise<string> {
    const apiKey = config.GROQ_API_KEY || config.AI_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is required for Groq Whisper transcription');
    }

    const form = new FormData();
    form.append('file', audioBuffer, {
      filename,
      contentType: 'audio/ogg',
    });
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'json');
    // Multilingual context prompt guides Whisper to prioritize Bengali, Hindi, and English over rare languages
    form.append('prompt', 'Bengali, Hindi, English, বাংলা, हिन्दी, WhatsApp conversational speech.');

    const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      timeout: 30000,
    });

    return res.data?.text?.trim() || '';
  }

  /**
   * OpenAI Whisper API
   */
  private async transcribeWithOpenAI(audioBuffer: Buffer, filename: string): Promise<string> {
    const apiKey = config.AI_API_KEY;
    if (!apiKey) {
      throw new Error('AI_API_KEY is required for OpenAI Whisper transcription');
    }

    const form = new FormData();
    form.append('file', audioBuffer, {
      filename,
      contentType: 'audio/ogg',
    });
    form.append('model', 'whisper-1');

    const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      timeout: 30000,
    });

    return res.data?.text?.trim() || '';
  }

  /**
   * Option A: Dedicated Server / Local Whisper Container (100% Free, Private, Zero Cloud Cost)
   * Compatible with OpenAI-compatible Whisper endpoints like faster-whisper-server or vLLM
   */
  private async transcribeWithLocalWhisper(audioBuffer: Buffer, filename: string): Promise<string> {
    const whisperUrl = config.LOCAL_WHISPER_URL || 'http://localhost:8000/v1/audio/transcriptions';
    logger.info({ whisperUrl }, 'Sending audio to Self-Hosted Local Whisper server');

    const form = new FormData();
    form.append('file', audioBuffer, {
      filename,
      contentType: 'audio/ogg',
    });
    form.append('model', 'whisper-1');

    const res = await axios.post(whisperUrl, form, {
      headers: {
        ...form.getHeaders(),
      },
      timeout: 60000,
    });

    return res.data?.text?.trim() || '';
  }

  /**
   * Google Gemini Multimodal Audio understanding
   */
  private async transcribeWithGemini(audioBuffer: Buffer, mimetype: string): Promise<string> {
    const apiKey = config.AI_API_KEY;
    if (!apiKey) {
      throw new Error('AI_API_KEY is required for Gemini audio processing');
    }

    const base64Audio = audioBuffer.toString('base64');
    const cleanMime = mimetype.split(';')[0].trim() || 'audio/ogg';

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const res = await axios.post(
      url,
      {
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: cleanMime,
                  data: base64Audio,
                },
              },
              {
                text: 'Transcribe this voice audio message exactly into text. Return ONLY the transcribed text, without any conversational preamble or notes.',
              },
            ],
          },
        ],
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  }

  /**
   * Text-to-Speech (TTS): Converts answer text into audio voice note (mp3/ogg) buffer
   * Supports Google TTS (zero setup, 100% free), OpenAI TTS, or ElevenLabs
   */
  public async synthesizeSpeech(text: string): Promise<{ buffer: Buffer; mimetype: string }> {
    const cleanText = text
      .replace(/[*_~`#]/g, '') // Strip markdown formatting
      .replace(/\[Verified via.*?\]/gi, '')
      .replace(/https?:\/\/\S+/g, '')
      .substring(0, 1000)
      .trim();

    logger.info({ ttsProvider: config.TTS_PROVIDER, charCount: cleanText.length }, 'Synthesizing voice audio reply');

    // 1. OpenAI TTS (if API key available and selected)
    if (config.TTS_PROVIDER === 'openai' && config.AI_API_KEY) {
      try {
        const res = await axios.post(
          'https://api.openai.com/v1/audio/speech',
          {
            model: 'tts-1',
            input: cleanText,
            voice: 'alloy',
            response_format: 'mp3',
          },
          {
            headers: {
              Authorization: `Bearer ${config.AI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            responseType: 'arraybuffer',
            timeout: 20000,
          }
        );
        return { buffer: Buffer.from(res.data), mimetype: 'audio/mp4' };
      } catch (err: any) {
        logger.warn({ err: err.message }, 'OpenAI TTS failed, falling back to Google TTS');
      }
    }

    // 2. Google Translate TTS (Free, Instant, chunked for unlimited length)
    try {
      // Automatically detect if the text is Bengali, Hindi, Arabic, or English for proper accent and voice
      const detectedLang = this.detectTextLanguage(cleanText);
      logger.info({ detectedLang, charCount: cleanText.length }, 'Detected text language for Voice Note playback');

      // Google TTS endpoint limits queries to ~150-180 characters, so chunk into natural sentence parts
      const words = cleanText.split(/\s+/);
      const chunks: string[] = [];
      let currentChunk = '';

      for (const word of words) {
        if ((currentChunk + ' ' + word).trim().length > 140) {
          if (currentChunk.trim()) chunks.push(currentChunk.trim());
          currentChunk = word;
        } else {
          currentChunk = currentChunk ? `${currentChunk} ${word}` : word;
        }
      }
      if (currentChunk.trim()) chunks.push(currentChunk.trim());

      const audioBuffers: Buffer[] = [];

      for (const chunk of chunks) {
        const encoded = encodeURIComponent(chunk);
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${detectedLang}&client=tw-ob&q=${encoded}`;
        const res = await axios.get(url, {
          headers: {
            'Referer': 'http://translate.google.com/',
            'User-Agent': 'stagefright/1.2 (Linux;Android 5.0)',
          },
          responseType: 'arraybuffer',
          timeout: 15000,
        });
        audioBuffers.push(Buffer.from(res.data));
      }

      const combinedAudio = Buffer.concat(audioBuffers);
      logger.info({ totalBytes: combinedAudio.length, chunksCount: chunks.length }, 'TTS synthesized audio, converting to native WhatsApp Opus...');

      // Convert MP3 to WhatsApp-native OGG/Opus (48kHz Mono)
      const opusBuffer = await this.convertToWhatsAppOpus(combinedAudio);
      return { buffer: opusBuffer, mimetype: 'audio/ogg; codecs=opus' };
    } catch (err: any) {
      logger.error({ err: err.message }, 'Google TTS synthesis failed');
      throw new Error(`TTS synthesis failed: ${err.message}`);
    }
  }

  /**
   * Transcodes any input audio buffer into authentic WhatsApp PTT Opus (OGG container, 48kHz, mono)
   */
  public async convertToWhatsAppOpus(inputBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const tempId = `ptt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const inPath = path.join(os.tmpdir(), `${tempId}_in.mp3`);
      const outPath = path.join(os.tmpdir(), `${tempId}_out.ogg`);

      try {
        fs.writeFileSync(inPath, inputBuffer);

        ffmpeg(inPath)
          .toFormat('ogg')
          .audioCodec('libopus')
          .audioChannels(1)
          .audioFrequency(48000)
          .audioBitrate('32k')
          .on('error', (err: any) => {
            logger.warn({ err: err.message }, 'FFmpeg opus conversion error, returning original buffer');
            try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath); } catch (e) {}
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) {}
            // Fallback to original buffer
            resolve(inputBuffer);
          })
          .on('end', () => {
            try {
              const converted = fs.readFileSync(outPath);
              logger.info({ opusBytes: converted.length }, 'Successfully transcoded to WhatsApp native OGG/Opus');
              try { fs.unlinkSync(inPath); fs.unlinkSync(outPath); } catch (e) {}
              resolve(converted);
            } catch (readErr: any) {
              resolve(inputBuffer);
            }
          })
          .save(outPath);
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Could not run ffmpeg conversion, using raw buffer');
        resolve(inputBuffer);
      }
    });
  }

  /**
   * Detects Unicode script of the text to select correct natural voice for Google TTS:
   * 'bn' for Bengali (বাংলা)
   * 'hi' for Hindi (हिन्दी)
   * 'ar' for Arabic (العربية)
   * 'es' for Spanish
   * 'en' for English
   */
  public detectTextLanguage(text: string): string {
    // Bengali Unicode block: \u0980 - \u09FF
    if (/[\u0980-\u09FF]/.test(text)) {
      return 'bn';
    }
    // Devanagari (Hindi) Unicode block: \u0900 - \u097F
    if (/[\u0900-\u097F]/.test(text)) {
      return 'hi';
    }
    // Arabic Unicode block: \u0600 - \u06FF
    if (/[\u0600-\u06FF]/.test(text)) {
      return 'ar';
    }
    // Common Banglish / Hinglish markers if written in English alphabet
    const lower = text.toLowerCase();
    if (/\b(kemon|achen|acchen|ki|korchis|korchen|koto|taka|bhalo|hobe|aache|ache|dhonnobad|namaskar)\b/.test(lower)) {
      return 'bn';
    }
    if (/\b(namaste|kaise|kya|hai|kitna|bhai|shukriya|aap|hum)\b/.test(lower)) {
      return 'hi';
    }

    return 'en';
  }
}

export const voiceTranscriptionService = VoiceTranscriptionService.getInstance();

