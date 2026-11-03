import type { Page } from 'playwright';

import type { ActionTarget, Expectation, ValidationResult } from '../core/types.js';
import { resolveRoot, targetLocator, type UiRoot } from '../automation/locator.js';

const POLL_INTERVAL_MS = 150;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** select 的期望值允许精确命中 option 的 value 或可见 label，二者都记录在结果里。 */
export function matchesSelectExpected(expected: string, value: string, label: string): boolean {
  return expected === value || expected === label;
}

/**
 * 状态校验：不信任「Playwright 没抛异常」。
 * 回读真实 DOM 值 / 可见提示 / URL / 列表 / cookie，失败时给出期望与实际。
 */
export class StateValidator {
  constructor(
    private readonly page: Page,
    private readonly timeoutMs: number
  ) {}

  private async poll<T>(
    probe: () => Promise<{ ok: boolean; value: T }>,
    timeoutMs = this.timeoutMs
  ): Promise<{ ok: boolean; value: T }> {
    const deadline = Date.now() + timeoutMs;
    let last: { ok: boolean; value: T } = { ok: false, value: undefined as T };

    while (Date.now() < deadline) {
      try {
        last = await probe();
        if (last.ok) return last;
      } catch {
        /* 元素尚未就绪，继续轮询 */
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return last;
  }

  async checkInputValue(
    root: UiRoot,
    target: ActionTarget,
    expected: string
  ): Promise<ValidationResult> {
    const locator = targetLocator(root, target);
    try {
      const actual = await locator.first().inputValue({ timeout: this.timeoutMs });
      return {
        ok: actual === expected,
        kind: 'value-readback',
        expected,
        actual,
        detail: '回读 inputValue（逐字比对，不做 trim）',
      };
    } catch (error) {
      return {
        ok: false,
        kind: 'value-readback',
        expected,
        actual: `(读取失败: ${(error as Error).message})`,
        detail: '回读 inputValue',
      };
    }
  }

  async checkSelected(
    root: UiRoot,
    target: ActionTarget,
    expected: string
  ): Promise<ValidationResult> {
    const locator = targetLocator(root, target);
    try {
      const actual = await locator.first().evaluate((element) => {
        const select = element as HTMLSelectElement;
        const option = select.selectedOptions[0];
        return { value: select.value, label: option?.label ?? '' };
      });

      return {
        ok: matchesSelectExpected(expected, actual.value, actual.label),
        kind: 'selected-readback',
        expected: `${expected}（option value 或 label 精确匹配）`,
        actual: `value=${actual.value}, label=${actual.label}`,
        detail: '回读 selectedOptions',
      };
    } catch (error) {
      return {
        ok: false,
        kind: 'selected-readback',
        expected,
        actual: `(读取失败: ${(error as Error).message})`,
        detail: '回读 selectedOptions',
      };
    }
  }

  /** 自定义 combobox 回读：优先触发器自身文本，其次 AntD 的 selection-item。 */
  async checkCustomSelect(
    root: UiRoot,
    target: ActionTarget,
    expectedLabel: string
  ): Promise<ValidationResult> {
    const trigger = targetLocator(root, target);
    try {
      const raw = await trigger.first().evaluate((element) => {
        const html = element as HTMLElement;
        const own = (html.innerText ?? '').replace(/\s+/g, ' ').trim();
        if (own) return own;

        const selection = html
          .closest('.ant-select')
          ?.querySelector('.ant-select-selection-item');
        if (selection?.textContent) return selection.textContent;

        return (html.parentElement?.textContent ?? '').replace(/\s+/g, ' ').trim();
      });

      const actual = normalize(raw);
      return {
        ok: actual === normalize(expectedLabel) || actual.includes(normalize(expectedLabel)),
        kind: 'custom-select-readback',
        expected: `触发器文本包含「${expectedLabel}」`,
        actual,
        detail: '回读 combobox 触发器文本（兼容 Radix / AntD）',
      };
    } catch (error) {
      return {
        ok: false,
        kind: 'custom-select-readback',
        expected: `触发器文本包含「${expectedLabel}」`,
        actual: `(读取失败: ${(error as Error).message})`,
        detail: '回读 combobox 触发器文本',
      };
    }
  }

  async checkStatus(root: UiRoot, text: string, exact = true): Promise<ValidationResult> {
    const result = await this.poll(async () => {
      const status = root.getByRole('status');
      const count = await status.count();
      if (count === 0) return { ok: false, value: '(页面上没有 role=status 元素)' };

      const visible = await status.first().isVisible();
      const actual = normalize(await status.first().innerText());
      const matched = exact ? actual === normalize(text) : actual.includes(normalize(text));
      return { ok: visible && matched, value: visible ? actual : `(元素存在但不可见) ${actual}` };
    });

    return {
      ok: result.ok,
      kind: 'status-message',
      expected: `${exact ? '精确' : '包含'}文本「${text}」且可见`,
      actual: result.value,
      detail: '页面 role=status 提示',
    };
  }

  async checkText(root: UiRoot, text: string, exact = true): Promise<ValidationResult> {
    const result = await this.poll(async () => {
      const locator = root.getByText(text, { exact });
      const count = await locator.count();
      if (count === 0) return { ok: false, value: '(未找到匹配文本)' };
      const visible = await locator.first().isVisible();
      return {
        ok: visible,
        value: visible ? normalize(await locator.first().innerText()) : '(存在但不可见)',
      };
    });

    return {
      ok: result.ok,
      kind: 'text-visible',
      expected: `可见文本「${text}」`,
      actual: result.value,
      detail: '页面文本断言',
    };
  }

  async checkUrl(pattern: string): Promise<ValidationResult> {
    const result = await this.poll(async () => {
      const url = this.page.url();
      return { ok: url.includes(pattern), value: url };
    });

    return {
      ok: result.ok,
      kind: 'url',
      expected: `URL 包含「${pattern}」`,
      actual: result.value,
      detail: '当前页面 URL',
    };
  }

  async checkList(root: UiRoot, container: ActionTarget, contains: string): Promise<ValidationResult> {
    const result = await this.poll(async () => {
      const list = targetLocator(root, container);
      if ((await list.count()) === 0) return { ok: false, value: '(列表容器不存在)' };

      const cell = list.first().getByText(contains, { exact: false });
      if ((await cell.count()) === 0) {
        return { ok: false, value: normalize(await list.first().innerText()).slice(0, 120) };
      }
      const visible = await cell.first().isVisible();
      return {
        ok: visible,
        value: normalize(await list.first().innerText()).slice(0, 120),
      };
    });

    return {
      ok: result.ok,
      kind: 'list-row',
      expected: `列表中出现「${contains}」`,
      actual: result.value,
      detail: '列表回查',
    };
  }

  async checkCookie(name: string, present: boolean): Promise<ValidationResult> {
    const cookies = await this.page.context().cookies();
    const cookie = cookies.find((item) => item.name === name);
    const actual = cookie
      ? `存在（domain=${cookie.domain}, path=${cookie.path}, httpOnly=${cookie.httpOnly}）`
      : '不存在';

    return {
      ok: present ? Boolean(cookie) : !cookie,
      kind: 'cookie',
      expected: `cookie ${name} ${present ? '存在' : '不存在'}`,
      actual,
      detail: 'context.cookies()',
    };
  }

  async run(expectation: Expectation, defaultRoot: UiRoot): Promise<ValidationResult> {
    switch (expectation.type) {
      case 'status': {
        const root = expectation.frame
          ? await resolveRoot(this.page, expectation.frame, this.timeoutMs)
          : defaultRoot;
        return this.checkStatus(root, expectation.text, expectation.exact ?? true);
      }
      case 'text': {
        const root = expectation.frame
          ? await resolveRoot(this.page, expectation.frame, this.timeoutMs)
          : defaultRoot;
        return this.checkText(root, expectation.text, expectation.exact ?? true);
      }
      case 'url':
        return this.checkUrl(expectation.pattern);
      case 'list': {
        const root = expectation.container.frame
          ? await resolveRoot(this.page, expectation.container.frame, this.timeoutMs)
          : defaultRoot;
        return this.checkList(root, expectation.container, expectation.contains);
      }
      case 'cookie':
        return this.checkCookie(expectation.name, expectation.present);
    }
  }
}
