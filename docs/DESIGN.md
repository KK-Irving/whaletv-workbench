# WhaleTV 工作台 —— 设计与 UI 规划

> 初版（v0.1）已按本文档实现，当前版本 **v0.4.0**。本文档同时记录已实现的形态与后续演进路线，作为「规划」的长期交付物；具体每版变更详见 [CHANGELOG.md](../CHANGELOG.md)。

## 1. 背景与目标

日常工作中需要在大量**网页、文档、应用、工具**之间来回跳转（Zmind 建单、Gerrit 评审、Confluence 查文档、OpenGrok 搜代码、IDE/聊天工具……），切换成本高。基于 DeepSeek Harness（dsh），把当前项目做成**工作台插件**：

- 一个入口聚合所有常用资源，**一键跳转 / 打开 / 使用**；
- 与 dsh 内置/自定义 **skill** 衔接，让日常工作直接在会话中交给对应技能完成；
- 项目频繁更新时，使用中的用户**点一下「更新」**即可完成更新并重新插入 harness。

## 2. 总体架构：站外双面插件

dsh 是「一切皆插件」架构（Cordis + `dsh.client` Web 插件表）。本项目是**独立 npm 包**（不修改 deepseek-harness 源码），双面：

```
                        dsh web（127.0.0.1:3080）
┌────────────────────────────────────────────────────────────────┐
│  Host 半（Node，lib/index.js）                                   │
│   · GET  /whaletv/workbench/state   版本/git 状态/条目配置       │
│   · POST /whaletv/workbench/config 校验并保存条目配置            │
│   · POST /whaletv/workbench/update  git pull --ff-only          │
│          → pnpm install → pnpm run bundle                       │
│          → ctx.clientModules.rebuilt('whaletv-workbench')       │
│            （bundle 重新哈希进入 boot 图；dev HMR 经 SSE 广播）   │
├────────────────────────────────────────────────────────────────┤
│  Browser 半（lib/client.js，经 dsh.client 扫描注入 __DSH_BOOT__） │
│   · sidebar.footer.action  → SidebarEntry（侧边栏入口按钮）      │
│   · shell.overlay         → WorkbenchPanel（工作台悬浮面板）     │
│   共享 store：面板开关 / 搜索 / 更新状态                          │
└────────────────────────────────────────────────────────────────┘
```

