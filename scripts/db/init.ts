import { initBrowserAgentDatabase } from '../../src/persistence/init-db.js';

const dsn = process.env.BROWSER_AGENT_PG_DSN;
if (!dsn) {
  console.error('缺少环境变量 BROWSER_AGENT_PG_DSN');
  process.exit(1);
}

try {
  const result = await initBrowserAgentDatabase(dsn);
  console.log(
    JSON.stringify(
      {
        host: result.host,
        port: result.port,
        database: result.database,
        createdDatabase: result.createdDatabase,
        tables: result.tables,
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(`数据库初始化失败：${(error as Error).message}`);
  process.exit(1);
}
