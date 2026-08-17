# whaletv-workbench

WhaleTV 工作台 —— DeepSeek Harness（`dsh`）的站外 Web 插件：把日常工作的**网页、文档、应用、技能**集中到一个面板，一键跳转 / 打开 / 使用，减少来回切换场景的时间；并内置**点击即用的自更新**（git pull → 重建 → 热注入），项目更新后用户点一下即可完成更新并重新插入 harness，无需重装。

## 特性

- **零侵入安装**：不改动 deepseek-harness 源码，通过 dsh 官方的 profile 用户层（`$DSH_HOME/profiles/web`）安装；patch 层热重载，**运行中的 dsh web 无需重启**即挂载插件。
- **侧边栏入口**：侧边栏底部（设置旁）新增「WhaleTV 工作台」入口（工作台图标 + 文案；折叠为窄栏时只显示图标）。
- **工作台面板**（`shell.overlay` 悬浮层）：
  - 分组卡片：网页 / 文档 / 应用 / 技能，支持搜索过滤；
  - 网页 → 新标签页打开；应用/文件 → 调用宿主系统默认程序打开；
  - 技能 → 一键复制提示词 + 新建会话，把任务直接交给对应 skill；
  - 未配置的条目显示「待配置」徽标，按钮禁用；
  - **面板内编辑**：右上角「编辑」进入编辑模式，直接增删改条目与分组（名称 / 描述 / 类型 url·path·prompt / 目标值），保存即写回配置并刷新，无需手工编辑 JSON。
- **工作台技能专区**（对接 `ctx.skills`）：面板底部列出所有 dsh 已发现的技能（`SkillRegistry.snapshot()`），显示来源徽标；「使用」按钮走 `agent.followup()` 把"调用技能：xxx"发到当前会话（未找到会话则退回剪贴板 + 新会话）；「+ 新建技能」表单一键写入 `$DSH_HOME/skills/<name>/SKILL.md`，dsh-skill-filesystem 的 chokidar 立即让模型可用；只允许删除工作台自己写入 `$DSH_HOME/skills/` 的技能，项目/agent/内置技能保持只读。
- **Settings 卡片**（`settings.plugin.item` slot）：dsh Web 设置页 → Plugins 标签下自动出现「WhaleTV 工作台」卡片，编辑 `gitRemote` / `customSkillDirs` 等偏好，走标准的 `ctx.settings` 命名空间（`whaletv-workbench`），支持带 revision 的乐观并发写。
- **一键更新**：面板顶部「更新」按钮执行 `git pull --ff-only` → （有更新时）`pnpm install` + 重建 client bundle → 通过 `clientModules.rebuilt` 热注入，开发模式下浏览器自动刷新；涉及服务端改动时提示重启 dsh。更新日志完整展示在面板底部。
- **工作台图标**：`assets/workbench.svg`（品牌红面板网格）构建时内嵌为 SVG data URL，矢量缩放不因压缩模糊，用于入口图标与面板头部（`scripts/gen-icon.mjs`）。

## 架构

双面插件（与 harness 内 `ui-workspace` 等 client 包同构）：

```
┌─ Host 半（Node）──────────────────────────────────────────────┐
│ src/index.ts                                                  │
│   GET  /whaletv/workbench/state   版本 / git 状态 / 条目配置    │
│   POST /whaletv/workbench/config 校验并保存条目配置            │
│   POST /whaletv/workbench/update  git pull + pnpm install      │
│                                   + pnpm run bundle            │
│                                   + clientModules.rebuilt()    │
└────────────────────────────────────────────────────────────────┘
┌─ Browser 半（client bundle，dsh.client 扫描进 __DSH_BOOT__）───┐
│ src/client/index.ts                                           │
│   sidebar.footer.action → SidebarEntry（入口按钮）             │
│   shell.overlay        → WorkbenchPanel（工作台面板）          │
│   共享 createWorkbenchStore（面板开关 / 搜索 / 更新状态）      │
└────────────────────────────────────────────────────────────────┘
```

依赖解析与 harness 官方站外插件路径一致：安装时 `dsh` 启动器已把内置包平铺到 `$DSH_HOME/profiles/node_modules`，本项目用 `scripts/link-harness-deps.mjs` 将该回退镜像为 `node_modules` junction（幂等）。

