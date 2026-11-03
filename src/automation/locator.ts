import type { FrameLocator, Locator, Page } from 'playwright';

import { AmbiguousTargetError, ElementNotFoundError } from '../core/errors.js';
import type { ActionTarget, FrameRef } from '../core/types.js';

export type UiRoot = Page | FrameLocator;

/** 用受控的 iframe 属性拼内部选择器；调用方只提供 name / title。 */
export function frameSelector(frame: FrameRef): string {
  if (frame.name) return `iframe[name="${frame.name}"]`;
  if (frame.title) return `iframe[title="${frame.title}"]`;
  throw new ElementNotFoundError('frame 必须提供 name 或 title', { frame });
}

export async function resolveRoot(
  page: Page,
  frame: FrameRef | undefined,
  timeoutMs: number
): Promise<UiRoot> {
  if (!frame) return page;

  const selector = frameSelector(frame);
  const iframe = page.locator(selector).first();

  try {
    await iframe.waitFor({ state: 'attached', timeout: timeoutMs });
  } catch {
    throw new ElementNotFoundError(
      `找不到 iframe（${frame.name ? `name=${frame.name}` : `title=${frame.title}`}）`,
      { frame, selector }
    );
  }

  const matched = page
    .frames()
    .filter((candidate) => {
      if (frame.name) return candidate.name() === frame.name;
      return !candidate.parentFrame();
    })
    .find((candidate) => {
      if (!frame.urlContains) return true;
      return candidate.url().includes(frame.urlContains);
    });

  if (frame.urlContains && !matched) {
    throw new ElementNotFoundError(
      `iframe URL 未包含「${frame.urlContains}」`,
      { frame, urls: page.frames().map((candidate) => candidate.url()) }
    );
  }

  return page.frameLocator(selector);
}

/** 把定位意图翻译成语义 locator —— 全工程唯一的定位入口（支持 frame 作用域）。 */
export function targetLocator(root: UiRoot, target: ActionTarget): Locator {
  if ('role' in target) {
    return root.getByRole(target.role, {
      name: target.name,
      exact: target.exact ?? true,
    });
  }
  return root.getByLabel(target.name, { exact: target.exact ?? true });
}

/**
 * 元素必须可见且唯一：0 个 ELEMENT_NOT_FOUND，>1 个 AMBIGUOUS_TARGET。
 * fail closed，不做「取第一个」的猜测。
 */
export async function resolveTarget(
  root: UiRoot,
  target: ActionTarget,
  timeoutMs: number,
  description: string
): Promise<Locator> {
  const locator = targetLocator(root, target);
  const label = `「${target.name}」`;

  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    const count = await locator.count().catch(() => 0);
    throw new ElementNotFoundError(
      `动作 ${description} 找不到可见元素 ${label}（匹配数=${count}，超时=${timeoutMs}ms）`,
      { target, count }
    );
  }

  const count = await locator.count();
  if (count > 1) {
    throw new AmbiguousTargetError(
      `动作 ${description} 的目标 ${label} 匹配到 ${count} 个元素，拒绝执行（要求唯一）`,
      { target, count }
    );
  }

  return locator.first();
}

/** 可见性过滤：自定义下拉的隐藏 option 不参与唯一性判定。 */
export async function visibleIndexes(locator: Locator): Promise<number[]> {
  const count = await locator.count();
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) result.push(index);
  }
  return result;
}

export async function resolveVisibleOption(
  root: UiRoot,
  name: string,
  exact: boolean,
  timeoutMs: number,
  description: string
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;

  while (Date.now() < deadline) {
    const options = root.getByRole('option', { name, exact });
    const visible = await visibleIndexes(options);
    lastCount = visible.length;

    if (visible.length === 1) return options.nth(visible[0]);
    if (visible.length > 1) {
      throw new AmbiguousTargetError(
        `动作 ${description} 的选项「${name}」匹配到 ${visible.length} 个可见候选，拒绝执行`,
        { name, count: visible.length }
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new ElementNotFoundError(
    `动作 ${description} 在弹出层找不到可见选项「${name}」（最后可见匹配数=${lastCount}，超时=${timeoutMs}ms）`,
    { name, count: lastCount }
  );
}

/** 框架下拉弹出层：内部固定清单，不接受调用方传选择器。 */
export async function visibleOptionsByText(
  root: UiRoot,
  name: string,
  timeoutMs: number,
  description: string
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  let lastState = '无可见选项';

  while (Date.now() < deadline) {
    const candidates = root
      .locator(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, [role="listbox"] [role="option"]'
      )
      .filter({ hasText: name });
    const visible = await visibleIndexes(candidates);
    lastState = `候选=${(await candidates.count().catch(() => 0))}，可见=${visible.length}`;

    if (visible.length === 1) return candidates.nth(visible[0]);
    if (visible.length > 1) {
      throw new AmbiguousTargetError(
        `动作 ${description} 的选项「${name}」匹配到 ${visible.length} 个可见候选，拒绝执行`,
        { name, count: visible.length }
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new ElementNotFoundError(
    `动作 ${description} 在框架弹出层找不到选项「${name}」（${lastState}，超时=${timeoutMs}ms）`,
    { name, lastState }
  );
}
