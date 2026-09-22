# WhaleTV 工作台 Roadmap

> 生成于 2026-09-03，基于 v0.6.0 代码现状审查 + 对 [dckxx/x-hub](https://github.com/dckxx/x-hub)（v0.6.5）的完整调研。
> 每完成一项请在对应条目前打 ✅ 并同步更新 [CHANGELOG.md](../CHANGELOG.md) 与 [DESIGN.md](./DESIGN.md) §6 路线表。

## 执行状态（2026-09-03，v0.7.1 发版）

**已完成**（全部 `tsc --noEmit` + smoke 绿，bundle 通过）：

- ✅ **P0 全部**：dsh 0.1.6-alpha.2 对齐（`mainView` retention 读当前会话、`settings.plugins.tab`）、CI（ci.yml）、每周对齐 job（align.yml）、tsc 纳入 smoke、check-version 三处一致门、死代码清理、needRestart 按 host 文件 diff 精确化
- ✅ **P1 全部**：检查/更新分离（`/update/check` + 提交列表 banner）、更新历史 + 回滚（updates.json + `/update/rollback`，脏工作区拒绝）、跳过此版本（`/update/skip`）、needRestart 驱动的结果文案
- ✅ **P2 核心**：最近使用通栏（/usage + Top10 chips）、Alt+W 唤起、搜索 ↑↓/Enter 键盘导航 + 高亮、条目拖拽排序（组内 + 跨组）、可达性检查（/health + ✓✗ 徽标）、favicon 代理（/icon，私网拒绝）
- ✅ **P3 核心**：技能版本化（installed-skills.json：来源 URL/subPath/ref/SHA，`/skills` 返回 origin + 卡片展示）、单技能「检查更新」（`/skills/update`，SHA 对比 + 覆盖安装）
- ✅ **P4 部分**：ADR 0001（配置与状态在 $DSH_HOME）、ADR 0002（provider rank 450）、link-harness-deps 支持无 $DSH_HOME 环境（CI 前置）、smoke-host 覆盖安全边界（git-import 白名单/保留字/ref 注入/穿越、skip SHA、favicon 私网）
- ✅ **评审调整（2026-09-03 第二轮）**：
  - 检查/更新合并为**单入口两阶段**：头部只留「检查更新」（有更新时变主色），拉取动作收敛到结果 banner 内的「更新」按钮——原两个按钮语义重叠
  - 技能面板内编辑（P3-23 原型）**按评审移除**：误触改坏 SKILL.md 的风险大于收益，普通用户以「删除 + 重装」替代；`GET /skills/source` 路由一并移除，不留死接口
- ✅ **dsh 0.1.7-alpha.1 对齐（v0.7.1）**：
  - CI 修复：smoke-host 对 harness-only 运行时依赖（yaml/dsh-llm/schemastery）预检，缺失时显式 SKIP——每周对齐 job 才是 host 半的权威门
  - settings 缝断裂（installSection→SettingsForms、settingsScope→configForms）以**去依赖**化解：自持状态迁入自有 JSON（update-state.json），偏好字段标 volatile 交给 0.1.7 自动配置页，自研设置卡片退场（SettingsCard 删除、client inject 去掉 settingsScope、peerDeps 去掉 dsh-settings/ui-settings/ui-settings-plugins）
  - link-harness-deps 逐项容错（单个被锁 junction 不再炸整轮）+ 可修复 0.1.7 profile 自身的悬挂 junction（要求 checkout 已 build lib 面）
  - 本会话沙箱拒绝 junction 增删 → 补链需在自有终端跑 `pnpm run link:harness`；tsconfig 暂以 paths 指向 checkout 类型兜底（补链成功后删除）

**剩余（后续版本）**：

- ⏳ P2-18 中英文 locale 字典（需 PropsLocale 注入改造三个组件，纯机械大改）
- ⏳ P2-19 面板明暗对比度系统审计（新增 CSS 已用 token + fallback，全量审计待做）
- ⏳ P3-22 技能市场/推荐源清单、P3-24 MCP 工具快捷卡片
- ⏳ P4-25/26 Host 与 Panel 文件拆分、P4-27 dsh 兼容层收口 compat.ts、P4-30 tag + GitHub Release
- ⏳ P1 补充：面板内完整更新历史列表展示（当前只有最近一条 + 回滚）

---

## 0. 结论摘要（TL;DR）

1. **当前最紧急**：代码对已链接的 dsh **0.1.6-alpha.2** 类型检查不过（`SessionListState.current` 已移除、`settings.plugin.item` slot 不在 SlotMap）。`pnpm run smoke` 全绿是假象——冒烟测试 mock 了契约，抓不到类型漂移。**对齐工作必须先做，且要建立防回归机制（CI + tsc 纳入冒烟链）。**
2. **对标对象**：x-hub 是同题材（个人效率工作台）但不同基座（Tauri 桌面独立应用）的成熟实现，其**更新链路、主题/设计令牌体系、最近使用、全局搜索、扩展（技能）中心、版本化安装**六块能力对本项目有直接借鉴价值。
3. **主线节奏**：v0.6.1 止血对齐 → v0.7.0 更新体验 + 代码拆分 → v0.8.0 工作台能力 → v0.9.0 技能版本化/市场 → v1.0.0 稳定声明。

---

## 1. x-hub 调研结论（借鉴来源）

### 1.1 项目画像

- **定位**：本地优先的个人桌面效率工作台，Bento 风格，数据全本地（SQLite WAL）+ 便携版（exe 同目录 `portable` 标记文件）。
- **栈**：Tauri 2 + Rust（约 35 个模块、200+ 命令）+ Vue 3 `<script setup>` + Tailwind 4 + 自研 reactive store（无 Pinia）。
- **功能面**：工作台（时钟/天气/系统监视/便签/待办/提示词/最近使用，9 种部件自由编排 Bento 网格）、倒计时（4 模式 + Rust 后台驱动 + 透明浮窗）、速达（应用/网页/文件合一 + 图标提取 + 批量扫描导入）、速记（Markdown + 标签）、待办（优先级/周期/日历拖拽）、全局搜索（Ctrl+K）、剪贴板历史（文本/图片/文件 + 全局热键）、AI 对话（OpenAI 兼容 SSE + 多会话 + 四方位停靠 + Key 存系统钥匙串）、提示词百宝箱、**扩展系统**（GitHub zip 安装 + manifest 权限 + 桥 API + service 托管 + 市场/发布/账号额度）。

### 1.2 工程亮点（值得抄的）

| x-hub 做法 | 对本项目的启示 |
| --- | --- |
| **自研升级链路**：`update.json` + Ed25519 签名验签（内嵌公钥）→ semver 比较 + `minimumUpgradable` 跳级保护 → 静默检查（启动 5s + 每 4h）→ 流式下载 + sha256 校验 → 两步 rename 自替换 + 失败回滚 + 下次启动重试；支持「跳过此版本」 | 本项目「更新」按钮只有 git pull 一条路，无检查/无历史/无回滚。§3 P1 直接对标 |
| **最近使用通栏**：按 `last_launched_at` 排序 Top 10 | 工作台条目目前无使用记录，加 usage.json 即可复刻 |
| **全局搜索 Ctrl+K**：300ms 防抖，跨资源/笔记/待办，点击直达 + 3s 高亮 | 面板搜索已覆盖条目+技能，补键盘直达与唤起快捷键 |
| **设计令牌体系**（DESIGN.md 为唯一基线）：三轴主题（模式×预设×强调色，`--accent` inline 注入 + `color-mix` 派生）、常驻表面伪毛玻璃静态烘焙（GPU 26%→低位）、只动画 transform/opacity、`prefers-reduced-motion` | 本项目面板样式可借 token 化思路做一次明暗对比度审计 |
| **安全文档化**：ADR 0008 扩展内容跨源隔离（`xhub-ext.localhost` 与 `asset.localhost` 跨源，扩展读不到用户库）；URI 协议严格文件名校验防路径穿越；资产作用域只放行 4 个子目录 | 本项目 skills/import 的白名单思路与之一致，可把安全边界整理成 ADR 文档 |
| **数据迁移纪律**：旧目录一次性迁移、待恢复数据启动时应用、幂等 SQL 修复图标路径 | 本项目已有 legacy config 迁移，同思路 |
| **AGENTS.md 约定 + docs/adr/**：把跨 Agent 协作约定和架构决策落盘 | 本项目可补 ADR 目录记录「为什么配置放 $DSH_HOME」「provider rank 450」等既有决策 |

### 1.3 x-hub 自身的问题（避免重蹈）

- README 滞后于代码（账号/发布/平台额度等功能已远超「本地优先不上云」的定位表述）。
- `is_position_on_screen` 用 ±10000 经验值模拟显示器边界（注释自认 Tauri 2 无枚举 API）——权衡可见，但属于脆弱点。
- `RunEvent::Exit` 里 `std::process::exit(0)` 兜底——务实但跳过所有清理。
- **启示**：功能扩张快于文档时，README/DESIGN 会失真；本项目 README（写 v0.5.1）与 package.json（0.6.0）已经出现同类漂移，先修。

---

## 2. 当前项目现状审查（v0.6.0 @ main, e1fe8f9）

### 2.1 资产盘点

| 维度 | 现状 |
| --- | --- |
| 架构 | 双面插件：Host 半（`src/index.ts` 约 1370 行：8 条路由 + SkillProvider + git 导入机 + 自更新）+ Browser 半（`WorkbenchPanel.tsx` 约 1069 行 + SidebarEntry + SettingsCard + store + contract），`tsdown.config.ts` 双面构建 |
| 已交付 | 条目卡片（url/path/prompt 三态）+ 面板内编辑 + 一键自更新 + 技能专区（手写/Git 导入 bundle·flat·batch 三形态/删除/诊断路由）+ 自有 SkillProvider（rank 450）+ Settings 卡片 + 当前会话内联引用技能 + Electron 客户端内新标签页（dsh-tab） |
| 质量纪律 | 白名单校验、512KB/256KB body 上限、tmp+rename 原子写、路径穿越防护、git URL/ref 白名单、非交互 git env、execFile 数组参数、Windows staging 重试清理、junction 悬挂修复——安全与平台坑位处理是亮点 |
| 测试 | 3 个脚本级冒烟（client/apply/host），全绿；**但均为 mock 契约测试，未覆盖真实 dsh 类型** |

### 2.2 发现的问题（按严重度）

1. **[高] 对 dsh 0.1.6-alpha.2 类型检查失败**（`npx tsc --noEmit` = 2 errors）：
   - `src/client/index.ts:170` — `SessionListState.current` 属性已不存在（`referenceSkill` 取当前会话 id 的 API 变了）；
   - `src/client/index.ts:206` — `settings.plugin.item` slot 名已不在 SlotMap（提示 ближай `settings.plugins.tab`）。runtime 注册契约（smoke-apply）与类型已脱节。
   → 0.4→0.5 的「上游移除依赖 → 全量对齐」剧本正在重演，且这次没有 CI 兜底。
2. **[高] 无 CI**：`.github/workflows` 不存在；对齐断裂只能在用户机上炸。
3. **[中] 版本文档漂移**：README「当前版本 v0.5.1」、DESIGN.md「当前版本 v0.5.1」vs package.json **0.6.0**。
4. **[中] 单文件过大**：`src/index.ts`（路由 if-chain + 技能 provider + git 导入 + 更新管线全在一个文件）、`WorkbenchPanel.tsx`（分组编辑 + 技能专区 + 更新 footer 全在一个文件）——每次 dsh 对齐的 diff 面积和 review 成本被放大。
5. **[低] 死代码/不一致**：
   - `src/index.ts:1367-1369` `void readdirSync` + 过时注释；
   - `src/index.ts:686` `statSync(...) !== undefined ? rawSource : rawSource` 恒等三元（真防护在下一行 startsWith）；
   - `src/index.ts:1213/1310` 用 `ctx.get('settings')`，`1262` 却用 `(ctx as unknown as {...}).get?.('settings')` 两套写法。
6. **[低] `needRestart` 过报**：`runUpdate` 只要 changed 就 `needRestart: true`，其实可用 `git diff --name-only <before> <after> -- src/index.ts tsdown.config.ts package.json` 精确判定。
7. **[低] legacy 配置迁移后旧文件永久残留**（注释已自知，需定一个删除版本）。

---

## 3. Roadmap

### P0 — 止血对齐（v0.6.1，目标：1 个工作日内）

| # | 事项 | 验收 |
| --- | --- | --- |
| 1 | 修复 `referenceSkill` 对新 `ISessions` API 的取值（替换 `SessionListState.current`） | `referenceSkill` 在 0.1.6-alpha.2 真机上可用 |
| 2 | 迁移 `settings.plugin.item` 到当前 SlotMap 的对应 slot（`settings.plugins.tab` 一类），同步改 smoke-apply 的期望 | `tsc --noEmit` 0 error |
| 3 | `pnpm run smoke` 链路前置 `tsc --noEmit`（smoke = tsc + 三脚本） | 冒烟链能抓住类型漂移 |
| 4 | 新增 `.github/workflows/ci.yml`：install → `link:harness` → tsc → bundle → smoke；并在 README 声明「验证过的 dsh 版本」 | CI 绿 |
| 5 | 版本三处统一（package.json / README / DESIGN.md），加 `scripts/check-version.mjs` 一致性校验挂进 smoke | 校验脚本过 |
| 6 | 清理 §2.2-5 的死代码与两套 `ctx.get` 写法 | grep 无残留 |
| 7 | `needRestart` 精确化（diff 文件集判定） | 仅服务端变更时提示重启 |

### P1 — 更新体验，对标 x-hub 升级链路（v0.7.0）

| # | 事项 | 参考 x-hub |
| --- | --- | --- |
| 8 | **「检查更新」与「更新」分离**：`git fetch` + ahead/behind + 新提交列表（`git log --oneline`），面板展示落后 N 提交再决定 | 静默检查 + 更新弹窗（版本/说明/体积） |
| 9 | **更新历史与回滚**：每次更新追加 `{ time, before, after, ok, log }` 到 `$DSH_HOME/whaletv-workbench/updates.json`，面板展示最近 10 条；pull 后 build 失败时提供 `git reset --hard <before>` 一键回滚 | 失败自动回滚 + 下次重试 |
| 10 | **「跳过此版本」**：检查到新版本时可标记 skip（记录 SHA），后续检查不再提示 | `skip_update_version` |
| 11 | 更新弹窗信息结构化：版本号、提交数、是否含服务端变更（驱动 #7 的 needRestart）、完整日志折叠 | 全局更新弹窗 |

### P2 — 工作台能力扩展（v0.8.0）

| # | 事项 | 参考 x-hub / 备注 |
| --- | --- | --- |
| 12 | **最近使用通栏**：Host 记录条目打开次数/时间（`usage.json`），面板顶部 Top 10，支持清除 | `last_launched_at` 排序 |
| 13 | **快捷键唤起**：页面级快捷键（如 `Alt+W`）开关面板；调研 dsh client 是否有全局快捷键面可挂 | Ctrl+K / Ctrl+Shift+Space |
| 14 | **搜索增强**：键盘 ↑↓ 导航 + Enter 直达 + 命中高亮；技能结果与条目结果统一排序 | 全局搜索直达 + 3s 高亮 |
| 15 | **条目拖拽排序**（分组内 + 跨分组），顺序写回 workbench.json | — |
| 16 | **条目健康检查**：url 类条目 HEAD 探测（Host 侧执行避免 CORS），失效显示徽标；path 类条目存在性探测 + 「打开所在目录」 | DESIGN.md v0.5 规划的应用健康检查 |
| 17 | **条目图标**：url 自动抓 favicon（Host 侧代理下载存 `$DSH_HOME/whaletv-workbench/icons/`），或 emoji 兜底 | 速达图标提取 |
| 18 | **locale 字典**接入 dsh locale 系统（zh/en），面板文案全部走字典 | DESIGN.md v0.5 规划 |
| 19 | **面板主题审计**：对照 dsh `--dsw-alias-*` token 做明暗两态对比度检查；借 x-hub 思路把面板色值收敛成小型 token 集 | 三轴主题 / DESIGN.md 基线 |

### P3 — 技能管理演进（v0.9.0）

| # | 事项 | 参考 x-hub / 备注 |
| --- | --- | --- |
| 20 | **Skill 版本化**：`installedSkills` 从 `string[]` 升级为 `{ name, sourceUrl, resolvedSha, installedAt }[]`（迁移旧数据）；Git 导入时在 staging `git rev-parse HEAD` 记录来源 SHA | 扩展中心 manifest 思路；DESIGN.md v0.6 规划 |
| 21 | **已装技能「检查更新」**：对来源为 Git 的技能 re-clone 对比 SHA，变化则一键覆盖更新（保留用户后改内容前先 diff 提示） | `update_extension` |
| 22 | **技能市场/推荐源**：内置一份推荐技能仓库清单（JSON，可被用户配置扩展），面板浏览 → 按子路径批量导入 | 扩展市场 registry |
| 23 | **技能面板内编辑**：读取已装技能 SKILL.md → textarea 编辑 → 写回（带 frontmatter 表单），失败保留草稿 | 速记 Markdown 编辑/预览 |
| 24 | **MCP 工具快捷卡片**（DESIGN.md 待定项）：把 zmind/gerrit/confluence/knowledge 等 MCP 高频操作做成表单卡片（建任务/查 change/搜代码），生成结构化 prompt 走 `referenceSkill`/`followup` | 扩展 module 卡片形态 |

### P4 — 工程健康（伴随各版本滚动）

| # | 事项 | 动机 |
| --- | --- | --- |
| 25 | **Host 拆分**：`src/index.ts` → `routes.ts` / `skills.ts`（provider+import）/ `update.ts` / `config.ts`，单文件 <500 行 | 缩小 dsh 对齐 diff 面积 |
| 26 | **Panel 拆分**：`WorkbenchPanel.tsx` → `SkillsSection.tsx` / `ItemForm.tsx` / `UpdateFooter.tsx` | 同上，UI 侧 |
| 27 | **dsh 兼容层集中**：所有对 dsh API 的类型断言/取值收口到 `src/compat.ts`（Host）+ `src/client/compat.ts`，升级 dsh 只改两处 | §2.2-1 的长期解法 |
| 28 | **冒烟增强**：git import 的 URL 白名单 / ref 注入拒绝 / staging 清理路径补 mock 测试；评估 `node --test` 结构化 | 现有 smoke 不覆盖安全边界 |
| 29 | **ADR 目录**：补 `docs/adr/0001-config-in-dsh-home.md`、`0002-skill-provider-rank-450.md`、`0003-update-via-git-pull.md` | 学 x-hub 的决策留痕 |
| 30 | **发布工程**：打 tag + GitHub Release；check-version 脚本（P0-5）扩展为发版前检查 | 当前只有 main 裸提交 |

### 里程碑与节奏

```
v0.6.1  P0 全部（对齐 0.1.6-alpha.2 + CI + 版本一致 + 清理）        ← 立即
v0.7.0  P1（检查/更新分离 + 历史/回滚 + 跳过版本）+ P4.25/26/27 拆分  ← 下一功能版
v0.8.0  P2（最近使用 + 快捷键 + 搜索/排序/健康检查 + locale + 主题审计）
v0.9.0  P3（技能版本化 + 检查更新 + 市场源 + 面板编辑 + MCP 卡片）
v1.0.0  API 稳定声明 + 支持 dsh 版本矩阵 + 文档齐备 + CI 长绿
```

### 明确不做（Negative scope）

- 不做剪贴板历史 / 系统监视 / 倒计时浮窗等「桌面应用独占」能力——它们属于 x-hub 的宿主形态优势，塞进 web 面板收益低。
- 不做扩展二次开发系统——dsh 的插件/技能体系本身就是这层，避免重复造。
- 不引入前端框架级状态库——`dsh-client-store` 的 defineStore 已够用，与 dsh 对齐成本优先。

---

## 4. 与 x-hub 的长期关系

x-hub 是「独立桌面应用」形态的极限样本，本项目是「嵌入 AI Harness 的面板」形态。两者不合并、但保持**单向借鉴**：更新链路（P1）、使用统计（P2）、技能/扩展运营（P3）三块 x-hub 已验证的设计可直接移植；反之本项目的 **skill git 导入三形态识别、会话内联引用**是 x-hub 没有的，若其扩展系统需要「从 git 装 skill」也可反向参考。
