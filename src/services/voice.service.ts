import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { Readable } from 'stream';
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

    // 1. If configured provider is explicitly requested and has credentials, try it first
    if (provider === 'gemini' || config.AI_PROVIDER === 'gemini') {
      try {
        const text = await this.transcribeWithGemini(audioBuffer, mimetype);
        if (text && text.trim()) return text.trim();
      } catch (geminiErr: any) {
        logger.warn({ err: geminiErr.message }, 'Gemini transcription attempt failed, checking fallback');
      }
    }

    if (config.GROQ_API_KEY) {
      try {
        const text = await this.transcribeWithGroq(audioBuffer, filename);
        if (text && text.trim()) return text.trim();
      } catch (groqErr: any) {
        logger.warn({ err: groqErr.message }, 'Groq transcription failed, trying next provider');
      }
    }

    // 2. Fallback to Gemini if AI_API_KEY is configured
    if (config.AI_API_KEY && config.AI_PROVIDER === 'gemini') {
      try {
        const text = await this.transcribeWithGemini(audioBuffer, mimetype);
        if (text && text.trim()) return text.trim();
      } catch (gErr: any) {
        logger.warn({ err: gErr.message }, 'Gemini transcription fallback failed');
      }
    }

    // 3. Fallback to OpenAI if configured
    if (config.AI_PROVIDER === 'openai' && config.AI_API_KEY) {
      try {
        const text = await this.transcribeWithOpenAI(audioBuffer, filename);
        if (text && text.trim()) return text.trim();
      } catch (openAiErr: any) {
        logger.warn({ err: openAiErr.message }, 'OpenAI transcription fallback failed');
      }
    }

    // 4. Fallback to local whisper container if configured
    if (config.LOCAL_WHISPER_URL) {
      try {
        const text = await this.transcribeWithLocalWhisper(audioBuffer, filename);
        if (text && text.trim()) return text.trim();
      } catch (whisperErr: any) {
        logger.warn({ err: whisperErr.message }, 'Local Whisper transcription failed');
      }
    }

    throw new Error('All configured speech-to-text providers failed or returned empty transcription.');
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
   * Converts any incoming voice audio (OGG/Opus, WAV, etc.) to clean MP3 for cloud transcription engines
   */
  public async convertToMp3(inputBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve) => {
      const tempId = `trans_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const inPath = path.join(os.tmpdir(), `${tempId}_in.ogg`);
      const outPath = path.join(os.tmpdir(), `${tempId}_out.mp3`);

      try {
        fs.writeFileSync(inPath, inputBuffer);
        ffmpeg(inPath)
          .toFormat('mp3')
          .audioChannels(1)
          .audioFrequency(16000)
          .on('end', () => {
            try {
              const converted = fs.readFileSync(outPath);
              try { fs.unlinkSync(inPath); fs.unlinkSync(outPath); } catch (e) {}
              resolve(converted);
            } catch (readErr) {
              resolve(inputBuffer);
            }
          })
          .on('error', (err) => {
            logger.warn({ err: err.message }, 'FFmpeg MP3 transcode warning, using raw audio buffer');
            try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath); } catch (e) {}
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) {}
            resolve(inputBuffer);
          })
          .save(outPath);
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Failed to start MP3 conversion, using raw audio buffer');
        resolve(inputBuffer);
      }
    });
  }

  /**
   * Google Gemini Multimodal Audio understanding
   * Transcribes Bengali (বাংলা), Hindi (हिन्दी), Banglish, Hinglish, and English with highest accuracy
   */
  private async transcribeWithGemini(audioBuffer: Buffer, mimetype: string): Promise<string> {
    const apiKey = config.AI_API_KEY;
    if (!apiKey) {
      throw new Error('AI_API_KEY is required for Gemini audio processing');
    }

    // Convert to clean standard MP3 for maximum Gemini audio parser compatibility
    const mp3Buffer = await this.convertToMp3(audioBuffer);
    const base64Audio = mp3Buffer.toString('base64');
    const audioMime = 'audio/mp3';

    // Prioritize high-availability multimodal Gemini models
    const candidateModels = [
      'gemini-3.1-flash-lite',
      'gemini-flash-lite-latest',
      'gemini-3.5-flash-lite',
      'gemini-flash-latest',
    ];

    for (const model of candidateModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await axios.post(
          url,
          {
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      mimeType: audioMime,
                      data: base64Audio,
                    },
                  },
                  {
                    text: 'Listen to this voice message very carefully. It is spoken in Bengali (বাংলা), Hindi (हिन्दी), Banglish, or English. Transcribe the spoken words EXACTLY in the same native language and script as spoken. Return ONLY the transcribed text without any other words, prefixes, or explanations.',
                  },
                ],
              },
            ],
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 25000,
          }
        );

        const result = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (result && result.length > 0) {
          logger.info({ model, transcribedChars: result.length }, 'Gemini successfully transcribed voice note');
          return result;
        }
      } catch (modelErr: any) {
        logger.warn(
          { model, status: modelErr.response?.status, err: modelErr.response?.data?.error?.message || modelErr.message },
          'Gemini audio model attempt failed, trying fallback model'
        );
      }
    }

    return '';
  }

  /**
   * Text-to-Speech (TTS): Converts answer text into audio voice note (mp3/ogg) buffer
   * Supports Google TTS (zero setup, 100% free), OpenAI TTS, or ElevenLabs
   */
  public async synthesizeSpeech(text: string): Promise<{ buffer: Buffer; mimetype: string }> {
    const cleanText = text
      .replace(/[*_~`#]/g, '') // Strip markdown formatting
      .replace(/^\s*[-•–—]\s*/gm, '') // Strip bullet dashes so speech is smooth
      .replace(/[-–—]\s+/g, ' ') // Strip dashes between items
      .replace(/\[Verified via.*?\]/gi, '')
      .replace(/https?:\/\/\S+/g, '')
      .substring(0, 1000)
      .trim();

    logger.info({ ttsProvider: config.TTS_PROVIDER, charCount: cleanText.length }, 'Synthesizing voice audio reply');

    // 1. Natural Neural Human Male Voice Engine (Free, Ultra-realistic, 0% robotic)
    // Voices: Bengali Male (bn-IN-BashkarNeural), Hindi Male (hi-IN-MadhurNeural), English Male (en-US-ChristopherNeural)
    if (config.TTS_PROVIDER === 'edge' || config.TTS_PROVIDER === 'msedge' || !config.TTS_PROVIDER) {
      try {
        const detectedLang = this.detectTextLanguage(cleanText);
        let selectedVoice = 'en-US-ChristopherNeural'; // Warm, professional natural male human voice
        if (detectedLang === 'bn') {
          selectedVoice = 'bn-IN-BashkarNeural'; // Natural Bengali Male
        } else if (detectedLang === 'hi') {
          selectedVoice = 'hi-IN-MadhurNeural'; // Natural Hindi Male
        } else if (detectedLang === 'ar') {
          selectedVoice = 'ar-SA-HamedNeural'; // Natural Arabic Male
      }

      // Transform raw text into human spoken cadence: micro-breaths, pauses, natural filler pacing
      const conversationalSpeechText = this.humanizeSpeechCadence(cleanText, detectedLang);

      logger.info(
        { voice: selectedVoice, lang: detectedLang, originalLen: cleanText.length, spokenLen: conversationalSpeechText.length },
        '🎙️ Synthesizing ultra-natural human male voice with authentic breathing rhythm'
      );

      const tts = new MsEdgeTTS();
      await tts.setMetadata(selectedVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(conversationalSpeechText);

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
        audioStream.on('end', () => resolve());
        audioStream.on('error', (err) => reject(err));
      });

      const rawAudio = Buffer.concat(chunks);
      if (rawAudio.length > 0) {
        logger.info({ mp3Bytes: rawAudio.length }, 'Neural Human Voice successfully generated. Transcoding to WhatsApp Opus PTT...');
        const opusBuffer = await this.convertToWhatsAppOpus(rawAudio);
        return { buffer: opusBuffer, mimetype: 'audio/ogg; codecs=opus' };
      }
    } catch (neuralErr: any) {
      logger.warn({ err: neuralErr.message }, 'Neural Human Voice synthesis failed, falling back to Google/OpenAI TTS');
    }
  }

    // 2. OpenAI TTS (if API key available and selected)
    if (config.TTS_PROVIDER === 'openai' && config.AI_API_KEY) {
      try {
        const res = await axios.post(
          'https://api.openai.com/v1/audio/speech',
          {
            model: 'tts-1',
            input: cleanText,
            voice: 'onyx', // Deep, natural human male voice
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
        const opusBuffer = await this.convertToWhatsAppOpus(Buffer.from(res.data));
        return { buffer: opusBuffer, mimetype: 'audio/ogg; codecs=opus' };
      } catch (err: any) {
        logger.warn({ err: err.message }, 'OpenAI TTS failed, falling back to Google TTS');
      }
    }

    // 3. Google Translate TTS (Fallback)
    try {
      const detectedLang = this.detectTextLanguage(cleanText);
      logger.info({ detectedLang, charCount: cleanText.length }, 'Detected text language for Voice Note playback');

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
    if (
      /\b(kemon|achen|acchen|ki|korcho|korchis|korchen|koto|taka|bhalo|hobe|aache|ache|dhonnobad|namaskar|amar|khide|payeche|payechen|babu|khabar|kheyecho|tumi|apni|bhai|bolo|dekho|kichu|shuncho)\b/.test(
        lower
      )
    ) {
      return 'bn';
    }
    if (
      /\b(namaste|kaise|kya|hai|kitna|bhai|shukriya|aap|hum|khana|bhukh|lagi|karein|bolo|sun|dekho|kahan|theek)\b/.test(
        lower
      )
    ) {
      return 'hi';
    }

    return 'en';
  }

  /**
   * Human Speech Prosody & Breathing Engine:
   * Real humans breathe, pause between clauses, and shift inflection.
   * This transforms flat robot text into natural, live conversational delivery:
   * - Inserts micro-pauses (...) at thought boundaries
   * - Adds conversational breath transitions ("হ্যাঁ...", "আচ্ছা...", "Right...", "हाँ...")
   * - Eliminates all synthetic markers, robot symbols, and formal bullet structures
   */
  public humanizeSpeechCadence(text: string, lang: string): string {
    let spoken = text
      // Clean emojis, links, markdown bullets, and database symbols
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
      .replace(/[•\-\*\_~`#>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Natural clause breathing: turn harsh full stops and semicolons into smooth human micro-pauses
    spoken = spoken
      .replace(/([।!?])\s*/g, '$1 ... ')
      .replace(/([;:])\s*/g, ', ')
      .replace(/\s*\.\s*/g, ' ... ')
      .replace(/,\s*/g, ', ');

    // Normalize multiple pauses
    spoken = spoken.replace(/(\s*\.\.\.\s*)+/g, ' ... ');

    // If starting abruptly, inject subtle human conversational opening breathe if not already present
    if (lang === 'bn') {
      if (!/^(হ্যাঁ|আচ্ছা|নমস্কার|আসসালামু|হুম|দেখুন)/.test(spoken)) {
        spoken = `আচ্ছা ... ${spoken}`;
      }
    } else if (lang === 'hi') {
      if (!/^(हाँ|जी|नमस्ते|अच्छा|सुनिए|देखिए)/.test(spoken)) {
        spoken = `जी ... ${spoken}`;
      }
    } else if (lang === 'en') {
      if (!/^(yes|sure|right|well|hello|hey|hi)/i.test(spoken)) {
        spoken = `Right ... ${spoken}`;
      }
    }

    return spoken.trim();
  }
}

export const voiceTranscriptionService = VoiceTranscriptionService.getInstance();

