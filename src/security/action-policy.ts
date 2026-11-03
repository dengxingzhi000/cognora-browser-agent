import path from 'node:path';

import { ActionNotAllowedError } from '../core/errors.js';
import type {
  ActionIntent,
  ActionTarget,
  Expectation,
  FrameRef,
  WaitSpec,
} from '../core/types.js';
import type { DomainPolicy } from './domain-policy.js';
import { ALLOWED_ACTIONS, ALLOWED_ROLES } from '../tools/registry.js';

const MAX_STEPS = 200;
const MAX_URL_LENGTH = 2048;
const FORBIDDEN_KEYS = new Set([
  'script',
  'evaluate',
  'expression',
  'pageFunction',
  'function',
  'code',
  'selector',
  'xpath',
  'coordinate',
  'x',
  'y',
]);
const SAFE_FRAME_REF = /^[^"'\\[\]<>]{1,64}$/;
const SAFE_FILE_NAME = /^[A-Za-z0-9._\-\u4e00-\u9fa5]{1,120}$/;

/**
 * 结构化意图校验：
 * 1) 动作 / role 必须在白名单内；
 * 2) 不允许任意脚本、原始选择器、坐标等字段（递归扫描）；
 * 3) 所有字符串字段做长度限制，避免把大对象塞进执行层。
 */
export function assertNoForbiddenKeys(value: unknown, pathParts: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, [...pathParts, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ActionNotAllowedError(
        `动作意图包含禁止字段「${[...pathParts, key].join('.')}」：执行层不接受脚本 / 选择器 / 坐标`,
        { field: [...pathParts, key].join('.'), action: 'schema' }
      );
    }
    assertNoForbiddenKeys(child, [...pathParts, key]);
  }
}

function assertNonEmptyString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ActionNotAllowedError(`字段 ${field} 必须是非空字符串`, { field });
  }
  if (value.length > maxLength) {
    throw new ActionNotAllowedError(`字段 ${field} 超过长度上限 ${maxLength}`, { field });
  }
  return value;
}

export function validateFrameRef(frame: unknown): FrameRef | undefined {
  if (frame === undefined) return undefined;
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new ActionNotAllowedError('frame 必须是对象', { frame });
  }

  const ref = frame as Record<string, unknown>;
  const result: FrameRef = {};

  if (ref.name !== undefined) {
    if (typeof ref.name !== 'string' || !SAFE_FRAME_REF.test(ref.name)) {
      throw new ActionNotAllowedError(
        'frame.name 只能是 1-64 位不含引号 / 方括号 / 尖括号的字符',
        { frame }
      );
    }
    result.name = ref.name;
  }

  if (ref.title !== undefined) {
    if (typeof ref.title !== 'string' || !SAFE_FRAME_REF.test(ref.title)) {
      throw new ActionNotAllowedError(
        'frame.title 只能是 1-64 位不含引号 / 方括号 / 尖括号的字符',
        { frame }
      );
    }
    result.title = ref.title;
  }

  if (ref.urlContains !== undefined) {
    result.urlContains = assertNonEmptyString(ref.urlContains, 'frame.urlContains', MAX_URL_LENGTH);
  }

  if (!result.name && !result.title) {
    throw new ActionNotAllowedError('frame 必须提供 name 或 title（不接受原始 CSS 选择器）', {
      frame,
    });
  }

  return result;
}

export function validateTarget(target: unknown): ActionTarget {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new ActionNotAllowedError('target 必须是对象', { target });
  }

  const raw = target as Record<string, unknown>;
  const name = assertNonEmptyString(raw.name, 'target.name', 200);
  const exact = raw.exact === undefined ? undefined : Boolean(raw.exact);
  const frame = validateFrameRef(raw.frame);

  if (raw.by === 'label') {
    return { by: 'label', name, ...(exact === undefined ? {} : { exact }), ...(frame ? { frame } : {}) };
  }

  if (!raw.role || !(ALLOWED_ROLES as readonly string[]).includes(String(raw.role))) {
    throw new ActionNotAllowedError(
      `role「${String(raw.role ?? '(空)')}」不在白名单 ${ALLOWED_ROLES.join(', ')} 内`,
      { target }
    );
  }

  return {
    role: raw.role as ActionTarget extends { role: infer R } ? R : never,
    name,
    ...(exact === undefined ? {} : { exact }),
    ...(frame ? { frame } : {}),
  };
}