- **安装**：`$DSH_HOME/profiles/web/`（官方站外插件用户层）——`package.json` 依赖（`link:` 协议）+ `cordis.patch.yml` 插入插件行；patch 层**热重载**，运行中的 dsh web 无需重启即挂载。
- **依赖解析**：dsh 启动器把内置包平铺到 `$DSH_HOME/profiles/node_modules`，`scripts/link-harness-deps.mjs` 将其镜像为本项目 `node_modules` junction（幂等，pnpm 不参与 @deepseek-ai/* 的管理）。
- **构建**：`tsdown.config.ts` 双面构建（内联 harness 的 client-bundle preset 关键部分，独立于 harness checkout）：Host 半 ESM external 全部 `@deepseek-ai/*`；Browser 半为 closure-factory artifact（`window.__ModuleLoader__.load({id, factory})`），CSS Modules 由 lightningcss 内联，平台模块（react/cordis/ui-slots/ui-primitives 等）走模块表 external。

## 3. UI 布局规划（初版形态）

### 3.1 入口

- 位置：侧边栏底部「设置」旁的 footer 动作区（dsh 为此提供的官方扩展点 `sidebar.footer.action`）。
- 形态：宽栏显示「工作台图标 + WhaleTV 工作台」；窄栏（折叠）只显示图标。
- 交互：点击开关工作台面板；打开时按钮高亮。

### 3.2 工作台面板（`shell.overlay` 悬浮层，居中面板）

```
┌──────────────────────────────────────────────────────────┐
│ [icon] WhaleTV 工作台  v0.1.0   main@abc123  刷新 编辑 更新 ✕ │ ← 顶栏
├──────────────────────────────────────────────────────────┤
│ [🔍 搜索网页 / 文档 / 应用 / 技能…]                        │ ← 搜索
├──────────────────────────────────────────────────────────┤
│ 网页                                                   │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐      │
│  │ Zmind        │ │ Gerrit       │ │ Confluence   │      │ ← 卡片组
│  │ 描述文字…    │ │ 描述文字…    │ │ 描述文字…    │      │
│  │ [打开网页]   │ │ [打开网页]   │ │ [打开网页]   │      │
│  └─────────────┘ └─────────────┘ └─────────────┘      │
│ 技能                                                   │
│  ┌─────────────┐                                        │
│  │ whaletv-dev-power                                    │
│  │ WhaleTV 开发工作流助手                                │
│  │ [在会话中使用] [复制提示词]                            │
│  └─────────────┘                                        │
├──────────────────────────────────────────────────────────┤
│ （更新时）更新结果 + 完整命令日志                          │ ← 底部日志区
└──────────────────────────────────────────────────────────┘
```

交互细则：

| 区域 | 行为 |
| --- | --- |
| 遮罩 / Esc / ✕ | 关闭面板（面板本身 `pointer-events: auto`，遮罩点击关闭） |
| 搜索框 | 实时过滤标题与描述（忽略大小写） |
| 条目卡片 | 按字段类型给出动作按钮；`url` → 新标签页打开，`path` → 宿主系统默认程序打开，`prompt` → 复制提示词 + 新建空白会话 |
| 未配置条目 | 「待配置」徽标 + 禁用按钮 |
| 编辑 | 顶栏「编辑」进入编辑模式（再次点击或「完成」退出）：条目卡片出现「编辑 / 删除」，分组头部出现「重命名 / + 条目 / 删除分组」，底部「+ 新建分组」；表单保存即经 `POST /whaletv/workbench/config` 写回配置并刷新 |
| 刷新 | 重新拉取 Host 状态与条目配置 |
| 更新 | 一键自更新（见 §4），更新中禁用按钮并显示「更新中…」 |

### 3.3 条目配置（面板内编辑）

条目配置在面板「编辑」模式里直接增删改，无需接触文件：表单字段为名称（必填）、描述、目标类型（url / path / prompt）、目标值；分组支持重命名、增删条目、整组删除，底部可新建分组。

存储与自更新共存策略：

- 用户配置 = 插件目录 `config/workbench.json`（**不入 git**，由 `POST /whaletv/workbench/config` 校验 + 原子写入）；这样面板改配置不会与「一键更新」的 `git pull --ff-only` 冲突。
- 仓库只带模板 `config/workbench.example.json`（初版预置：网页 Zmind/Gerrit/Confluence/OpenGrok/知识库、文档、应用本机路径、技能 whaletv-dev-power / whale-gerrit / issue-resolver / commit-message）；`workbench.json` 缺失时 Host 读取模板兜底。

保存接口对负载做白名单校验（id/title/description/url/path/prompt，去空白字段、id 唯一、数量上限），写文件采用 tmp + rename 原子替换。

## 4. 更新机制（点击即更新并重新插入）

时序：

```
用户点击「更新」
  → POST /whaletv/workbench/update（Host，防重入）
  → git rev-parse HEAD（无仓库/无远程 → 明确报错提示）
  → git pull --ff-only
  → 有提交：pnpm install → pnpm run bundle（重建 lib/client.js）
  → ctx.clientModules.rebuilt() 重新哈希 → boot 图 rev 更新
  → dev 模式：SSE 推送，浏览器自动加载新 bundle；生产模式：提示刷新页面
  → 返回 { changed, rebuilt, output, needRestart }；面板底部展示完整日志
```

设计取舍：

- **Host 半刻意轻量稳定**：绝大多数更新只动 client 侧，热注入即可生效；服务端变更时 `needRestart` 提示重启 dsh。
- 安装采用 `link:`（非 `file:` 拷贝），`git pull` 直接作用于用户持有目录，无需重新安装。
- 自更新要求项目是 git 仓库且已配置 origin；未配置时给出可操作提示。

## 5. 品牌与主题

- 工作台图标（`assets/workbench.svg`，品牌红 #FF0050 面板网格）构建时内嵌为 SVG data URL（`scripts/gen-icon.mjs`），用于入口图标与面板头部；矢量缩放不因压缩模糊，替换 assets 文件后 `pnpm run bundle` 即生效。
- 样式遵守 dsh 主题规范：CSS Modules + `--dsw-alias-*` 语义 token（明暗主题自适应），复用 `ui-primitives` 的 Button/Input。

## 6. 路线图（后续版本）

| 版本 | 内容 |
| --- | --- |
| v0.2 | 更新前先「检查更新」（`git fetch` + ahead/behind 对比，区分「检查/更新」两个按钮）；更新历史记录 |
| v0.2 | 常用网页内嵌 iframe 预览（面板内快速查阅，外跳打开） |
| v0.3 | 条目拖拽排序 / 按项目（D4/X5/STB）分组切换（配置热编辑已提前到本版实现） |
| v0.3 | ~~技能条目直接预填会话输入框~~ → **v0.4 已实现**：`agent.followup()` 走通 |
| v0.5 | 本地应用健康检查（路径存在性探测 + 一键定位）；快捷键唤起工作台 |
| v0.5 | 中英文 locale 字典接入 dsh locale 系统；更新失败自动回滚上一版本 |
| v0.6 | Skill 版本化：安装带来源 URL + commit SHA 记录，重新导入检测冲突（下一步） |
| 待定 | MCP 工具快捷调用卡片（把已挂载的 zmind/gerrit/confluence/knowledge MCP 常用操作做成表单卡片，直接驱动模型调用） |

## 7. 已实现 vs 规划

**v0.4 里程碑（当前版本）**：
- ✅ 双面插件基础（v0.1）、面板内配置编辑（v0.2）、一键自更新（v0.2）
- ✅ 官方 `dsh plugin add` 单命令安装（v0.3）：`dsh.bundle.patch` + `cordis.patch.yml`
- ✅ Settings 命名空间 + 卡片（v0.3）：`whaletv-workbench` 走 `ctx.settings`
- ✅ **工作台技能专区完整闭环**（v0.4）：
  - `ctx.skills.registerProvider` 注册工作台自有 provider，扫 `$DSH_HOME/skills`
  - 三种技能形态识别：bundle / flat / batch
  - Git 导入：URL + subPath + ref，含认证失败友好翻译（OAuth / SSO 场景）
  - 手写正文安装：自动包 YAML frontmatter
  - `agent.followup()` 一键把 skill 塞进当前会话
  - 诊断路由 `/skills/debug`
  - Windows 特化清理（rmSync 8×250ms 重试 + 启动时 sweep staging）
- ⏳ 用户侧待办：面板「编辑」里填写各系统真实 URL/路径；`git remote add origin` 关联远程并推送；生产模式下更新后手动刷新页面。
