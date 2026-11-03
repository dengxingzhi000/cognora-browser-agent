import type { ActionName, RoleName } from '../core/types.js';

/**
 * 工具注册表：动作白名单的单一来源。
 * 未来把执行层接回 Agent 时，也只暴露这里的工具名与结构化参数。
 */
export interface BrowserToolDefinition {
  name: ActionName;
  description: string;
  /** 在 require_approval 模式下，命中敏感名字时由审批闸门拦截 */
  mayBeSensitive: boolean;
}

export const BROWSER_TOOLS: readonly BrowserToolDefinition[] = [
  { name: 'goto', description: '导航到白名单内的 URL', mayBeSensitive: false },
  { name: 'fill', description: '按 role / label 定位并填写文本', mayBeSensitive: false },
  { name: 'select', description: '原生 select 选项选择并回读', mayBeSensitive: false },
  {
    name: 'selectCustom',
    description: '自定义 combobox（Radix / AntD）两步选择：点触发器 → 点弹出层选项 → 回读',
    mayBeSensitive: false,
  },
  { name: 'click', description: '按 role / label 定位并点击', mayBeSensitive: true },
  { name: 'upload', description: 'setInputFiles 上传白名单目录内的文件', mayBeSensitive: false },
  {
    name: 'download',
    description: '点击下载并落盘，校验文件名 / 扩展名 / 大小',
    mayBeSensitive: false,
  },
  {
    name: 'waitForResponse',
    description: '等待指定 API 响应（URL / 方法 / 状态码）完成',
    mayBeSensitive: false,
  },
  {
    name: 'waitForHidden',
    description: '等待元素（典型为 spinner）消失，替代固定 timeout',
    mayBeSensitive: false,
  },
  { name: 'screenshot', description: '截取当前页面到任务产物目录', mayBeSensitive: false },
];

export const ALLOWED_ACTIONS: readonly ActionName[] = BROWSER_TOOLS.map((tool) => tool.name);

export const ALLOWED_ROLES: readonly RoleName[] = [
  'textbox',
  'combobox',
  'button',
  'checkbox',
  'radio',
  'link',
  'heading',
  'table',
  'status',
  'searchbox',
  'switch',
  'tab',
  'spinbutton',
  'progressbar',
];

export function listTools(): BrowserToolDefinition[] {
  return BROWSER_TOOLS.map((tool) => ({ ...tool }));
}
