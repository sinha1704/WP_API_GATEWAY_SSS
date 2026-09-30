import path from 'path';
import fs from 'fs';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';
import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  proto,
  type WASocket,
  type ConnectionState,
  type AnyMessageContent,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { logger } from '../utils/logger.js';
import { config } from '../config/env.js';
import { webhookService } from './webhook.service.js';
import { aiBridgeService } from './ai.service.js';
import { throttledQueue } from './queue.service.js';

export type SessionStatus = 'INITIALIZING' | 'SCAN_QR_CODE' | 'CONNECTED' | 'DISCONNECTED';

export interface SessionInstance {
  id: string;
  socket: WASocket | null;
  status: SessionStatus;
  qrCodeRaw?: string;
  qrCodeDataUrl?: string;
  qrCodeSvg?: string;
  reconnectAttempts: number;
  webhookUrl?: string;
  webhookSecret?: string;
  aiEnabled?: boolean;
  aiPrompt?: string;
  user?: {
    id: string;
    name?: string;
  };
}

export class SessionManager {
  private static instance: SessionManager;
  private sessions: Map<string, SessionInstance> = new Map();
  private baseStorageDir: string;

  private constructor() {
    this.baseStorageDir = path.resolve(process.cwd(), config.SESSIONS_DIR);
    if (!existsSync(this.baseStorageDir)) {
      fsPromises.mkdir(this.baseStorageDir, { recursive: true }).catch((err) => {
        logger.error({ err }, 'Failed to create base sessions directory');
      });
    }
  }