export function validateWaitSpec(wait: unknown): WaitSpec {
  if (!wait || typeof wait !== 'object' || Array.isArray(wait)) {
    throw new ActionNotAllowedError('waitFor 必须是对象', { wait });
  }

  const raw = wait as Record<string, unknown>;
  if (raw.type === 'response') {
    const urlContains = assertNonEmptyString(raw.urlContains, 'waitFor.urlContains', MAX_URL_LENGTH);
    const method =
      raw.method === undefined ? undefined : assertNonEmptyString(raw.method, 'waitFor.method', 10).toUpperCase();
    const statusBelow = raw.statusBelow === undefined ? undefined : Number(raw.statusBelow);
    if (statusBelow !== undefined && (!Number.isFinite(statusBelow) || statusBelow < 100 || statusBelow > 599)) {
      throw new ActionNotAllowedError('waitFor.statusBelow 必须是 100-599', { wait });
    }
    const timeoutMs = optionalTimeout(raw.timeoutMs, 'waitFor.timeoutMs');
    return {
      type: 'response',
      urlContains,
      ...(method ? { method } : {}),
      ...(statusBelow !== undefined ? { statusBelow } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  }

  if (raw.type === 'hidden') {
    const timeoutMs = optionalTimeout(raw.timeoutMs, 'waitFor.timeoutMs');
    const appearTimeoutMs = optionalTimeout(raw.appearTimeoutMs, 'waitFor.appearTimeoutMs');
    return {
      type: 'hidden',
      target: validateTarget(raw.target),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(appearTimeoutMs !== undefined ? { appearTimeoutMs } : {}),
    };
  }

  throw new ActionNotAllowedError('waitFor.type 只能是 response / hidden', { wait });
}

function optionalTimeout(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 120000) {
    throw new ActionNotAllowedError(`${field} 必须是 100-120000 的数字`, { field, value });
  }
  return parsed;
}

export function validateExpectations(expect: unknown): Expectation | Expectation[] | undefined {
  if (expect === undefined) return undefined;
  const list = Array.isArray(expect) ? expect : [expect];
  if (list.length > 20) {
    throw new ActionNotAllowedError('expect 最多 20 条', { count: list.length });
  }

  const validated = list.map((item) => validateExpectation(item));
  return Array.isArray(expect) ? validated : validated[0];
}

function validateExpectation(value: unknown): Expectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActionNotAllowedError('expect 必须是对象', { expect: value });
  }

  const raw = value as Record<string, unknown>;
  switch (raw.type) {
    case 'status':
      return {
        type: 'status',
        text: assertNonEmptyString(raw.text, 'expect.text', 200),
        ...(raw.exact === undefined ? {} : { exact: Boolean(raw.exact) }),
        ...(raw.frame === undefined ? {} : { frame: validateFrameRef(raw.frame) }),
      };
    case 'text':
      return {
        type: 'text',
        text: assertNonEmptyString(raw.text, 'expect.text', 500),
        ...(raw.exact === undefined ? {} : { exact: Boolean(raw.exact) }),
        ...(raw.frame === undefined ? {} : { frame: validateFrameRef(raw.frame) }),
      };
    case 'url':
      return { type: 'url', pattern: assertNonEmptyString(raw.pattern, 'expect.pattern', MAX_URL_LENGTH) };
    case 'list':
      return {
        type: 'list',
        container: validateTarget(raw.container),
        contains: assertNonEmptyString(raw.contains, 'expect.contains', 200),
      };
    case 'cookie':
      return {
        type: 'cookie',
        name: assertNonEmptyString(raw.name, 'expect.name', 120),
        present: Boolean(raw.present),
      };
    default:
      throw new ActionNotAllowedError(
        `expect.type「${String(raw.type ?? '(空)')}」不在白名单 status / text / url / list / cookie 内`,
        { expect: value }
      );
  }
}

