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

前置：Node ≥ 22、pnpm、dsh 已运行过一次（生成 `$DSH_HOME/profiles` 回退目录）。

```powershell
# 在本项目目录
pnpm install                # 安装构建工具（tsdown / lightningcss 等）
pnpm run bundle             # 构建 Host 半 lib/index.js + 浏览器半 lib/client.js
node scripts/install-profile.mjs web   # 写入 profile 依赖 + pnpm install + 插入 cordis.patch.yml 插件行
```

完成后刷新 `http://127.0.0.1:3080`（若 dsh web 正在运行，patch 热重载会直接挂载并自动推送新插件）。

卸载：

```powershell
# 从 $DSH_HOME/profiles/web/cordis.patch.yml 删除 whaletv-workbench 的 insert 行
# 从 $DSH_HOME/profiles/web/package.json 删除 whaletv-workbench 依赖，然后：
cd $env:USERPROFILE\.dsh\profiles\web; pnpm install
```

## 配置工作台条目

**直接在面板里改**：打开工作台 → 右上角「编辑」进入编辑模式：

- 条目：每个卡片出现「编辑 / 删除」按钮；分组头部出现「重命名 / + 条目 / 删除分组」；底部「+ 新建分组」。
- 编辑表单：名称（必填）、描述、目标类型（网页 URL / 本机路径 / 技能提示词）、目标值。保存立即写回配置并刷新面板。

配置文件是插件目录下的 `config/workbench.json`（**本地用户文件，不入 git**，由面板自动创建）。仓库里只带模板 `config/workbench.example.json`：新拉取的目录没有 `workbench.json` 时会自动以模板展示，第一次在面板里保存后生成自己的配置。这样「面板改配置」与「一键更新」的 `git pull` 永不冲突。

每条目的动作由字段决定（三者取一）：`url` → 新标签页打开网页；`path` → 宿主默认程序打开本地文件/应用；`prompt` → 技能（复制提示词 + 新建会话）。都为空则显示「待配置」。

## 一键更新

1. 本目录已是 git 仓库，只需关联远程：`git remote add origin <仓库地址>` 并推送（未配置远程时点击更新会给出明确提示）。
2. 面板顶部「更新」→ `git pull --ff-only`；有提交时自动 `pnpm install` + 重建 bundle + 热注入。
3. 更新日志展示在面板底部；`needRestart` 提示出现时（服务端代码变更），重启 `dsh web` 后生效。

## 目录结构

```
├── package.json            # dsh.client 声明（platform: web）+ 构建脚本
├── tsdown.config.ts        # 双面构建（Host lib + 浏览器 closure-factory bundle）
├── config/workbench.example.json  # 条目模板（面板保存后生成本地 workbench.json）
├── LICENSE                 # MIT
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

- 配置为面板可编辑的本地 JSON 文件（`config/workbench.json`）；改动立即生效，无需重建。
- 浏览器侧更新依赖 dev 模式的 HMR（`pnpm run dev:web`）自动刷新；生产模式更新后手动刷新页面一次。
- Host 半刻意保持轻量稳定，使绝大多数更新只需重建 client bundle；服务端变更需重启 dsh。

## 安全说明

静态扫描会在以下位置标注告警，均为本插件核心能力所必需，且已按安全模式实现：

- **`src/index.ts` / `scripts/install-profile.mjs` 使用 `child_process`**：为「一键自更新」流水线所需（`git pull` → `pnpm install` → `pnpm run bundle` → 热注入）。全部使用 `execFile` / `execFileSync` + **数组参数** + **硬编码命令**，不拼接用户输入，无 shell 注入路径。Windows 上对 `pnpm/npm` 启用 `shell: true` 是因为它们是 `.cmd` shim，此时参数亦全部硬编码。
- **HTTP 路由 `/whaletv/workbench/*`**：由 dsh 的 `webServer` 挂载，默认仅绑定 `127.0.0.1`（同源）；`POST /whaletv/workbench/config` 的 JSON body 只用于写 `config/workbench.json`，经白名单校验（字段白名单、id 唯一、条目/分组数量上限、512KB body 上限），不进入任何 exec 参数。
- **`src/client/index.ts` `window.open`**：使用 `_blank` + `noopener,noreferrer`（阻断新页面对 opener 的引用）。
- **`process.env` 读取**：仅 `DSH_HOME`（安装目录定位）与 `NODE_ENV`（构建期常量）两处，标准用法。

## License

MIT — 详见 [LICENSE](./LICENSE)。
