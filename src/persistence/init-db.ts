import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

const SCHEMA_PATH = fileURLToPath(new URL('../../scripts/db/schema.sql', import.meta.url));

export interface DbInitResult {
  host: string;
  port: string;
  database: string;
  createdDatabase: boolean;
  tables: string[];
}

/**
 * 只在独立库 db_browser_agent 上建表；DSN 指向其他库时直接拒绝，避免误触 db_agent / 业务库。
 * 建库使用同一 DSN 的凭据连接系统库 postgres，不读取或打印任何密码。
 */
export async function initBrowserAgentDatabase(dsn: string): Promise<DbInitResult> {
  let target: URL;
  try {
    target = new URL(dsn);
  } catch {
    throw new Error('BROWSER_AGENT_PG_DSN 不是合法 URL');
  }

  const database = decodeURIComponent(target.pathname.replace(/^\//, '')) || 'db_browser_agent';
  if (database !== 'db_browser_agent') {
    throw new Error(
      `DSN 必须指向独立库 db_browser_agent，当前为「${database}」；拒绝触碰其他数据库`
    );
  }

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const adminUrl = new URL(dsn);
  adminUrl.pathname = '/postgres';

  let createdDatabase = false;
  const admin = new Pool({
    connectionString: adminUrl.toString(),
    max: 1,
    application_name: 'browser-agent-db-init',
  });

  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      'db_browser_agent',
    ]);
    if ((exists.rowCount ?? 0) === 0) {
      await admin.query('CREATE DATABASE db_browser_agent');
      createdDatabase = true;
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  const pool = new Pool({
    connectionString: dsn,
    max: 2,
    application_name: 'browser-agent-db-init',
  });

  try {
    await pool.query(schema);
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename LIKE 'browser_%'
       ORDER BY tablename`
    );

    return {
      host: target.hostname,
      port: target.port || '5432',
      database,
      createdDatabase,
      tables: tables.rows.map((row) => row.tablename),
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}
