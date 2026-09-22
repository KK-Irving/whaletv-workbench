# ADR 0001: 用户配置与状态放 $DSH_HOME，不放插件目录

- 状态：已采纳（自 0.3.0，本文档补记于 0.7.0）
- 决策人：whaletv-workbench 维护者

## 背景

工作台有三类用户态数据：条目配置（workbench.json）、自更新历史（updates.json）、最近使用（usage.json）、技能版本记录（installed-skills.json）。初版把 workbench.json 放在插件目录内（`<plugin>/config/workbench.json`）。

## 决策

所有用户态数据统一放在 `$DSH_HOME/whaletv-workbench/`：

```
$DSH_HOME/whaletv-workbench/
├── workbench.json          # 条目配置
├── updates.json            # 自更新历史（滚动 20 条）
├── usage.json              # 最近使用（滚动 500 条）
├── installed-skills.json   # 技能版本记录（来源 URL + SHA）
├── icons/                  # favicon 缓存
└── .staging/               # git 导入临时区（启动时清扫）
```

## 理由

1. **与自更新共存**：插件目录是 `git pull --ff-only` 的作用域——用户数据放在里面迟早和 pull 冲突（冲突、误提交或被覆盖）。
2. **安装形态无关**：`dsh plugin add` 可以是 `link:` 也可以是拷贝；只有 $DSH_HOME 里的数据在重装/升级插件后必然存活。
3. **迁移成本一次性**：旧路径在首次读取时自动迁移到新路径（legacy 分支保留至今，待 1.0 移除）。

## 后果

- Host 的所有写路径都锚定 `WORKBENCH_STATE_DIR`，删除插件不影响用户数据。
- 技能版本记录刻意不走 `ctx.settings`（schema 保持扁平、老用户层零迁移），见 0003 的同一逻辑。
