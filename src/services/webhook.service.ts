import crypto from 'crypto';
import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/env.js';

export interface WebhookEvent<T = any> {
  event: 'message.received' | 'message.status' | 'session.status';
  sessionId: string;
  timestamp: number;
  data: T;
}

export class WebhookService {
  private static instance: WebhookService;

  private constructor() {}

  public static getInstance(): WebhookService {
    if (!WebhookService.instance) {
      WebhookService.instance = new WebhookService();
    }
    return WebhookService.instance;
  }

  /**
   * Generates HMAC-SHA256 signature for webhook payload verification
   */
  public generateSignature(payload: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  /**
   * Dispatches webhook event with automatic retry logic (up to 3 retries) and exponential backoff
   */
  public async dispatch<T>(
    event: WebhookEvent<T>,
    customWebhookUrl?: string,
    customSecret?: string
  ): Promise<void> {
    const targetUrl = customWebhookUrl || config.GLOBAL_WEBHOOK_URL;
    if (!targetUrl) {
      return; // No webhook configured
    }

    const secret = customSecret || config.WEBHOOK_SECRET;
    const jsonPayload = JSON.stringify(event);
    const signature = this.generateSignature(jsonPayload, secret);

    const maxRetries = 3;
    let attempt = 0;
    let delivered = false;

    while (attempt < maxRetries && !delivered) {
      attempt++;
      try {
        await axios.post(targetUrl, jsonPayload, {
          headers: {
            'Content-Type': 'application/json',
            'X-Gateway-Event': event.event,
            'X-Gateway-Session': event.sessionId,
            'X-Gateway-Signature': signature,
            'X-Gateway-Timestamp': event.timestamp.toString(),
          },
          timeout: 5000,
        });

        logger.debug(
          { event: event.event, sessionId: event.sessionId, targetUrl, attempt },
          'Webhook delivered successfully'
        );
        delivered = true;
      } catch (err: any) {
        logger.warn(
          {
            event: event.event,
            sessionId: event.sessionId,
            targetUrl,
            attempt,
            error: err.message,
          },
          `Webhook delivery failed (attempt ${attempt}/${maxRetries})`
        );

        if (attempt < maxRetries) {
          // Exponential backoff: 500ms, 1500ms
          const delay = Math.pow(attempt, 2) * 500;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }
}

export const webhookService = WebhookService.getInstance();
