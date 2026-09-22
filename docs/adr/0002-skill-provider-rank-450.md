# ADR 0002: 自有 SkillProvider 固定 rank 450

- 状态：已采纳（自 0.4.0，本文档补记于 0.7.0）
- 决策人：whaletv-workbench 维护者

## 背景

dsh-skill-filesystem 的 `user-dsh` provider（扫 `$DSH_HOME/skills`，rank 400）在部分 Windows 环境下不可靠：chokidar 丢事件、配置缺失时整个 provider 不注册——表现为"文件在盘上但面板/模型都看不到"。

## 决策

工作台在 `ctx.skills.registerProvider` 上注册自己的 provider（`whaletv-workbench-user-dsh`），**rank 固定 450**，同样扫 `$DSH_HOME/skills`；每个写路由（install/import/remove/update）之后显式 `invalidate()` 而不依赖文件监听。

## 理由

1. **rank 语义 = "确定性让位"**：dsh 的 provider 健康时，同名的技能由 rank 400（官方）胜出——目录内容一致，谁提供没有差别；dsh 不健康时，450 的我们补位，保证"盘上有 = 目录里有"。
2. **invalidate 而非 chokidar**：Windows 上 git.exe/杀软持有句柄会让监听器晚触发甚至丢事件；写完就显式失效是唯一确定性的路径。
3. **不做合并去重**：两个 provider 对同一目录各说各话的风险被 rank 排序吸收，比实现跨 provider 协商简单且可预测。

## 后果

- 若 dsh 未来改变 rank 语义（如改用优先级合并），本 provider 的 450 需要跟着重新评估。
- 面板的 `/skills` 汇总会把同一技能在两个 provider 下的条目都列出来（`provider` 字段可区分）——UI 按 `provider:name` 做 key，不去重。
