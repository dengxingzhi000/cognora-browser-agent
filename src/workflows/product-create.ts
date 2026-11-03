import type { ActionIntent } from '../core/types.js';
import type { WorkflowDefinition, WorkflowContext } from './index.js';
import { baseUrl, requireString } from './index.js';

/**
 * 本地靶场 / 真实商品表单的通用流程。
 * 表单字段语义一致；target.url 指向站点根路径。
 */
export function buildProductCreatePlan(ctx: WorkflowContext): ActionIntent[] {
  const name = requireString(ctx.input, 'name', { required: true, maxLength: 120 });
  const brand = requireString(ctx.input, 'brand', { fallback: 'apple' });
  const price = requireString(ctx.input, 'price', { fallback: '199.00' });
  const stock = requireString(ctx.input, 'stock', { fallback: '120' });
  const description = requireString(ctx.input, 'description', {
    fallback: '结构化动作执行层验证样品：填写后逐字回读比对。',
  });
  const base = baseUrl(ctx);

  return [
    {
      action: 'goto',
      url: `${base}/product-form`,
      note: '目标页由靶场服务端校验 access_token，证明 storageState 复用生效',
      expect: { type: 'text', text: '登录态：access_token 已携带' },
    },
    { action: 'fill', target: { role: 'textbox', name: '商品名称' }, value: name },
    { action: 'select', target: { role: 'combobox', name: '品牌' }, value: brand },
    { action: 'fill', target: { role: 'textbox', name: '价格' }, value: price },
    { action: 'fill', target: { role: 'textbox', name: '库存' }, value: stock },
    { action: 'fill', target: { role: 'textbox', name: '描述' }, value: description },
    {
      action: 'click',
      target: { role: 'button', name: '保存草稿' },
      waitFor: { type: 'response', urlContains: '/api/drafts', method: 'POST', statusBelow: 400 },
      expect: [
        { type: 'status', text: '草稿已保存' },
        { type: 'list', container: { role: 'table', name: '最近草稿' }, contains: name },
      ],
      note: '保存动作允许执行；同时等待保存接口完成并回查提示与列表',
    },
    {
      action: 'click',
      target: { role: 'button', name: '提交发布' },
      note: '最终提交动作：require_approval 模式下停在 WAITING_APPROVAL，等待审批后从断点继续',
    },
  ];
}

export const productCreateWorkflow: WorkflowDefinition = {
  taskType: 'product.create',
  description: '填写商品表单 → 保存草稿 → 校验提示/列表 → 提交发布（敏感动作）',
  build: (ctx: WorkflowContext) => ({
    description: '商品新建流程（靶场 / 真实页面同构）',
    steps: buildProductCreatePlan(ctx),
  }),
};

/** 离线靶场专用 taskType；默认主流程已切到真实商品页。 */
export const fixtureProductCreateWorkflow: WorkflowDefinition = {
  taskType: 'fixture.product.create',
  description: '离线靶场商品新建回归流程（不依赖真实前端）',
  build: (ctx: WorkflowContext) => ({
    description: '离线靶场商品新建流程',
    steps: buildProductCreatePlan(ctx),
  }),
};
