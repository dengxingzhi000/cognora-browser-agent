import path from 'node:path';

import type { Page } from 'playwright';

import { ActionNotAllowedError } from '../core/errors.js';

export function sanitizeForFilename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function captureScreenshot(
  page: Page,
  dir: string,
  index: number,
  description: string,
  suffix = ''
): Promise<string | undefined> {
  const filename = `${String(index).padStart(2, '0')}-${sanitizeForFilename(description)}${suffix}.png`;
  return captureScreenshotAs(page, path.join(dir, filename));
}

export async function captureScreenshotAs(
  page: Page,
  filePath: string
): Promise<string | undefined> {
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch {
    return undefined;
  }
}

/** screenshot 动作只能写入任务自己的截图目录，防止任意路径写入。 */
export function resolveScreenshotPath(dir: string, requested: string): string {
  const root = path.resolve(dir);
  const filePath = path.resolve(root, requested);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new ActionNotAllowedError(`screenshot 的 path 不允许逃出产物目录：${requested}`, {
      requested,
      root,
    });
  }
  return filePath;
}
