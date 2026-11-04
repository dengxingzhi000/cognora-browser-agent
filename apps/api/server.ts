import Fastify, { type FastifyInstance } from 'fastify';

import { AppError } from '../../src/core/errors.js';
import type { Logger } from '../../src/observability/logger.js';
import type { TaskService } from '../../src/tasks/task-service.js';
import { listTools } from '../../src/tools/registry.js';
import type { WorkflowRegistry } from '../../src/workflows/index.js';

export interface ApiDeps {
  service: TaskService;
  workflows: WorkflowRegistry;
  logger: Logger;
}

/**
 * HTTP 入口。使用 Fastify.inject 做集成测试（等价于 supertest 的进程内请求）。
 * 本轮不提供鉴权：默认只监听 127.0.0.1，部署时必须放在受控网络/网关之后。
 */
export function createApiApp(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
  });

  app.get('/healthz', async () => ({ ok: true, ownerId: deps.service.instanceId }));

  app.get('/api/v1/browser/tools', async () => ({ tools: listTools() }));

  app.get('/api/v1/browser/workflows', async () => ({ workflows: deps.workflows.list() }));

  app.post('/api/v1/browser/tasks', async (request, reply) => {
    const task = await deps.service.create(request.body);
    await deps.service.flush();
    return reply.status(201).send({
      taskId: task.taskId,
      status: task.status,
      taskType: task.taskType,
      executionMode: task.executionMode,
    });
  });

  app.get('/api/v1/browser/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await deps.service.flush();
    return reply.send(await deps.service.viewAsync(id));
  });

  app.get('/api/v1/browser/tasks/:id/steps', async (request, reply) => {
    const { id } = request.params as { id: string };
    await deps.service.flush();
    return reply.send(await deps.service.stepsAsync(id));
  });

  app.post('/api/v1/browser/tasks/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await deps.service.approve(id, request.body);
    await deps.service.flush();
    if ('approval' in result) return reply.status(202).send(result);
    return reply.send({ taskId: result.taskId, status: result.status });
  });

  app.post('/api/v1/browser/tasks/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await deps.service.reject(id, request.body);
    await deps.service.flush();
    if ('approval' in result) return reply.status(202).send(result);
    return reply.send({ taskId: result.taskId, status: result.status });
  });

  app.post('/api/v1/browser/tasks/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await deps.service.cancel(id);
    await deps.service.flush();
    if ('approval' in result) return reply.status(202).send(result);
    return reply.send({ taskId: result.taskId, status: result.status });
  });

  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as Error & { statusCode?: number; stack?: string };
    if (rawError instanceof AppError) {
      deps.logger.warn('api.error', {
        code: rawError.code,
        statusCode: rawError.statusCode,
        path: request.url,
        message: rawError.message,
      });
      return reply.status(rawError.statusCode).send({
        error: {
          code: rawError.code,
          message: rawError.message,
          details: rawError.details,
        },
      });
    }

    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (statusCode < 500) {
      return reply.status(statusCode).send({
        error: {
          code: 'INVALID_INPUT',
          message: error.message,
        },
      });
    }

    deps.logger.error('api.unhandled_error', {
      path: request.url,
      message: error.message,
      stack: error.stack,
    });
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务内部错误',
      },
    });
  });

  return app;
}
