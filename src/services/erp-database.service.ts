import { Pool } from 'pg';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface ERPQueryResult {
  success: boolean;
  query?: string;
  rows?: any[];
  rowCount?: number;
  error?: string;
}

/**
 * Schema Masking Definition:
 * Only metadata / schema definition is shown to LLM.
 * No sensitive raw customer phone numbers, internal credentials, or passwords are given.
 */
export const ERP_SCHEMA_METADATA = `
Table: products
  - id: INT (PRIMARY KEY)
  - sku: VARCHAR(50) (Unique product code e.g. 'PRD-001')
  - name: VARCHAR(255) (Product name e.g. 'Wireless Mouse', 'Mechanical Keyboard')
  - category: VARCHAR(100) (e.g. 'Electronics', 'Stationery', 'Office')
  - unit_price: NUMERIC(10,2) (Selling price per unit)
  - cost_price: NUMERIC(10,2) (Procurement cost)
  - stock_quantity: INT (Current inventory units on hand)
  - reorder_level: INT (Minimum safety stock before replenishment)
  - is_active: BOOLEAN (True if currently active)

Table: sales_orders
  - id: INT (PRIMARY KEY)
  - order_number: VARCHAR(50) (e.g. 'SO-2026-001')
  - customer_name: VARCHAR(255) (Customer or Client name)
  - total_amount: NUMERIC(12,2) (Total sales amount in $)
  - order_status: VARCHAR(50) ('COMPLETED', 'PENDING', 'CANCELLED')
  - payment_status: VARCHAR(50) ('PAID', 'UNPAID', 'REFUNDED')
  - created_at: TIMESTAMP (Order creation timestamp e.g. CURRENT_DATE)

Table: sales_order_items
  - id: INT (PRIMARY KEY)
  - order_id: INT (Foreign key to sales_orders.id)
  - product_id: INT (Foreign key to products.id)
  - quantity: INT (Quantity sold)
  - unit_price: NUMERIC(10,2)
  - subtotal: NUMERIC(12,2)
`;

// In-Memory Mock Database for Demo, Offline, & Zero-Setup testing
const MOCK_PRODUCTS = [
  { id: 1, sku: 'PRD-001', name: 'Logitech Wireless Mouse', category: 'Electronics', unit_price: 25.00, cost_price: 15.00, stock_quantity: 142, reorder_level: 20, is_active: true },
  { id: 2, sku: 'PRD-002', name: 'Keychron Mechanical Keyboard', category: 'Electronics', unit_price: 85.00, cost_price: 55.00, stock_quantity: 38, reorder_level: 15, is_active: true },
  { id: 3, sku: 'PRD-003', name: 'Dell 27-inch 4K Monitor', category: 'Electronics', unit_price: 320.00, cost_price: 240.00, stock_quantity: 14, reorder_level: 5, is_active: true },
  { id: 4, sku: 'PRD-004', name: 'Ergonomic Office Chair', category: 'Furniture', unit_price: 210.00, cost_price: 140.00, stock_quantity: 9, reorder_level: 10, is_active: true },
  { id: 5, sku: 'PRD-005', name: 'USB-C Fast Charging Cable', category: 'Accessories', unit_price: 12.00, cost_price: 4.00, stock_quantity: 350, reorder_level: 50, is_active: true },
];

const MOCK_SALES_ORDERS = [
  { id: 101, order_number: 'SO-2026-001', customer_name: 'Apex Corp', total_amount: 1250.00, order_status: 'COMPLETED', payment_status: 'PAID', created_at: new Date().toISOString() },
  { id: 102, order_number: 'SO-2026-002', customer_name: 'Metro Tech', total_amount: 890.50, order_status: 'COMPLETED', payment_status: 'PAID', created_at: new Date().toISOString() },
  { id: 103, order_number: 'SO-2026-003', customer_name: 'Global Ventures', total_amount: 430.00, order_status: 'COMPLETED', payment_status: 'PAID', created_at: new Date().toISOString() },
  { id: 104, order_number: 'SO-2026-004', customer_name: 'Nexus Logistics', total_amount: 2100.00, order_status: 'PENDING', payment_status: 'UNPAID', created_at: new Date().toISOString() },
];

export class DatabaseSecurityGuard {
  // Disallowed dangerous keywords
  private static FORBIDDEN_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
    'CREATE', 'RENAME', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE',
    'COPY', 'VACUUM', 'REINDEX', 'CALL', 'COMMENT', 'SECURITY'
  ];

  /**
   * Enforces Strict Read-Only query rules:
   * 1. Query must start with SELECT or WITH (common table expressions)
   * 2. Must not contain mutative/DDL keywords
   * 3. Multiple statements separated by semicolon (SQL injection vector) are blocked
   */
  public static validateReadOnlyQuery(sql: string): { valid: boolean; reason?: string } {
    const trimmed = sql.trim().replace(/^;+|;+$/g, '');

    // Prevent multi-statement query attacks (e.g. SELECT 1; DROP TABLE products;)
    if (trimmed.includes(';')) {
      return { valid: false, reason: 'Security Guard: Semicolons or multi-statement queries are forbidden' };
    }

    const upper = trimmed.toUpperCase();

    // Must be SELECT or WITH
    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
      return { valid: false, reason: 'Security Guard: Only SELECT / Read-Only queries are permitted' };
    }

    // Check for blacklisted mutative tokens
    const words = upper.split(/\s+/);
    for (const forbidden of this.FORBIDDEN_KEYWORDS) {
      if (words.includes(forbidden) || new RegExp(`\\b${forbidden}\\b`, 'i').test(trimmed)) {
        return { valid: false, reason: `Security Guard: Forbidden operation '${forbidden}' detected in SQL` };
      }
    }

    return { valid: true };
  }
}

