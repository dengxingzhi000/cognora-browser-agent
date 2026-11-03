import type { ActionIntent } from '../core/types.js';

export interface RealProductInput {
  name: string;
  code: string;
  category: string;
  brand: string;
  price: string;
  description: string;
}

/**
 * 真实 scm-web 商品新建页的默认探针流程：
 * 填写 + 逐字回读 + 选择分类/品牌/状态 + 尝试上架保存。
 * 默认 require_approval，保存动作会被审批闸门拦在点击前，不会产生真实商品。
 */
export function buildRealProductProbePlan(
  webUrl: string,
  input: RealProductInput
): ActionIntent[] {
  const base = webUrl.replace(/\/+$/, '');
  return [
    {
      action: 'goto',
      url: `${base}/zh-CN/product/create`,
      note: '真实商品新建页',
      expect: { type: 'text', text: '新建商品', exact: false },
    },
    {
      action: 'fill',
      target: { by: 'label', name: '商品名称' },
      value: input.name,
    },
    {
      action: 'fill',
      target: { by: 'label', name: '商品编码' },
      value: input.code,
    },
    {
      action: 'selectCustom',
      target: { role: 'combobox', name: '商品分类' },
      option: { name: input.category, by: 'role' },
    },
    {
      action: 'selectCustom',
      target: { role: 'combobox', name: '品牌' },
      option: { name: input.brand, by: 'role' },
    },
    {
      action: 'fill',
      target: { by: 'label', name: '售价（元）' },
      value: input.price,
    },
    {
      action: 'selectCustom',
      target: { role: 'combobox', name: '状态' },
      option: { name: '在售', by: 'role' },
      note: '上架保存属于敏感动作，require_approval 下不会真正点击',
    },
    {
      action: 'fill',
      target: { by: 'label', name: '商品描述' },
      value: input.description,
    },
    {
      action: 'click',
      target: { role: 'button', name: '保存' },
      approvalRequired: true,
      note: '默认探针只验证审批拦截，不产生真实商品数据',
    },
  ];
}
