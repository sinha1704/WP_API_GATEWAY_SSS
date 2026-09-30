import { logger } from '../utils/logger.js';
import { config } from '../config/env.js';

export interface QueuedMessageTask {
  id: string;
  sessionId: string;
  jid: string;
  task: () => Promise<any>;
  simulatePresence: boolean;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timestamp: number;
}

export class ThrottledMessageQueue {
  private static instance: ThrottledMessageQueue;
  // Per-session message queues to keep independent numbers non-blocking
  private queues: Map<string, QueuedMessageTask[]> = new Map();
  private processing: Map<string, boolean> = new Map();

  private constructor() {}

  public static getInstance(): ThrottledMessageQueue {
    if (!ThrottledMessageQueue.instance) {
      ThrottledMessageQueue.instance = new ThrottledMessageQueue();
    }
    return ThrottledMessageQueue.instance;
  }

  /**
   * Enqueues an outbound WhatsApp message task with anti-ban pacing and optional typing presence
   */
  public enqueue<T>(
    sessionId: string,
    jid: string,
    task: () => Promise<T>,
    simulatePresence: boolean = true
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queueItem: QueuedMessageTask = {
        id: Math.random().toString(36).substring(2, 9),
        sessionId,
        jid,
        task,
        simulatePresence,
        resolve,
        reject,
        timestamp: Date.now(),
      };

      if (!this.queues.has(sessionId)) {
        this.queues.set(sessionId, []);
      }

      this.queues.get(sessionId)!.push(queueItem);
      logger.debug(
        { sessionId, jid, taskId: queueItem.id, queueSize: this.queues.get(sessionId)!.length },
        'Message enqueued to anti-ban throttle queue'
      );

      this.processNext(sessionId);
    });
  }

  private async processNext(sessionId: string): Promise<void> {
    if (this.processing.get(sessionId)) {
      return;
    }

    const sessionQueue = this.queues.get(sessionId);
    if (!sessionQueue || sessionQueue.length === 0) {
      return;
    }

    this.processing.set(sessionId, true);
    const item = sessionQueue.shift()!;

    try {
      // Execute the task
      const result = await item.task();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      // Anti-ban spacing delay before processing next item for this session
      const delayMs = config.QUEUE_MESSAGE_DELAY_MS || 3000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      this.processing.set(sessionId, false);
      if (sessionQueue.length > 0) {
        this.processNext(sessionId);
      }
    }
  }

  public getQueueLength(sessionId: string): number {
    return this.queues.get(sessionId)?.length || 0;
  }
}

export const throttledQueue = ThrottledMessageQueue.getInstance();