## 安装

前置：Node ≥ 22、pnpm、dsh 已运行过一次（生成 `$DSH_HOME/profiles/web`）。

### 推荐：官方 `dsh plugin` CLI（一句话）

本包 `package.json` 声明了 `dsh.bundle.patch`（指向根目录 `cordis.patch.yml`），因此 `dsh plugin add` 会自动把它作为 bundle 挂到 `dsh.profile.bundles` 层栈里。

**从本地目录安装**（推荐用于开发）：

```powershell
# 先构建一次，让 lib/ 就绪（link: 协议下 pnpm 不会自动跑 prepare）
pnpm install; pnpm run bundle
# 一键安装
dsh plugin --profile web add e:\DeepSeek\whaletv-workbench
```

**从 GitHub 直装**（推荐用于用户侧）：

```powershell
dsh plugin --profile web add github:KK-Irving/whaletv-workbench
```

git 直装会触发本包的 `prepare` 脚本自动构建 `lib/`。首次可能被 pnpm ≥ 10 的 `allowBuilds` 拦截，按提示把 `whaletv-workbench` 加进 `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 后再跑一次。

**一句话卸载**：

```powershell
dsh plugin --profile web remove whaletv-workbench
```

安装 / 卸载完刷新 `http://127.0.0.1:3080`；运行中的 dsh web 热加载 profile patch，自动挂载或卸载，无需重启。

### 备选：自研 `install-profile.mjs`（旧版兼容）

无 `dsh` CLI，或希望复用 `link-harness-deps` + 一键把 profile 装成 `link:` 协议时可用。它做的事等价于 `dsh plugin add ./checkout` + `link-harness-deps`，但走的是直接编辑 profile 的 `package.json` 与 `cordis.patch.yml`：

```powershell
pnpm install; pnpm run bundle
node scripts/install-profile.mjs web
```

卸载：从 `$DSH_HOME/profiles/web/cordis.patch.yml` 删除对应 insert 行，从 `$DSH_HOME/profiles/web/package.json` 移除依赖后 `pnpm install`。

## 配置工作台条目

**直接在面板里改**：打开工作台 → 右上角「编辑」进入编辑模式：

- 条目：每个卡片出现「编辑 / 删除」按钮；分组头部出现「重命名 / + 条目 / 删除分组」；底部「+ 新建分组」。
- 编辑表单：名称（必填）、描述、目标类型（网页 URL / 本机路径 / 技能提示词）、目标值。保存立即写回配置并刷新面板。

配置文件写入 **`$DSH_HOME/whaletv-workbench/workbench.json`**（**本地用户文件，不入 git**，由面板自动创建）。仓库里只带模板 `config/workbench.example.json`：首次读取没有用户文件时自动使用模板，第一次在面板里保存后生成自己的配置。因为配置存到 `$DSH_HOME` 而不是插件目录，「面板改配置」与「一键更新」的 `git pull` 永不冲突。旧版把 `workbench.json` 存在插件目录内的用户会在下次读取时被自动迁移到新路径。

每条目的动作由字段决定（三者取一）：`url` → 新标签页打开网页；`path` → 宿主默认程序打开本地文件/应用；`prompt` → 技能（复制提示词 + 新建会话）。都为空则显示「待配置」。

## 一键更新

1. 本目录已是 git 仓库，只需关联远程：`git remote add origin <仓库地址>` 并推送（未配置远程时点击更新会给出明确提示）。
2. 面板顶部「更新」→ `git pull --ff-only`；有提交时自动 `pnpm install` + 重建 bundle + 热注入。
3. 更新日志展示在面板底部；`needRestart` 提示出现时（服务端代码变更），重启 `dsh web` 后生效。

## 目录结构

