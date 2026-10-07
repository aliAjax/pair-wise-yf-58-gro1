# pair-wise-yf-58 功能开关和灰度发布控制台

## 源提示词摘要
产品负责人配置目标用户、地区、应用版本和依赖条件，研发负责人审批发布计划，值班人员观察过程并随时关闭开关。系统支持规则组合、流量逐步增加、定时生效、紧急停止、回滚，并能在保存前模拟不同用户的命中版本。

## 技术栈
Vue 3 + TypeScript + Vite + Ant Design Vue + Pinia + Vue Router + Axios + VueUse + VeeValidate + Zod + Vue I18n。

## 已实现闭环
- 功能开关、发布计划、审计记录三类业务对象。
- 规则组合、模拟用户命中、逐步调整流量和定时生效。
- 产品/研发双审批、开始灰度、紧急停止、回滚和恢复草稿。
- 离线提示、VeeValidate + Zod 精确校验和 localStorage 持久化。

## 版本化与并发控制（多标签页）
- 每次内容改动（规则、放量）保存时携带并递增 `version`，作为乐观锁令牌；审批记录固定在它批准的那一个版本（`Approval.version`）。
- 两个标签页同时编辑同一开关时，晚到的保存（基线版本与共享存储当前版本不一致）会被拒绝并提示“内容已变化”，不会覆盖先保存一方的规则与审批；点“加载最新内容”后可基于新版本重改。
- 内容版本一旦改变：原版本上的审批全部失效（记录保留、标注所属版本备查）；定时生效摘钩（时间保留，需重新挂接并重新双审批）；正在进行的放量立即退回关闭、回到草稿重新确认。紧急停止不走版本锁，任何时候都可立即停下线上流量。
- 旧数据迁移：`migrate()` 在加载时补齐 `version/updatedAt/updatedBy`，把旧的 `approvals: string[]` 转成版本绑定对象（`legacy` 标记），把旧 `plan.version` 转为 `scheduleVersion`；草稿、审批、审计旧记录一律照旧可读。
- 并发与迁移行为可用 `npx esbuild scripts/concurrency-check.mts --bundle --platform=node --format=esm --outfile=/tmp/check.mjs && node /tmp/check.mjs` 验证。

## 启动
```bash
npm install
npm run dev
```
开发端口：62023