  /**
   * Automatically restores and reconnects all existing saved sessions on server start
   */
  public async autoRestoreSessions(): Promise<void> {
    try {
      if (!existsSync(this.baseStorageDir)) return;
      const entries = await fsPromises.readdir(this.baseStorageDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const credsPath = path.join(this.baseStorageDir, entry.name, 'creds.json');
          if (existsSync(credsPath)) {
            logger.info(`Found saved credentials for session "${entry.name}". Auto-restoring connection...`);
            this.initSession(entry.name).catch((err) => {
              logger.error({ sessionId: entry.name, err: err.message }, 'Failed to auto-restore session');
            });
          }
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error scanning saved sessions for auto-restore');
    }
  }

  public static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * List all registered sessions and their operational status
   */
  public listSessions(): Array<{
    id: string;
    status: SessionStatus;
    user?: { id: string; name?: string };
    hasQrCode: boolean;
    queueLength: number;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      status: s.status,
      user: s.user,
      hasQrCode: Boolean(s.qrCodeRaw),
      queueLength: throttledQueue.getQueueLength(s.id),
    }));
  }

  /**
   * Get session instance by ID
   */
  public getSession(sessionId: string): SessionInstance | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Initializes and starts a multi-device WhatsApp session
   */
  public async initSession(
    sessionId: string,
    options?: {
      webhookUrl?: string;
      webhookSecret?: string;
      aiEnabled?: boolean;
      aiPrompt?: string;
    }
  ): Promise<SessionInstance> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status === 'CONNECTED' && existing.socket) {
      return existing;
    }

    const sessionDir = path.join(this.baseStorageDir, sessionId);
    if (!existsSync(sessionDir)) {
      await fsPromises.mkdir(sessionDir, { recursive: true });
    }

    const sessionInstance: SessionInstance = {
      id: sessionId,
      socket: null,
      status: 'INITIALIZING',
      reconnectAttempts: existing ? existing.reconnectAttempts : 0,
      webhookUrl: options?.webhookUrl || existing?.webhookUrl,
      webhookSecret: options?.webhookSecret || existing?.webhookSecret,
      aiEnabled: options?.aiEnabled ?? existing?.aiEnabled ?? config.AI_BRIDGE_ENABLED,
      aiPrompt: options?.aiPrompt || existing?.aiPrompt,
    };

    this.sessions.set(sessionId, sessionInstance);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: logger.child({ session: sessionId, module: 'baileys' }) as any,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: true,
    });

    sessionInstance.socket = socket;

    // Listen to credentials update
    socket.ev.on('creds.update', saveCreds);

    // Connection state updates
    socket.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sessionInstance.status = 'SCAN_QR_CODE';
        sessionInstance.qrCodeRaw = qr;
        try {
          sessionInstance.qrCodeDataUrl = await QRCode.toDataURL(qr);
          sessionInstance.qrCodeSvg = await QRCode.toString(qr, { type: 'svg' });
          logger.info(`[Session: ${sessionId}] QR Code generated. Scan to link device.`);
          // Print small terminal QR for convenience
          qrcodeTerminal.generate(qr, { small: true });
        } catch (qrErr) {
          logger.error({ err: qrErr }, 'Failed to generate QR data URL/SVG');
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        sessionInstance.status = 'DISCONNECTED';
        sessionInstance.qrCodeRaw = undefined;
        sessionInstance.qrCodeDataUrl = undefined;
        sessionInstance.qrCodeSvg = undefined;

        logger.warn(
          { sessionId, statusCode, isLoggedOut },
          `Session connection closed: ${lastDisconnect?.error?.message || 'Unknown reason'}`
        );

        await webhookService.dispatch(
          {
            event: 'session.status',
            sessionId,
            timestamp: Date.now(),
            data: { status: 'disconnected', reason: lastDisconnect?.error?.message || 'closed' },
          },
          sessionInstance.webhookUrl,
          sessionInstance.webhookSecret
        );

        if (isLoggedOut) {
          logger.warn(`[Session: ${sessionId}] Device logged out. Cleaning session storage.`);
          await this.logoutSession(sessionId);
        } else {
          // Automatic Reconnection with exponential backoff
          const maxReconnectDelay = 30000;
          const delay = Math.min(1000 * Math.pow(2, sessionInstance.reconnectAttempts), maxReconnectDelay);
          sessionInstance.reconnectAttempts++;
          logger.info(`[Session: ${sessionId}] Reconnecting in ${delay / 1000}s (attempt ${sessionInstance.reconnectAttempts})...`);
          setTimeout(() => {
            this.initSession(sessionId, options).catch((err) => {
              logger.error({ sessionId, err: err.message }, 'Session auto-reconnection failed');
            });
          }, delay);
        }
      } else if (connection === 'open') {
        sessionInstance.status = 'CONNECTED';
        sessionInstance.reconnectAttempts = 0;
        sessionInstance.qrCodeRaw = undefined;
        sessionInstance.qrCodeDataUrl = undefined;
        sessionInstance.qrCodeSvg = undefined;

        if (socket.user) {
          sessionInstance.user = {
            id: socket.user.id,
            name: socket.user.name,
          };
        }

        logger.info(
          { sessionId, user: sessionInstance.user },
          `WhatsApp Session Connected Successfully!`
        );

        await webhookService.dispatch(
          {
            event: 'session.status',
            sessionId,
            timestamp: Date.now(),
            data: { status: 'connected', user: sessionInstance.user },
          },
          sessionInstance.webhookUrl,
          sessionInstance.webhookSecret
        );
      }
    });

    // Inbound Messages & Events
    socket.ev.on('messages.upsert', async (chatUpdate) => {
      if (chatUpdate.type !== 'notify') return;

      for (const msg of chatUpdate.messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          '';

        const senderPhone = remoteJid.split('@')[0];
        const pushName = msg.pushName || 'Unknown';
        const timestamp = Number(msg.messageTimestamp) * 1000 || Date.now();

        logger.info(
          { sessionId, remoteJid, sender: pushName, text: text.substring(0, 80) },
          'Inbound message received'
        );

        // 1. Dispatch message.received Webhook
        await webhookService.dispatch(
          {
            event: 'message.received',
            sessionId,
            timestamp,
            data: {
              id: msg.key.id,
              from: remoteJid,
              senderPhone,
              pushName,
              text,
              hasMedia: Boolean(
                msg.message.imageMessage ||
                  msg.message.videoMessage ||
                  msg.message.audioMessage ||
                  msg.message.documentMessage
              ),
              rawMessage: msg,
            },
          },
          sessionInstance.webhookUrl,
          sessionInstance.webhookSecret
        );

        // 2. Check Pluggable AI Chatbot layer
        if (sessionInstance.aiEnabled && text) {
          try {
            const aiReply = await aiBridgeService.generateReply(
              text,
              senderPhone,
              sessionInstance.aiPrompt
            );

            if (aiReply) {
              logger.info(
                { sessionId, to: remoteJid, replyLength: aiReply.length },
                'AI Bridge generated automated reply. Enqueueing response...'
              );

              await this.sendTextMessage(sessionId, remoteJid, aiReply, {
                simulatePresence: true,
                quoted: msg,
              });
            }
          } catch (aiErr: any) {
            logger.error({ sessionId, err: aiErr.message }, 'AI Bridge response failed');
          }
        }
      }
    });

    // Message status receipt updates (sent, delivered, read)
    socket.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        await webhookService.dispatch(
          {
            event: 'message.status',
            sessionId,
            timestamp: Date.now(),
            data: {
              id: update.key.id,
              remoteJid: update.key.remoteJid,
              status: update.update.status,
            },
          },
          sessionInstance.webhookUrl,
          sessionInstance.webhookSecret
        );
      }
    });

    return sessionInstance;
  }

  /**
   * Simulates typing presence before sending a message
   */
  private async simulateTyping(socket: WASocket, jid: string): Promise<void> {
    const minDelay = config.PRESENCE_MIN_DELAY_MS || 1500;
    const maxDelay = config.PRESENCE_MAX_DELAY_MS || 3000;
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

    try {
      await socket.presenceSubscribe(jid);
      await socket.sendPresenceUpdate('composing', jid);
      await new Promise((r) => setTimeout(r, delay));
      await socket.sendPresenceUpdate('paused', jid);
    } catch (e) {
      // Non-fatal if presence update fails
    }
  }

  /**
   * Send text message with anti-ban pacing, typing presence, and reply/quote support
   */
  public async sendTextMessage(
    sessionId: string,
    toJid: string,
    message: string,
    options?: { simulatePresence?: boolean; quoted?: any; quotedMessageId?: string }
  ): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.socket || session.status !== 'CONNECTED') {
      throw new Error(`WhatsApp Session "${sessionId}" is not active or connected`);
    }

    const simulate = options?.simulatePresence ?? true;

    // Build quoted message reference if quotedMessageId is passed
    let quoteOption = options?.quoted;
    if (!quoteOption && options?.quotedMessageId) {
      quoteOption = {
        key: {
          remoteJid: toJid,
          id: options.quotedMessageId,
          fromMe: false,
        },
        message: {
          conversation: '...',
        },
      };
    }

    return throttledQueue.enqueue(
      sessionId,
      toJid,
      async () => {
        if (simulate && session.socket) {
          await this.simulateTyping(session.socket, toJid);
        }
        return await session.socket!.sendMessage(
          toJid,
          { text: message },
          quoteOption ? { quoted: quoteOption } : undefined
        );
      },
      simulate
    );
  }

  /**
   * Send media (Image, Video, Audio/Voice, Document/PDF)
   */
  public async sendMediaMessage(
    sessionId: string,
    toJid: string,
    media: {
      type: 'image' | 'video' | 'audio' | 'document';
      buffer?: Buffer;
      url?: string;
      caption?: string;
      mimetype?: string;
      fileName?: string;
      ptt?: boolean; // Push-to-talk voice note
    },
    options?: { simulatePresence?: boolean }
  ): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.socket || session.status !== 'CONNECTED') {
      throw new Error(`WhatsApp Session "${sessionId}" is not active or connected`);
    }

    const mediaPayload: any = media.url ? { url: media.url } : media.buffer;
    let messageContent: AnyMessageContent;

    switch (media.type) {
      case 'image':
        messageContent = {
          image: mediaPayload,
          caption: media.caption,
          mimetype: media.mimetype || 'image/jpeg',
        };
        break;
      case 'video':
        messageContent = {
          video: mediaPayload,
          caption: media.caption,
          mimetype: media.mimetype || 'video/mp4',
        };
        break;
      case 'audio':
        messageContent = {
          audio: mediaPayload,
          mimetype: media.mimetype || 'audio/mp4',
          ptt: media.ptt ?? false,
        };
        break;
      case 'document':
        messageContent = {
          document: mediaPayload,
          mimetype: media.mimetype || 'application/pdf',
          fileName: media.fileName || 'document.pdf',
          caption: media.caption,
        };
        break;
      default:
        throw new Error(`Unsupported media type: ${(media as any).type}`);
    }

    const simulate = options?.simulatePresence ?? true;

    return throttledQueue.enqueue(
      sessionId,
      toJid,
      async () => {
        if (simulate && session.socket) {
          await this.simulateTyping(session.socket, toJid);
        }
        return await session.socket!.sendMessage(toJid, messageContent);
      },
      simulate
    );
  }

  /**
   * Send reaction emoji to a message
   */
  public async sendReaction(
    sessionId: string,
    toJid: string,
    messageId: string,
    emoji: string
  ): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.socket || session.status !== 'CONNECTED') {
      throw new Error(`WhatsApp Session "${sessionId}" is not active or connected`);
    }

    return throttledQueue.enqueue(
      sessionId,
      toJid,
      async () => {
        return await session.socket!.sendMessage(toJid, {
          react: {
            text: emoji,
            key: {
              remoteJid: toJid,
              fromMe: false,
              id: messageId,
            },
          },
        });
      },
      false
    );
  }

  /**
   * Disconnects, logs out from WhatsApp servers, and deletes session directory
   */
  public async logoutSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.socket) {
      try {
        await session.socket.logout();
      } catch (e) {
        // Socket might already be closed
      }
      try {
        // Clean up all event listeners to avoid memory leak
        session.socket.ev.removeAllListeners('connection.update');
        session.socket.ev.removeAllListeners('creds.update');
        session.socket.ev.removeAllListeners('messages.upsert');
        session.socket.ev.removeAllListeners('messages.update');
      } catch (e) {
        // Ignore if already removed
      }
      session.socket.end(new Error('Manual logout invoked'));
    }

    this.sessions.delete(sessionId);

    const sessionDir = path.join(this.baseStorageDir, sessionId);
    if (existsSync(sessionDir)) {
      try {
        await fsPromises.rm(sessionDir, { recursive: true, force: true });
        logger.info(`Session files purged for sessionId: ${sessionId}`);
      } catch (err: any) {
        logger.error({ sessionId, err: err.message }, 'Failed to delete session files');
      }
    }
  }
}

export const sessionManager = SessionManager.getInstance();
