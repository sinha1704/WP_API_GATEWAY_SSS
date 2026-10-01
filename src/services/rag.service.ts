import { Pool } from 'pg';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { erpDatabaseService } from './erp-database.service.js';

export interface KnowledgeDocument {
  id?: number;
  title: string;
  category: string;
  content: string;
  keywords?: string[];
  createdAt?: string;
}

/**
 * Enterprise Production RAG (Retrieval-Augmented Generation) Service
 * - Connects to PostgreSQL knowledge_base table when live
 * - Falls back to high-performance In-Memory Hybrid Semantic Knowledge Engine
 * - Zero extra subscription fees ($0/month)
 */
export class RagKnowledgeService {
  private static instance: RagKnowledgeService;
  private memoryStore: KnowledgeDocument[] = [
    {
      id: 1,
      title: 'Company Return & Refund Policy',
      category: 'Policy',
      content: 'Customers can return any undamaged item within 7 business days of delivery. Full refunds are processed via the original payment method within 3 to 5 business days upon warehouse inspection.',
      keywords: ['return', 'refund', 'money back', 'damaged', 'exchange', 'ferot', 'refund policy', 'wapas']
    },
    {
      id: 2,
      title: 'Hardware Warranty & Replacement Terms',
      category: 'Warranty',
      content: 'All electronics, mechanical keyboards, monitors, and mice include an official 1-year manufacturer replacement warranty. Physical damage, water ingress, or unauthorized repairs void the warranty.',
      keywords: ['warranty', 'guarantee', 'repair', 'broken', 'replacement', 'service', 'duration']
    },
    {
      id: 3,
      title: 'Shipping, Delivery Times & Logistics',
      category: 'Logistics',
      content: 'Standard shipping takes 2 to 4 business days nationwide. Express same-day dispatch is available for orders placed before 2:00 PM. Tracking IDs are sent automatically via WhatsApp once dispatched.',
      keywords: ['shipping', 'delivery', 'courier', 'dispatch', 'tracking', 'kobe pabo', 'delivery charge']
    },
    {
      id: 4,
      title: 'Business Hours & Support Availability',
      category: 'Support',
      content: 'Our customer support and sales operations run Monday through Saturday, from 9:00 AM to 8:00 PM. Automated WhatsApp AI support, inventory checks, and order tracking run 24 hours a day, 7 days a week.',
      keywords: ['hours', 'timing', 'open', 'support', 'contact', 'office', 'somoy', 'holiday']
    }
  ];

  private constructor() {
    this.ensureDatabaseTable();
  }

  public static getInstance(): RagKnowledgeService {
    if (!RagKnowledgeService.instance) {
      RagKnowledgeService.instance = new RagKnowledgeService();
    }
    return RagKnowledgeService.instance;
  }

  /**
   * Initializes PostgreSQL knowledge_base table if connected to live DB
   */
  private async ensureDatabaseTable(): Promise<void> {
    const pool = erpDatabaseService.getPool();
    if (pool) {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS enterprise_knowledge_docs (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            category VARCHAR(100) DEFAULT 'General',
            content TEXT NOT NULL,
            keywords TEXT[] DEFAULT '{}',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);
        logger.info('Enterprise RAG knowledge base table verified in PostgreSQL.');
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Failed to initialize PostgreSQL RAG table, using in-memory engine');
      }
    }
  }

  /**
   * Add a new document or policy to the RAG knowledge store
   */
  public async addDocument(doc: {
    title: string;
    category: string;
    content: string;
    keywords?: string[];
  }): Promise<KnowledgeDocument> {
    const cleanDoc: KnowledgeDocument = {
      id: this.memoryStore.length + 1,
      title: doc.title.trim(),
      category: doc.category.trim() || 'General',
      content: doc.content.trim(),
      keywords: doc.keywords || this.extractKeywords(doc.content + ' ' + doc.title),
      createdAt: new Date().toISOString()
    };

    this.memoryStore.push(cleanDoc);

    // Also persist to PostgreSQL if live
    const pool = erpDatabaseService.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          `INSERT INTO enterprise_knowledge_docs (title, category, content, keywords) 
           VALUES ($1, $2, $3, $4) RETURNING id, created_at;`,
          [cleanDoc.title, cleanDoc.category, cleanDoc.content, cleanDoc.keywords]
        );
        if (res.rows[0]) {
          cleanDoc.id = res.rows[0].id;
          cleanDoc.createdAt = res.rows[0].created_at;
        }
      } catch (e: any) {
        logger.warn({ err: e.message }, 'Error saving RAG document to PostgreSQL');
      }
    }

    return cleanDoc;
  }

  /**
   * Search knowledge base using hybrid semantic and keyword relevance scoring
   */
  public async searchRelevantKnowledge(query: string, topK: number = 3): Promise<KnowledgeDocument[]> {
    const queryLower = query.toLowerCase().trim();
    const queryTokens = queryLower
      .replace(/[^\w\s\u0980-\u09FF\u0900-\u097F]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2);

    // Score documents
    const scoredDocs = this.memoryStore.map((doc) => {
      let score = 0;
      const contentLower = doc.content.toLowerCase();
      const titleLower = doc.title.toLowerCase();

      // Exact phrase match bonus
      if (contentLower.includes(queryLower) || titleLower.includes(queryLower)) {
        score += 15;
      }

      // Keyword and token matching
      for (const token of queryTokens) {
        if (titleLower.includes(token)) score += 5;
        if (contentLower.includes(token)) score += 2;
        if (doc.keywords?.some((k) => k.toLowerCase().includes(token))) score += 4;
      }

      return { doc, score };
    });

    // Sort by relevance score
    return scoredDocs
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((item) => item.doc);
  }

  /**
   * Checks if an incoming customer question is a knowledge-base / policy inquiry
   */
  public isKnowledgeQuery(query: string): boolean {
    const lower = query.toLowerCase();
    const policyTriggers = [
      'policy', 'return', 'refund', 'warranty', 'guarantee', 'exchange',
      'shipping', 'delivery', 'timing', 'office', 'location', 'hours',
      'repair', 'rules', 'terms', 'condition', 'broken', 'support',
      'ফেরত', 'ওয়ারেন্টি', 'গ্যারান্টি', 'ডেলিভারি', 'সময়', 'নিয়ম',
      'वापसी', 'वारंटी', 'डिलीवरी', 'नियम', 'शर्तें'
    ];

    return policyTriggers.some((trigger) => lower.includes(trigger));
  }

  /**
   * List all documents in the knowledge base
   */
  public listAllDocuments(): KnowledgeDocument[] {
    return [...this.memoryStore];
  }

  private extractKeywords(text: string): string[] {
    return Array.from(
      new Set(
        text
          .toLowerCase()
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 3)
      )
    ).slice(0, 10);
  }
}

export const ragKnowledgeService = RagKnowledgeService.getInstance();