```
├── package.json            # dsh.bundle.patch + dsh.client 声明 + 构建脚本
├── cordis.patch.yml        # Bundle patch layer（`dsh plugin add` 自动挂载）
├── tsdown.config.ts        # 双面构建（Host lib + 浏览器 closure-factory bundle）
├── config/workbench.example.json  # 条目模板（面板保存后生成本地 workbench.json）
├── LICENSE                 # MIT
├── CHANGELOG.md            # 版本日志（每次发版一条条目）
├── assets/workbench.svg    # 工作台图标（矢量，构建时内嵌）
├── docs/DESIGN.md          # 设计与 UI 规划（初版形态 + 路线图）
├── scripts/
│   ├── gen-icon.mjs         # 图标 SVG → data URL 模块
│   ├── link-harness-deps.mjs   # 镜像 $DSH_HOME/profiles/node_modules 回退
│   ├── install-profile.mjs     # 一键安装到 dsh web profile
│   ├── smoke-client.mjs        # client bundle 冒烟测试（脚本级，无需浏览器）
│   ├── smoke-apply.mjs         # apply() 注册契约测试（slot 名称/id/共享 store）
│   └── smoke-host.mjs          # Host 配置路由测试（保存/校验/读回，自动备份还原用户配置）
└── src/
    ├── index.ts            # Host 半：state / config / update 路由
    ├── shared.ts           # 双面共享的 wire 类型
    └── client/             # Browser 半：入口 + 面板 + store
```

## 已知边界（初版）

- 配置为面板可编辑的本地 JSON 文件（`$DSH_HOME/whaletv-workbench/workbench.json`）；改动立即生效，无需重建。
- 浏览器侧更新依赖 dev 模式的 HMR（`pnpm run dev:web`）自动刷新；生产模式更新后手动刷新页面一次。
- Host 半刻意保持轻量稳定，使绝大多数更新只需重建 client bundle；服务端变更需重启 dsh。

## 安全说明

静态扫描会在以下位置标注告警，均为本插件核心能力所必需，且已按安全模式实现：

- **`src/index.ts` / `scripts/install-profile.mjs` 使用 `child_process`**：为「一键自更新」流水线所需（`git pull` → `pnpm install` → `pnpm run bundle` → 热注入）。全部使用 `execFile` / `execFileSync` + **数组参数** + **硬编码命令**，不拼接用户输入，无 shell 注入路径。Windows 上对 `pnpm/npm` 启用 `shell: true` 是因为它们是 `.cmd` shim，此时参数亦全部硬编码。
- **HTTP 路由 `/whaletv/workbench/*`**：由 dsh 的 `webServer` 挂载在**一个** `kind: 'prefix'` 位上（内部按子路径分发），默认仅绑定 `127.0.0.1`（同源）；`POST /config` 的 JSON body 只用于写 `workbench.json`，经白名单校验（字段白名单、id 唯一、条目/分组数量上限、512KB body 上限），不进入任何 exec 参数。`POST /skills/install` 只写 `$DSH_HOME/skills/<name>/SKILL.md`（对 name 做 kebab-case 强校验），不接受任意路径；`POST /session/followup` 只调 `agent.followup()`（模型输入通道，不执行代码）。
- **`src/client/index.ts` `window.open`**：使用 `_blank` + `noopener,noreferrer`（阻断新页面对 opener 的引用）。
- **`process.env` 读取**：仅 `DSH_HOME`（安装目录定位）与 `NODE_ENV`（构建期常量）两处，标准用法。

## Learn more

本项目对齐了 DeepSeek Harness 官方规范；深入了解各契约与 API 的原始文档：

- [Package and install](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) — `dsh.bundle.patch` 与 `dsh plugin add` 的入库机制（本项目 `cordis.patch.yml` 的来源）
- [CLI behavior reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md) — profile boot / plugin management / web alias / 层叠优先级
- [Your first plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/) — `apply(ctx)` 与 `ctx.effect` / `inject` 契约（本项目 Host 半基础）
- [Skills subsystem](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/skills) — `ctx.skills` / 本地发现根 / SkillProvider（工作台"技能"专区背后的 API）
- [User Settings](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/settings) + [Adding a settings card](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-settings-card) — `ctx.settings` 命名空间 + Web 设置页卡片
- [Web server](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-server) — `ctx.webServer` 的 exact / prefix 路由匹配（本项目所有 HTTP 路由）
- [Client modules](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/client-modules) — `dsh.client` 声明与 `WebBootGraph`（浏览器半自动发现的机制）

## 版本

当前版本 **v0.3.0**。每次发版的变更详见 [CHANGELOG.md](./CHANGELOG.md)。面板顶部会显示实际运行的版本号（读自 `package.json`），跟这里对齐即可。

## License

MIT — 详见 [LICENSE](./LICENSE)。
