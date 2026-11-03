# Pull request

## 变更内容

<!-- 一两句话；如果是修复 issue，请在末尾写 Closes #123。 -->

## 为什么这样改

<!-- 关键约束是什么？为什么不能用更简单的方案？ -->

## 验证

<!--
贴真实命令与真实结果，不要只写「测试通过」。
例如：
  npm run typecheck
  npm test        # 30 tests / 28 passed / 2 skipped / 0 failed
-->

```text
npm run typecheck
npm test
```

- [ ] `npm test` 全绿（说明 passed / skipped 数）
- [ ] `npm run typecheck` 通过
- [ ] 未提交 DSN / 密码 / token / cookie 原始值
- [ ] README / CHANGELOG 已更新（接口或行为变化时）
- [ ] 新能力的限制如实写入文档，不夸大未验证能力
