-- 仅创建独立数据库，不触碰 db_agent 或任何业务库。
-- 推荐使用 npm run db:init（幂等，且会自动建表）。
-- 手工执行时：psql "$BROWSER_AGENT_PG_DSN" -d postgres -f scripts/db/create-database.sql

CREATE DATABASE db_browser_agent;
