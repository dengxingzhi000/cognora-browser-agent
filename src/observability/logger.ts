import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  taskId?: string;
  [key: string]: unknown;
}

/**
 * 结构化 JSON Lines 日志。taskId 通过 child() 贯穿任务生命周期。
 * 不引入 pino，避免为了日志再加一层运行时依赖。
 */
export class Logger {
  constructor(
    private readonly base: LogFields,
    private readonly filePath?: string,
    private readonly mirrorToConsole = true
  ) {}

  child(fields: LogFields): Logger {
    return new Logger(
      { ...this.base, ...fields },
      this.filePath,
      this.mirrorToConsole
    );
  }

  info(event: string, fields: LogFields = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write('error', event, fields);
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      ...this.base,
      ...fields,
    };

    const line = JSON.stringify(record);
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${line}\n`, 'utf8');
    }
    if (this.mirrorToConsole) {
      const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      stream(line);
    }
  }
}

export function createLogger(options: {
  artifactsDir: string;
  logToFile: boolean;
  mirrorToConsole?: boolean;
}): Logger {
  const filePath = options.logToFile
    ? path.join(options.artifactsDir, 'logs', 'service.jsonl')
    : undefined;
  return new Logger(
    { service: 'browser-agent' },
    filePath,
    options.mirrorToConsole ?? true
  );
}

export function createSilentLogger(): Logger {
  return new Logger({ service: 'browser-agent-test' }, undefined, false);
}
