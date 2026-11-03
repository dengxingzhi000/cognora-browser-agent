import path from 'node:path';

import type { Page } from 'playwright';

import { captureScreenshotAs, sanitizeForFilename } from './screenshot.js';

export interface PageSnapshot {
  url: string;
  title: string;
  screenshotPath?: string;
  textSample: string;
}

export async function capturePageSnapshot(
  page: Page,
  dir: string,
  label: string
): Promise<PageSnapshot> {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const textSample = await page
    .locator('body')
    .innerText()
    .then((text) => text.replace(/\s+/g, ' ').trim().slice(0, 300))
    .catch(() => '');

  const screenshotPath = await captureScreenshotAs(
    page,
    path.join(dir, `${sanitizeForFilename(label)}.png`)
  );

  return { url, title, screenshotPath, textSample };
}