export class ErpDatabaseService {
  private static instance: ErpDatabaseService;
  private pgPool: Pool | null = null;

  private constructor() {
    if (config.ERP_DB_TYPE === 'postgres' && config.ERP_DB_HOST) {
      try {
        this.pgPool = new Pool({
          host: config.ERP_DB_HOST,
          port: config.ERP_DB_PORT,
          user: config.ERP_DB_USER, // e.g. ai_reader (Read-only user)
          password: config.ERP_DB_PASSWORD,
          database: config.ERP_DB_NAME,
          ssl: config.ERP_DB_SSL ? { rejectUnauthorized: false } : false,
          max: 5,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        });
        logger.info(`ERP Database configured with PostgreSQL at ${config.ERP_DB_HOST}:${config.ERP_DB_PORT}/${config.ERP_DB_NAME} (User: ${config.ERP_DB_USER})`);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to initialize PostgreSQL pool for ERP');
      }
    } else {
      logger.info('ERP Database initialized with Built-in Safe Mock Database (Local/Demo Stage)');
    }
  }

  public static getInstance(): ErpDatabaseService {
    if (!ErpDatabaseService.instance) {
      ErpDatabaseService.instance = new ErpDatabaseService();
    }
    return ErpDatabaseService.instance;
  }

  /**
   * Execute read-only query safely with security guards
   */
  public async executeSafeQuery(sql: string): Promise<ERPQueryResult> {
    const cleanSql = sql.trim().replace(/^;+|;+$/g, '');

    // 1. Guardrail validation
    const validation = DatabaseSecurityGuard.validateReadOnlyQuery(cleanSql);
    if (!validation.valid) {
      logger.warn({ query: cleanSql, reason: validation.reason }, 'SQL Security Guard rejected query');
      return {
        success: false,
        query: cleanSql,
        error: validation.reason,
      };
    }

    // 2. Production PostgreSQL Execution
    if (config.ERP_DB_TYPE === 'postgres' && this.pgPool) {
      try {
        const client = await this.pgPool.connect();
        try {
          // Extra security layer: set transaction read only
          await client.query('SET TRANSACTION READ ONLY;');
          const result = await client.query(cleanSql);
          return {
            success: true,
            query: cleanSql,
            rows: result.rows,
            rowCount: result.rowCount || result.rows.length,
          };
        } finally {
          client.release();
        }
      } catch (err: any) {
        logger.error({ query: cleanSql, err: err.message }, 'PostgreSQL read-only execution error');
        return {
          success: false,
          query: cleanSql,
          error: `Database query error: ${err.message}`,
        };
      }
    }

    // 3. Built-in Mock / Offline Database Execution (for instant zero-setup demo & local mode)
    return this.executeMockQuery(cleanSql);
  }

  /**
   * Evaluates common business questions against mock dataset safely
   */
  private executeMockQuery(sql: string): ERPQueryResult {
    const lower = sql.toLowerCase();

    // Check for sales query
    if (lower.includes('sales_orders') || lower.includes('sales')) {
      if (lower.includes('sum(') || lower.includes('total')) {
        const completed = MOCK_SALES_ORDERS.filter((o) => o.order_status === 'COMPLETED');
        const sum = completed.reduce((acc, curr) => acc + curr.total_amount, 0);
        return {
          success: true,
          query: sql,
          rows: [{ total_sales: sum, order_count: completed.length }],
          rowCount: 1,
        };
      }
      return {
        success: true,
        query: sql,
        rows: MOCK_SALES_ORDERS,
        rowCount: MOCK_SALES_ORDERS.length,
      };
    }

    // Check for products / inventory query
    if (lower.includes('products') || lower.includes('stock')) {
      if (lower.includes('sum(stock_quantity)') || lower.includes('total')) {
        const totalStock = MOCK_PRODUCTS.reduce((acc, curr) => acc + curr.stock_quantity, 0);
        return {
          success: true,
          query: sql,
          rows: [{ total_stock_items: totalStock, unique_products: MOCK_PRODUCTS.length }],
          rowCount: 1,
        };
      }

      if (lower.includes('reorder') || lower.includes('low stock') || lower.includes('< reorder_level')) {
        const lowStock = MOCK_PRODUCTS.filter((p) => p.stock_quantity <= p.reorder_level);
        return {
          success: true,
          query: sql,
          rows: lowStock,
          rowCount: lowStock.length,
        };
      }

      // Return items
      return {
        success: true,
        query: sql,
        rows: MOCK_PRODUCTS,
        rowCount: MOCK_PRODUCTS.length,
      };
    }

    return {
      success: true,
      query: sql,
      rows: [
        {
          message: 'Query executed against mock ERP store',
          total_stock: MOCK_PRODUCTS.reduce((acc, curr) => acc + curr.stock_quantity, 0),
          total_sales: MOCK_SALES_ORDERS.filter((o) => o.order_status === 'COMPLETED').reduce((acc, curr) => acc + curr.total_amount, 0),
        },
      ],
      rowCount: 1,
    };
  }

  public getMockProducts() {
    return MOCK_PRODUCTS;
  }

  public getMockSalesOrders() {
    return MOCK_SALES_ORDERS;
  }
}

export const erpDatabaseService = ErpDatabaseService.getInstance();
