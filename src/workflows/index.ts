import { InvalidInputError } from '../core/errors.js';
import type { ActionIntent } from '../core/types.js';
import type { ServiceConfig } from '../config/config.js';
import type { TaskTarget, WorkflowPlan } from '../tasks/task-types.js';

export interface WorkflowContext {
  config: ServiceConfig;
  target: TaskTarget;
  tenantId: string;
  userId: string;
  taskType: string;
  input: Record<string, unknown>;
}

export interface WorkflowDefinition {
  taskType: string;
  description: string;
  build: (ctx: WorkflowContext) => WorkflowPlan;
}

export class WorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>();

  constructor(definitions: WorkflowDefinition[]) {
    for (const definition of definitions) {
      this.definitions.set(definition.taskType, definition);
    }
  }

  build(taskType: string, ctx: WorkflowContext): WorkflowPlan {
    const definition = this.definitions.get(taskType);
    if (!definition) {
      throw new InvalidInputError(
        `未知 taskType「${taskType}」，可用：${this.list()
          .map((item) => item.taskType)
          .join(', ')}`,
        { taskType }
      );
    }
    return definition.build(ctx);
  }

  list(): Array<{ taskType: string; description: string }> {
    return [...this.definitions.values()].map(({ taskType, description }) => ({
      taskType,
      description,
    }));
  }
}

export function baseUrl(ctx: WorkflowContext): string {
  return ctx.target.url.replace(/\/+$/, '');
}

export function requireString(
  input: Record<string, unknown>,
  field: string,
  options: { required?: boolean; fallback?: string; maxLength?: number } = {}
): string {
  const value = input[field];

  if (value === undefined || value === null || value === '') {
    if (options.required) {
      throw new InvalidInputError(`input.${field} 必填且必须是非空字符串`, { field });
    }
    return options.fallback ?? '';
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new InvalidInputError(`input.${field} 必须是字符串或数字`, { field, value });
  }

  const text = String(value);
  if (text.length > (options.maxLength ?? 2000)) {
    throw new InvalidInputError(`input.${field} 超过长度上限`, { field });
  }
  return text;
}

export function asIntents(value: unknown, field = 'actions'): ActionIntent[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidInputError(`input.${field} 必须是非空动作数组`, { field });
  }
  return value as ActionIntent[];
}
