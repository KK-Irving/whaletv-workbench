# ADR 0003: 桌面端不做面板内重启，重启是手动操作

- 状态：已采纳（自 0.8.13，本文档补记于同一版本）
- 决策人：whaletv-workbench 维护者
- 相关：CHANGELOG 0.8.9 / 0.8.11 / 0.8.12 / 0.8.13、`src/restart.ts`、`src/pnpm-approval.ts`

## 背景

Host 半的代码只在 dsh 进程启动时加载（client bundle 才会热注入），所以「更新」之后必须重启 dsh 才生效。0.8.9 为此加了面板内「重启 dsh」按钮：

- 0.8.9：Electron 宿主一律判为「无法自救重启」→ 弹窗给出**启动命令**让用户自己跑；
- 0.8.11：加 `GET /state.capabilities`，让新面板能识别「服务端是旧代码」；
- 0.8.12：桌面端改为直接调用 Electron `app.relaunch()` + `app.exit()`。

结果是真实故障：桌面端用户点重启 → 被引导复制并运行那条命令 → **应用进入崩溃循环**，只能杀进程恢复。日志（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`）表现为反复的 `EADDRINUSE 127.0.0.1:19387` 与「Another DSH instance … is running」。

## 事实（读安装包的 shell 与 host 代码得到）

1. **进程模型**：桌面端是 shell（Electron 主进程，`resources/app.asar/lib/main.js`）用
   `spawn(node, [hostEntry, runtimeDir, projectDir, …], { stdio: ['ignore','pipe','pipe','ipc'] })`
   启动 harness；**本插件运行在这个 IPC 子进程里**，不是 Electron 主进程。
2. **没有重启通道**：shell → host 只有 `shutdown` / `quit-inspection` / `update-tasks`；host → shell 只有 `ready` / `platform-session` / `shutdown-complete` / `fatal` 与 `requestId` 控制响应。协议中不存在任何 restart 语义。
3. **自行退出 = 崩溃**：shell 的 `child.once('close')` 对 `code !== 0` 与 `code === 0` 都调用 `fail()`（日志为 `dsh desktop host exited with N` / `dsh desktop host stopped`），不触发任何重启。
4. **子进程命令行不可复制**：`Harness.exe <app.asar>/…/dsh-desktop-host/lib/index.js …` 只有在 shell 注入 `ELECTRON_RUN_AS_NODE=1` 等环境时才成立。手工运行 = 启动**第二个应用实例**：抢占 `127.0.0.1:19387`（`EADDRINUSE`）、触发单实例锁（`startupAddressInUse`），旧实例半死、新实例起不来。
5. **真正的入口在 shell 侧**：shell 菜单项 `restartAppHostMenu`（「Restart App and Host」/「重启 App 和 Host」），由用户或 shell 的更新流程触发。

## 决策

重启能力按宿主形态分流，且**只在能忠实复现启动方式时才由插件执行**：

| 宿主 | `strategy` | 行为 |
| --- | --- | --- |
| 普通 Node CLI（`dsh web`） | `helper` | 写入分离助手（`$DSH_HOME/whaletv-workbench/.restart/`）→ 路由先返回响应 → 进程退出 → 助手等父进程回收、给托管方 3s 抢跑窗口，再按捕获的命令拉起 |
| 桌面端（`process.versions.electron`） | `manual` | `relaunchable: false`、**`command: ''`**、`externalAction` = 托盘菜单 →「Restart App and Host」 |
| systemd 托管（`INVOCATION_ID`） | `manual` | 同上，指向服务管理器（退出会连带 cgroup 杀掉替代进程） |
| 启动入口无法识别 | `manual` | 同上，不给命令 |

面板只在 `relaunchable === true` 时渲染「重启 dsh」按钮；否则显示入口徽标（悬停给出完整说明）。桌面端**不返回任何可复制命令**——那条命令按构造就是不安全的。

## 理由

1. **不可能 ≠ 要假装可能**：桌面端没有 host → shell 的重启通道，任何"实现"都只有两条路——杀掉自己被判崩溃，或起第二个实例触发端口/锁冲突。
2. **不给危险命令**：把只在特定环境下成立的命令行当作"手动兜底"交给用户，等于把崩溃风险外包给用户。
3. **保留真正可行的自动化**：`dsh web`（服务器 / 无桌面）场景由分离助手完成重启，对用户零操作；这才是按钮存在的地方。

## 后果

- 桌面端用户每次更新后仍需点一次菜单的「Restart App and Host」——这是**平台约束**，不是缺功能；面板会明确写出该入口。
- `requestRestart` 只保留 helper 路径；`strategy` 类型收窄为 `helper | manual`（0.8.12 的 `electron` 分支已删除）。
- 版本偏斜（client 新 / host 旧）由 `GET /state.capabilities` 显式暴露，避免把「路由不存在」当成普通错误抛给用户。
- **若 dsh 将来在 IPC 协议里加入 restart（或暴露 shell 侧重启 API），本 ADR 必须重新评估**：届时桌面端可回到 `relaunchable: true` 并恢复按钮。
