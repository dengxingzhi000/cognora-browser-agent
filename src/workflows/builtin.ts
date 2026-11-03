import { InvalidInputError } from '../core/errors.js';
import type { ActionIntent } from '../core/types.js';
import type { WorkflowDefinition } from './index.js';
import { baseUrl } from './index.js';

/** 真实 SPA 登录：用户名 / 密码走可见标签，登录后断言 URL 变化。 */
export function buildRealLoginPlan(
  webUrl: string,
  username: string,
  password: string
): ActionIntent[] {
  return [
    {
      action: 'goto',
      url: `${webUrl}/zh-CN/login`,
      note: '真实 scm-web 登录页（Next.js dev server）',
      expect: { type: 'url', pattern: '/login' },
    },
    { action: 'fill', target: { by: 'label', name: '用户名' }, value: username },
    {
      action: 'fill',
      target: { by: 'label', name: '密码' },
      value: password,
      note: '密码来自环境变量，报告中自动脱敏',
    },
    {
      action: 'click',
      target: { role: 'button', name: '登录' },
      expect: { type: 'url', pattern: '/dashboard' },
      note: '登录成功后跳转 dashboard，随后由执行层保存 storageState',
    },
  ];
}

export const realLoginWorkflow: WorkflowDefinition = {
  taskType: 'real.login',
  description: '真实 scm-web 登录并归档 storageState（需要 BROWSER_PASSWORD / SPIKE_PASSWORD）',
  build: (ctx) => {
    const password = ctx.config.password;
    if (!password) {
      throw new InvalidInputError(
        '缺少登录密码：请设置 BROWSER_PASSWORD 或 SPIKE_PASSWORD 后再创建 real.login 任务',
        { taskType: 'real.login' }
      );
    }
    return {
      description: '真实登录流程',
      steps: buildRealLoginPlan(baseUrl(ctx), ctx.config.username, password),
    };
  },
};

export const blockerWorkflow: WorkflowDefinition = {
  taskType: 'blocker.check',
  description: '进入带 data-captcha 的页面，验证反自动化检测会立即停止',
  build: (ctx) => ({
    description: '反自动化守卫自检',
    steps: [
      {
        action: 'goto',
        url: `${baseUrl(ctx)}/blocked`,
        note: '该页带 data-captcha 标记，执行层应拒绝继续',
      },
    ],
  }),
};

export const actionsRunWorkflow: WorkflowDefinition = {
  taskType: 'actions.run',
  description: '回放调用方提供的结构化动作序列（仍逐条走动作白名单与域名策略）',
  build: (ctx) => {
    const actions = ctx.input.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new InvalidInputError('input.actions 必须是非空动作数组', { taskType: 'actions.run' });
    }
    return {
      description: '自定义结构化动作序列',
      steps: actions as ActionIntent[],
    };
  },
};
