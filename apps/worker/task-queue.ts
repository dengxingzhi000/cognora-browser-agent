import type { Logger } from '../../src/observability/logger.js';

export interface QueueJob {
  label: string;
  run: () => Promise<void>;
}

/**
 * 进程内队列：并发上限可配，满员时排队。
 * 任务进入 WAITING_APPROVAL 时 run() 返回、槽位释放，浏览器会话另行保留。
 */
export class TaskQueue {
  private readonly waiting: QueueJob[] = [];
  private running = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly logger: Logger,
    private readonly onError: (job: QueueJob, error: Error) => void
  ) {}

  get stats(): { running: number; queued: number; maxConcurrency: number } {
    return {
      running: this.running,
      queued: this.waiting.length,
      maxConcurrency: this.maxConcurrency,
    };
  }

  enqueue(job: QueueJob): void {
    this.waiting.push(job);
    this.logger.info('queue.enqueued', { job: job.label, ...this.stats });
    this.pump();
  }

  /** 等待当前队列清空（用于优雅关闭与测试）。 */
  drain(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private pump(): void {
    while (this.running < this.maxConcurrency && this.waiting.length > 0) {
      const job = this.waiting.shift();
      if (!job) break;
      this.running += 1;
      this.logger.info('queue.started', { job: job.label, ...this.stats });

      void job
        .run()
        .catch((error: unknown) => {
          this.onError(job, error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          this.running -= 1;
          this.logger.info('queue.finished', { job: job.label, ...this.stats });
          this.pump();
          if (this.running === 0 && this.waiting.length === 0) {
            const resolvers = this.idleResolvers;
            this.idleResolvers = [];
            for (const resolve of resolvers) resolve();
          }
        });
    }
  }
}
