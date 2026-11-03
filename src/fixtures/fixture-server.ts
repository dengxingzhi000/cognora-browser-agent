import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DraftRecord {
  id: string;
  name: string;
  brand: string;
  price: string;
  stock: string;
  description: string;
  savedAt: string;
}

export interface FixtureServer {
  url: string;
  port: number;
  drafts: DraftRecord[];
  counter: () => number;
  close: () => Promise<void>;
}

const FIXTURE_ROOT = fileURLToPath(new URL('../../fixture/', import.meta.url));

const HTML_ROUTES: Record<string, string> = {
  '/': 'product-form.html',
  '/product-form': 'product-form.html',
  '/blocked': 'blocked.html',
  '/session': 'session.html',
  '/approval-demo': 'approval-demo.html',
  '/components/custom-select-radix': 'custom-select-radix.html',
  '/components/custom-select-antd': 'custom-select-antd.html',
  '/components/iframe-host': 'iframe-host.html',
  '/iframe-inner': 'iframe-inner.html',
  '/components/upload': 'upload.html',
  '/components/download': 'download.html',
  '/components/waits': 'waits.html',
  '/components/waits-stuck': 'waits-stuck.html',
};

function hasAccessToken(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .some((part) => part.startsWith('access_token=') && part.length > 'access_token='.length);
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('请求体过大'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

/**
 * 本地靶场：静态页面 + 内存接口。只用于测试与 CLI 离线回归，不依赖外网。
 * 端口传 0 时由系统分配，便于测试并行/重复运行。
 */
export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const drafts: DraftRecord[] = [];
  let counter = 0;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    try {
      if (request.method === 'GET' && HTML_ROUTES[url.pathname]) {
        if (url.pathname === '/' || url.pathname === '/product-form') {
          if (!hasAccessToken(request.headers.cookie)) {
            response.writeHead(401, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            response.end(
              '<h1>401 未登录</h1><p>请先通过真实前端完成登录，再用 storageState 复用会话。</p>'
            );
            return;
          }
        }

        const file = path.join(FIXTURE_ROOT, HTML_ROUTES[url.pathname]);
        const html = await fs.readFile(file, 'utf8');
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(html);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/session/set') {
        const name = url.searchParams.get('name') ?? '';
        const value = url.searchParams.get('value') ?? '';
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(name) || !/^[A-Za-z0-9_-]{0,80}$/.test(value)) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('cookie name/value 只允许字母数字下划线');
          return;
        }

        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': `${name}=${value}; Path=/; SameSite=Lax`,
        });
        response.end(`<h1>已设置</h1><p>${name}=${value}</p>`);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/drafts') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, drafts }));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/drafts') {
        const body = JSON.parse(await readBody(request)) as Partial<DraftRecord>;
        if (!body || !body.name) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ ok: false, error: '商品名称不能为空' }));
          return;
        }

        const draft: DraftRecord = {
          id: `draft-${drafts.length + 1}`,
          name: body.name,
          brand: body.brand ?? '',
          price: body.price ?? '',
          stock: body.stock ?? '',
          description: body.description ?? '',
          savedAt: new Date().toISOString(),
        };
        drafts.push(draft);

        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, draft }));
        return;
      }

      if (url.pathname === '/api/counter') {
        if (request.method === 'POST') {
          counter += 1;
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ ok: true, count: counter }));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, count: counter }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/slow') {
        const ms = Math.min(Math.max(Number(url.searchParams.get('ms') ?? 600), 0), 5000);
        await new Promise((resolve) => setTimeout(resolve, ms));
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, delayedMs: ms }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/download/report.csv') {
        const csv = '订单号,客户,金额\nSO-1001,张三,199.00\nSO-1002,李四,88.00\n';
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="report.csv"',
          'Content-Length': Buffer.byteLength(csv),
        });
        response.end(csv);
        return;
      }

      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('404');
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: (error as Error).message }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('靶场端口解析失败');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    drafts,
    counter: () => counter,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
