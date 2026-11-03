import type { Locator, Page } from 'playwright';

import type { ActionTarget } from '../core/types.js';
import { resolveTarget, type UiRoot } from './locator.js';

/**
 * 表单动作实现。定位统一走语义 locator，调用方不接触选择器。
 * 原生 select 与自定义 combobox 是两种策略，后者在批次 2 扩展。
 */
export class FormHandler {
  constructor(
    private readonly page: Page,
    private readonly actionTimeoutMs: number
  ) {}

  async fill(root: UiRoot, target: ActionTarget, value: string, description: string): Promise<void> {
    const locator = await this.resolve(root, target, description);
    await locator.fill(value, { timeout: this.actionTimeoutMs });
  }

  async select(
    root: UiRoot,
    target: ActionTarget,
    value: string,
    description: string
  ): Promise<void> {
    const locator = await this.resolve(root, target, description);
    await locator.selectOption(value, { timeout: this.actionTimeoutMs });
  }

  async click(root: UiRoot, target: ActionTarget, description: string): Promise<void> {
    const locator = await this.resolve(root, target, description);
    await locator.click({ timeout: this.actionTimeoutMs });
  }

  async resolve(root: UiRoot, target: ActionTarget, description: string): Promise<Locator> {
    return resolveTarget(root, target, this.actionTimeoutMs, description);
  }

  get pageRef(): Page {
    return this.page;
  }
}
