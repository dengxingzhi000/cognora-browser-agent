import fs from 'node:fs';
import path from 'node:path';

import { computeTotals } from '../core/types.js';
import type { TaskRecord } from '../tasks/task-types.js';

/**
 * 任务产物目录：截图、下载、任务级汇总 JSON。
 * 这些 JSON 是运行快照，不是数据库；进程重启后不会被加载。
 */
export class TaskArtifacts {
  constructor(private readonly rootDir: string) {}

  taskDir(taskId: string): string {
    return path.join(this.rootDir, 'tasks', sanitizeSegment(taskId));
  }

  screenshotsDir(taskId: string): string {
    return path.join(this.taskDir(taskId), 'screenshots');
  }

  downloadsDir(taskId: string): string {
    return path.join(this.taskDir(taskId), 'downloads');
  }

  ensureTaskDirs(taskId: string): void {
    fs.mkdirSync(this.screenshotsDir(taskId), { recursive: true });
    fs.mkdirSync(this.downloadsDir(taskId), { recursive: true });
  }

  summaryPath(taskId: string): string {
    return path.join(this.taskDir(taskId), 'task.json');
  }

  writeTaskSummary(task: TaskRecord): string {
    const file = this.summaryPath(task.taskId);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const snapshot = {
      taskId: task.taskId,
      taskType: task.taskType,
      tenantId: task.tenantId,
      userId: task.userId,
      target: task.target,
      executionMode: task.executionMode,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      durationMs:
        task.startedAt && task.finishedAt
          ? new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime()
          : undefined,
      steps: task.steps,
      totals: computeTotals(task.steps),
      approvals: task.approvals,
      pendingApproval: task.pendingApproval,
      sessionSummary: task.sessionSummary,
      policyViolations: task.policyViolations,
      error: task.error,
      note: '运行快照；进程重启后不会加载或恢复任务状态。',
    };

    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(temp, file);
    return file;
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'task';
}