export function validateActionIntent(value: unknown): ActionIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActionNotAllowedError('动作意图必须是对象', { intent: value });
  }

  assertNoForbiddenKeys(value);
  const raw = value as Record<string, unknown>;
  const action = raw.action;

  if (!action || !(ALLOWED_ACTIONS as readonly string[]).includes(String(action))) {
    throw new ActionNotAllowedError(
      `动作「${String(action ?? '(空)')}」不在白名单 ${ALLOWED_ACTIONS.join(', ')} 内`,
      { action }
    );
  }

  const base = {
    ...(typeof raw.note === 'string' ? { note: raw.note.slice(0, 500) } : {}),
    ...(raw.expect === undefined ? {} : { expect: validateExpectations(raw.expect) }),
  };

  let intent: ActionIntent;

  switch (action) {
    case 'goto': {
      const url = assertNonEmptyString(raw.url, 'url', MAX_URL_LENGTH);
      intent = { action: 'goto', url, ...base };
      break;
    }
    case 'fill': {
      intent = {
        action: 'fill',
        target: validateTarget(raw.target),
        value: assertNonEmptyString(raw.value, 'value', 2000),
        ...base,
      };
      break;
    }
    case 'select': {
      intent = {
        action: 'select',
        target: validateTarget(raw.target),
        value: assertNonEmptyString(raw.value, 'value', 200),
        ...base,
      };
      break;
    }
    case 'click': {
      intent = {
        action: 'click',
        target: validateTarget(raw.target),
        ...(raw.approvalRequired === undefined
          ? {}
          : { approvalRequired: Boolean(raw.approvalRequired) }),
        ...base,
      };
      break;
    }
    case 'selectCustom': {
      if (!raw.option || typeof raw.option !== 'object' || Array.isArray(raw.option)) {
        throw new ActionNotAllowedError('selectCustom 必须提供 option 对象', { option: raw.option });
      }
      const option = raw.option as Record<string, unknown>;
      const optionName = assertNonEmptyString(option.name, 'option.name', 200);
      const by = option.by ?? 'role';
      if (by !== 'role' && by !== 'text') {
        throw new ActionNotAllowedError('option.by 只能是 role / text', { by });
      }
      intent = {
        action: 'selectCustom',
        target: validateTarget(raw.target),
        option: {
          name: optionName,
          ...(option.exact === undefined ? {} : { exact: Boolean(option.exact) }),
          by,
        },
        ...base,
      };
      break;
    }
    case 'upload': {
      if (!Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > 5) {
        throw new ActionNotAllowedError('upload.files 必须是 1-5 个文件路径', {
          files: raw.files,
        });
      }
      const files = raw.files.map((file, index) =>
        assertNonEmptyString(file, `files[${index}]`, 300)
      );
      intent = {
        action: 'upload',
        target: validateTarget(raw.target),
        files,
        ...base,
      };
      break;
    }
    case 'download': {
      const saveAs =
        raw.saveAs === undefined
          ? undefined
          : assertNonEmptyString(raw.saveAs, 'saveAs', 120);
      if (saveAs) assertSafeDownloadName(saveAs);
      intent = {
        action: 'download',
        target: validateTarget(raw.target),
        ...(saveAs ? { saveAs } : {}),
        ...base,
      };
      break;
    }
    case 'waitForResponse': {
      const urlContains = assertNonEmptyString(raw.urlContains, 'urlContains', MAX_URL_LENGTH);
      const method =
        raw.method === undefined
          ? undefined
          : assertNonEmptyString(raw.method, 'method', 10).toUpperCase();
      const statusBelow = raw.statusBelow === undefined ? undefined : Number(raw.statusBelow);
      if (
        statusBelow !== undefined &&
        (!Number.isFinite(statusBelow) || statusBelow < 100 || statusBelow > 599)
      ) {
        throw new ActionNotAllowedError('statusBelow 必须是 100-599', { statusBelow });
      }
      const timeoutMs = optionalTimeout(raw.timeoutMs, 'timeoutMs');
      intent = {
        action: 'waitForResponse',
        urlContains,
        ...(method ? { method } : {}),
        ...(statusBelow !== undefined ? { statusBelow } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...base,
      };
      break;
    }
    case 'waitForHidden': {
      const timeoutMs = optionalTimeout(raw.timeoutMs, 'timeoutMs');
      intent = {
        action: 'waitForHidden',
        target: validateTarget(raw.target),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...base,
      };
      break;
    }
    case 'screenshot': {
      if (raw.path !== undefined && typeof raw.path !== 'string') {
        throw new ActionNotAllowedError('screenshot.path 必须是字符串', { path: raw.path });
      }
      intent = {
        action: 'screenshot',
        ...(raw.path ? { path: raw.path } : {}),
        ...base,
      };
      break;
    }
    default:
      throw new ActionNotAllowedError(`动作「${String(action)}」未实现`, { action });
  }

  const waits = normalizeWaits(raw.waitFor).map(validateWaitSpec);
  return waits.length ? { ...intent, waitFor: Array.isArray(raw.waitFor) ? waits : waits[0] } : intent;
}

export function normalizeWaits(waitFor: unknown): unknown[] {
  if (waitFor === undefined) return [];
  return Array.isArray(waitFor) ? waitFor : [waitFor];
}

/** 计划级校验：逐条校验 + 所有 goto 目标先过域名白名单。 */
export function validatePlan(value: unknown, domainPolicy: DomainPolicy): ActionIntent[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ActionNotAllowedError('动作计划必须是非空数组', { length: 0 });
  }
  if (value.length > MAX_STEPS) {
    throw new ActionNotAllowedError(`动作计划最多 ${MAX_STEPS} 步，当前 ${value.length}`, {
      length: value.length,
    });
  }

  return value.map((item, index) => {
    const intent = validateActionIntent(item);
    if (intent.action === 'goto') {
      domainPolicy.assertAllowed(intent.url, `第 ${index + 1} 步导航`);
    }
    return intent;
  });
}

/** 下载落盘文件名只允许单段文件名，禁止路径穿越。 */
export function assertSafeDownloadName(name: string): void {
  if (!SAFE_FILE_NAME.test(name) || name.includes('..')) {
    throw new ActionNotAllowedError(
      `下载文件名「${name}」不合法：只允许单段文件名，禁止路径分隔符与 ..`,
      { name }
    );
  }
}

/** 上传文件必须位于配置的上传根目录内，避免任意文件读取。 */
export function assertUploadPathWithin(root: string, filePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(resolvedRoot, filePath);
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ActionNotAllowedError(`上传文件必须位于 ${resolvedRoot} 内：${filePath}`, {
      filePath,
      uploadRoot: resolvedRoot,
    });
  }
  return resolvedFile;
}
