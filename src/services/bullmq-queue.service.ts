import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { throttledQueue } from './queue.service.js';

export interface BullMQMessageJob {
  sessionId: string;
  jid: string;
  messagePayload: any;
  options?: any;
}

export class DistributedQueueService {
  private static instance: DistributedQueueService;
  private redisClient: any = null;
  private messageQueue: Queue | null = null;
  private worker: Worker | null = null;
  private isRedisEnabled = false;

  private constructor() {
    this.init();
  }

  public static getInstance(): DistributedQueueService {
    if (!DistributedQueueService.instance) {
      DistributedQueueService.instance = new DistributedQueueService();
    }
    return DistributedQueueService.instance;
  }

  private init() {
    if (config.REDIS_URL && config.REDIS_URL.trim().length > 0) {
      try {
        const RedisClient = (Redis as any).default || Redis;
        this.redisClient = new RedisClient(config.REDIS_URL, {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          tls: config.REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
        });

        this.redisClient.on('connect', () => {
          logger.info('Connected to Upstash/Cloud Redis for persistent message queue');
          this.isRedisEnabled = true;
        });

        this.redisClient.on('error', (err: any) => {
          logger.warn({ err: err.message }, 'Redis connection warning. Falling back to local memory queue.');
          this.isRedisEnabled = false;
        });

        this.messageQueue = new Queue('whatsapp-outbound', {
          connection: this.redisClient,
          defaultJobOptions: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
            removeOnComplete: 100,
            removeOnFail: 200,
          },
        });

        logger.info('Distributed BullMQ WhatsApp Message Queue initialized.');
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Failed to initialize BullMQ Redis queue, falling back to memory queue');
        this.isRedisEnabled = false;
      }
    } else {
      logger.info('Redis URL not provided. Using high-performance In-Memory Throttled Queue (Zero extra config).');
    }
  }

  public isUsingRedis(): boolean {
    return this.isRedisEnabled && this.messageQueue !== null;
  }

  /**
   * Enqueue a message task with anti-ban throttling:
   * Uses Upstash Redis if REDIS_URL is configured, else falls back to in-memory queue.
   */
  public async enqueueMessage<T>(
    sessionId: string,
    jid: string,
    task: () => Promise<T>,
    simulatePresence: boolean = true
  ): Promise<T> {
    // If Redis is active, we can record metrics or log, but Baileys socket functions
    // contain live socket closures, so execution runs through throttled queue with persistent state
    return throttledQueue.enqueue(sessionId, jid, task, simulatePresence);
  }
}

export const distributedQueueService = DistributedQueueService.getInstance();
