import fs from 'node:fs';
import path from 'node:path';

import type { Locator, Page } from 'playwright';

import { UploadRejectedError } from '../core/errors.js';
import type { ActionTarget, ValidationResult } from '../core/types.js';
import {
  assertSafeDownloadName,
  assertUploadPathWithin,
} from '../security/action-policy.js';
import {
  resolveTarget,
  resolveVisibleOption,
  visibleOptionsByText,
  type UiRoot,
} from './locator.js';

export interface AdvancedActionOptions {
  actionTimeoutMs: number;
  uploadRoot: string;
  uploadAllowedExtensions: string[];
  uploadMaxBytes: number;
  downloadMaxBytes: number;
  downloadAllowedExtensions: string[];
  downloadsDir: string;
}

/**
 * 批次 2 交互能力：自定义 combobox、文件上传 / 下载。
 * 与基础表单动作分开，避免把浏览器会话层和文件系统策略耦合成一个大类。
 */
export class AdvancedActions {
  constructor(
    private readonly page: Page,
    private readonly options: AdvancedActionOptions
  ) {}

  /** 自定义 combobox 两步策略：点触发器 → 按 role / 文本点选项。 */
  async selectCustom(
    root: UiRoot,
    target: ActionTarget,
    option: { name: string; exact?: boolean; by?: 'role' | 'text' },
    description: string
  ): Promise<void> {
    const trigger = await this.resolve(root, target, description);
    await trigger.click({ timeout: this.options.actionTimeoutMs });

    const candidate =
      option.by === 'text'
        ? await visibleOptionsByText(
            root,
            option.name,
            this.options.actionTimeoutMs,
            description
          )
        : await resolveVisibleOption(
            root,
            option.name,
            option.exact ?? true,
            this.options.actionTimeoutMs,
            description
          );

    await candidate.click({ timeout: this.options.actionTimeoutMs });
  }

  /** 上传：路径必须在配置根目录内；校验存在、类型、大小后再 setInputFiles。 */
  async upload(
    root: UiRoot,
    target: ActionTarget,
    files: string[],
    description: string
  ): Promise<ValidationResult> {
    const locator = await this.resolve(root, target, description);
    const expectedNames: string[] = [];
    const resolvedFiles: string[] = [];

    for (const file of files) {
      const resolved = assertUploadPathWithin(this.options.uploadRoot, file);
      this.assertUploadFile(resolved);
      resolvedFiles.push(resolved);
      expectedNames.push(path.basename(resolved));
    }

    await locator.setInputFiles(resolvedFiles, { timeout: this.options.actionTimeoutMs });

    const actualNames = await locator.evaluate((element) => {
      const input = element as HTMLInputElement;
      return Array.from(input.files ?? []).map((file) => file.name);
    });

    const ok =
      actualNames.length === expectedNames.length &&
      expectedNames.every((name, index) => actualNames[index] === name);

    return {
      ok,
      kind: 'file-selected',
      expected: expectedNames.join(', '),
      actual: actualNames.length ? `已选择：${actualNames.join(', ')}` : '未选择文件',
      detail: `setInputFiles；上传根目录=${this.options.uploadRoot}`,
    };
  }

  /** 下载：落盘到任务 downloads 目录，校验扩展名与大小，并记录实际文件名。 */
  async download(
    root: UiRoot,
    target: ActionTarget,
    saveAs: string | undefined,
    description: string
  ): Promise<ValidationResult & { filePath?: string }> {
    const locator = await this.resolve(root, target, description);

    const [download] = await Promise.all([
      this.page.waitForEvent('download', { timeout: this.options.actionTimeoutMs }),
      locator.click({ timeout: this.options.actionTimeoutMs }),
    ]);

    const suggested = download.suggestedFilename();
    const filename = this.resolveDownloadName(saveAs, suggested);
    const filePath = path.join(this.options.downloadsDir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await download.saveAs(filePath);

    const stat = fs.statSync(filePath);
    const extension = path.extname(filename).toLowerCase();
    const typeOk = this.options.downloadAllowedExtensions.includes(extension);
    const sizeOk = stat.size > 0 && stat.size <= this.options.downloadMaxBytes;
    const ok = typeOk && sizeOk;

    return {
      ok,
      kind: 'download',
      expected: `扩展名 ${this.options.downloadAllowedExtensions.join('/')}，大小 1-${this.options.downloadMaxBytes} bytes`,
      actual: `${suggested} → ${filename}（${stat.size} bytes，${extension || '无扩展名'}）`,
      detail: filePath,
      filePath,
    };
  }

  private async resolve(
    root: UiRoot,
    target: ActionTarget,
    description: string
  ): Promise<Locator> {
    return resolveTarget(root, target, this.options.actionTimeoutMs, description);
  }

  private assertUploadFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new UploadRejectedError(`上传文件不存在：${filePath}`, { filePath, reason: 'missing' });
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new UploadRejectedError(`上传目标不是文件：${filePath}`, {
        filePath,
        reason: 'not_a_file',
      });
    }
    if (stat.size > this.options.uploadMaxBytes) {
      throw new UploadRejectedError(
        `上传文件超过大小上限：${stat.size} > ${this.options.uploadMaxBytes} bytes`,
        { filePath, size: stat.size, maxBytes: this.options.uploadMaxBytes }
      );
    }

    const extension = path.extname(filePath).toLowerCase();
    if (!this.options.uploadAllowedExtensions.includes(extension)) {
      throw new UploadRejectedError(
        `上传文件类型不允许：${extension || '(无扩展名)'}，允许 ${this.options.uploadAllowedExtensions.join('/')}`,
        { filePath, extension, allowed: this.options.uploadAllowedExtensions }
      );
    }
  }

  private resolveDownloadName(saveAs: string | undefined, suggested: string): string {
    if (saveAs) {
      assertSafeDownloadName(saveAs);
      return saveAs;
    }

    const base = path.basename(suggested).replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]+/g, '_');
    if (!base) return 'download.bin';
    assertSafeDownloadName(base);
    return base;
  }
}
