# SuperThread 已实现功能清单

> 用途：产品 Review
>
> 盘点基线：2026-09-26，基于当前仓库源码、界面实现与自动化测试整理。本文只描述已经落地的能力；规划项与推测能力不计入“已实现”。

## 1. 产品定位与当前范围

SuperThread 是一个面向 macOS 的本地桌面开发工作台，用 Work Thread 组织一组相关工作，在本机或 SSH 远程设备上管理 Git 项目、创建隔离 Workspace，并在 Workspace 中运行和切换持久化记录的终端会话。

当前核心对象及关系：

```text
Work Thread
  └── Workspace = Project × Device × Git Worktree
        └── Session（Terminal / Codex / tmux）
```

当前产品边界集中在以下五类对象：

- **Work Thread**：面向用户的工作主题，用于聚合多个 Workspace。
- **Project**：由 canonical Git remote 标识的逻辑代码项目，不等同于某个本地目录。
- **Device**：实际执行文件系统、Git、SSH 和终端操作的本机或远程机器。
- **Workspace**：某个 Project 在某个 Device 上为一项工作创建的隔离 Git worktree。
- **Session**：Workspace 内的 shell、Codex CLI 或 tmux 终端会话。

## 2. 功能总览

| 分类 | 已实现能力 | 当前状态 |
| --- | --- | --- |
| 工作组织 | Work Thread 创建、查看、归档、恢复、删除 | 已实现 |
| 项目管理 | 导入 Git 仓库、本机 Clone、项目重命名与删除 | 已实现 |
| 设备管理 | 本机自动注册、SSH 远程设备增删改、连接检测 | 已实现 |
| SSH 隧道 | 本地转发、反向转发、断线重连、唤醒重连 | 已实现 |
| Workspace | 按 Work Thread × Project × Device 创建隔离 worktree | 已实现 |
| Workspace 安全删除 | 脏文件、未跟踪文件、未合并提交检查及强制删除确认 | 已实现 |
| 终端 | shell / Codex / tmux 会话创建、切换、恢复、关闭 | 已实现 |
| 会话管理 | 重命名、拖拽排序、状态提示、输出回放、未读结果 | 已实现 |
| 外部工具 | 本地及 Remote SSH Workspace 在 VS Code 中打开 | 已实现 |
| 桌面体验 | macOS 原生窗口壳、菜单快捷键、可折叠侧栏、Focus 模式 | 已实现 |
| 本地数据 | JSON 快照持久化、原子写入、旧版本数据迁移 | 已实现 |

## 3. Work Thread：工作主题管理

### 3.1 创建与浏览

- 创建 Work Thread，并用名称表示一个工作主题或目标。
- 名称会自动去除首尾空格，并在忽略大小写后保持全局唯一。
- 侧栏以树形结构展示所有活跃 Work Thread，可展开查看其 Workspace。
- “All work threads” 页面显示 Work Thread 列表和每个 Work Thread 的 Workspace 数量。
- 点击活跃 Work Thread 可进入其 Workspace 范围视图。

### 3.2 生命周期管理

- 支持归档 Work Thread；归档不会删除其 Workspace，也不会停止正在运行的终端。
- 已归档 Work Thread 及其 Workspace 从日常活跃视图中隐藏。
- 支持在 Active / Archived 两个列表间切换，并恢复已归档 Work Thread。
- 仅空 Work Thread 可以永久删除；存在 Workspace 时禁止删除。
- 删除最后一个 Workspace 后，所属 Work Thread 仍会保留。

## 4. Project：逻辑 Git 项目管理

### 4.1 添加项目

支持两种入口：

1. **Import existing**：在选定 Device 上导入已有 Git 仓库。
2. **Clone URL**：通过 Git URL Clone 到本机指定父目录。

导入或 Clone 时会自动读取：

- 仓库根目录；
- `origin` remote；
- 默认分支；
- 默认项目名。

Project 按规范化后的 Git remote 去重。同一个逻辑 Project 可以在多台 Device 上分别拥有 checkout，而不会重复创建 Project。

### 4.2 项目在设备上的可用性

- 系统记录 Project 与 Device 之间的 checkout 关系及仓库路径。
- 创建 Workspace 时，如果 Project 尚未在目标 Device 上可用，会先引导完成 Project setup。
- 本机支持 Clone 或导入已有仓库。
- 远程设备当前仅支持导入已经存在的仓库，不支持由应用发起远程 Clone。
- 为已有 Project 添加 checkout 时，会校验所选仓库的 `origin` 是否与 Project 匹配。
- 远程路径支持在应用内逐级浏览目录；本机路径使用系统目录选择器。

### 4.3 名称与删除规则

- Project 名称支持编辑，并在忽略大小写后保持全局唯一。
- 名称不能为 `.`、`..`，不能包含 `/` 或 `\`，避免生成不安全的 Workspace 路径。
- 不同 remote 推导出同名 Project 时，会在 Clone 前阻止操作，并要求用户输入唯一名称。
- “All projects” 页面汇总每个 Project 的 remote、默认分支、checkout 数、所在设备和 Workspace 数。
- 仅当 Project 不再拥有 Workspace 时才允许删除。
- 删除 Project 只移除 SuperThread 中的 Project 和 checkout 记录，不删除设备上的仓库目录。

## 5. Device：本机与远程设备管理

### 5.1 本机设备

- 首次启动时自动创建并注册当前 Mac，名称取自主机名。
- 本机状态固定按在线处理。
- 本机设备由应用管理，不允许编辑或删除。

### 5.2 SSH 远程设备

- 添加远程设备时可配置名称、Host、SSH User 和 Port。
- 使用系统已有 SSH key 与 `~/.ssh/config` 完成认证，应用不保存密码。
- 支持编辑远程设备的名称、连接地址、用户、端口和隧道配置。
- 支持主动检查所有设备连接状态，并展示 `online`、`offline`、`unknown`。
- 远程设备有关联 checkout 或 Workspace 时禁止删除；清空关联后可删除连接配置。
- 文件系统、Git、目录浏览、终端和工具探测均在 Workspace 所属 Device 上执行。

### 5.3 SSH 端口转发

每台远程设备可配置最多 32 条 SSH 隧道：

- **Local → Remote**：本地端口转发（`ssh -L`）。
- **Remote → Local**：反向端口转发（`ssh -R`）。
- 每条规则可设置源端口、目标 Host 和目标端口。
- 同一转发方向下禁止配置重复源端口。
- 监听地址固定为 `127.0.0.1`，不向局域网公开端口。
- 使用 SSH keepalive 检测连接健康状态。
- 隧道异常退出后按 1 秒起步、最长 30 秒的退避策略自动重连。
- macOS 从休眠恢复时会主动重建所有已配置隧道。
- 编辑或删除设备配置时，相应隧道会同步重启或停止。

## 6. Workspace：隔离工作区

### 6.1 创建流程

创建 Workspace 时选择：

- Work Thread；
- Project；
- Device；
- Workspace 名称；
- Base branch。

系统随后会：

1. 校验 Work Thread 处于活跃状态。
2. 校验 Project 已在目标 Device 上建立 checkout。
3. 校验 Workspace 名称仅包含字母、数字、`.`、`_`、`-`。
4. 在同一 Device 上校验 Workspace 名称唯一。
5. 创建 `work/<workspace-name>` 分支。
6. 在 `~/.superthread/workspaces/<project-name>/<workspace-name>` 创建独立 Git worktree。
7. 自动创建第一个 `Terminal 1` 会话。

本机和远程设备均支持创建 worktree；远程操作通过 SSH 在目标 Device 上执行。

### 6.2 状态与信息展示

- Workspace 具有 `creating`、`ready`、`error` 状态。
- 顶部展示完整归属链：Work Thread / Project / Workspace。
- 同时展示 Device、当前工作分支和各类 Session 状态汇总。
- 详情浮层可查看 Base branch 和 Workspace 实际路径。
- 可从 All workspaces、指定 Work Thread 或指定 Project 范围筛选 Workspace。
- 已归档 Work Thread 下的 Workspace 不出现在活跃 Workspace 视图中。

### 6.3 失败回滚与安全删除

- worktree 或首个终端创建失败时，会尝试自动回滚已创建的 worktree、分支和元数据。
- 若自动回滚也失败，会保留 `error` 状态及错误详情，避免静默丢失现场。
- 删除 Workspace 前检查：
  - 未提交变更；
  - 未跟踪文件；
  - 尚未合并进 Base branch 的提交。
- 存在风险时默认阻止删除，并列出原因；用户二次确认后可强制删除。
- 删除会移除 worktree、`work/*` 分支及其 Session 记录。

### 6.4 外部打开

- 支持一键在 Visual Studio Code 中打开 Workspace。
- 本机 Workspace 使用 `vscode://file`。
- 远程 Workspace 使用 VS Code Remote SSH URL，并携带 SSH 用户、Host、非默认端口和远程路径。

## 7. Terminal Session：终端与工具会话

### 7.1 会话类型

每个 Workspace 支持创建多个 Session：

- **Terminal**：普通交互式 shell。
- **Codex**：直接启动 Codex CLI。
- **tmux**：创建或连接由 Workspace 管理的 tmux session/window。

创建 Codex 或 tmux 会话前会在目标 Device 上检查对应命令是否可用；工具缺失时自动降级为普通 Terminal，并向用户显示警告。

### 7.2 基础交互

- 终端基于 xterm.js，支持输入、ANSI 输出、光标、滚动缓冲区和 macOS 输入法。
- 终端尺寸随面板变化自动适配，并同步 resize 到 PTY。
- Workspace 切换时保留各 Workspace 的最后活跃 Session。
- 支持 Session 标签切换、双击重命名、拖拽排序和关闭。
- Session 顺序和名称持久化保存。
- 创建失败时保留临时标签，可重试或关闭。
- 已退出或恢复失败的 Session 可原位 Resume，也可新建同类型 Session。

### 7.3 Session 状态与结果提醒

- Session 运行状态包括 `running`、`exited`、`restore-failed`。
- 活动状态包括 `idle`、`busy`、`waiting-input`。
- 普通 Terminal 通过前台进程组判断是否正在执行任务。
- tmux 通过 pane 当前命令与近期输出判断空闲、执行中或等待输入。
- Codex 通过终端输出和会话索引识别执行状态、完成结果及 conversation ID。
- 后台 Session 完成任务后会显示未读标记；用户切回该 Session 且窗口可见时自动清除。
- Workspace Header 汇总 running、waiting 和 restore failed 数量。
- 关闭正在执行任务的 tmux Session 时会额外确认，并清理对应 tmux window 或 session。

### 7.4 持续运行与恢复语义

- 在 macOS 上只关闭窗口不会退出应用；主进程仍在运行，PTY 可继续执行。
- 重新打开窗口时，renderer 会重新 attach，并回放当前运行时保留的最近约 64 KB 输出，然后继续接收实时输出。
- 完全退出应用前，如果存在 `busy` Session，会展示运行任务清单并要求确认。
- 完全退出后，原 PTY 进程不会被应用保证继续存活；下次启动会基于持久化 Session 记录尝试恢复。
- Codex conversation ID 会持久化，恢复时使用 `codex resume <conversation-id>`。
- 带 conversation ID 的 Codex 会话异常退出时会自动尝试一次恢复；系统唤醒后也会重试可恢复的 Codex 会话。
- tmux Session 使用稳定名称和窗口标识重新连接；同一 Workspace 的多个 tmux 标签共享一个 tmux session、对应不同 window。
- 普通 shell 的 Resume 是在原 Workspace 路径重新启动 shell，不恢复此前 shell 的内存态或完整滚动历史。

## 8. 桌面工作台与导航

### 8.1 主界面

- 左侧栏提供 All workspaces、All projects、All work threads、All devices 四个一级入口。
- Work Thread 树可展开 Workspace，并同时显示所属 Project 名称和本地/远程设备图标。
- 侧栏支持拖动调整宽度，范围为 184–340 px；也可折叠和重新展开。
- 侧栏范围、宽度、展开节点、当前 Workspace 和各 Workspace 当前 Session 会保存在本地 UI 状态中。
- Workspace 之间切换时，各终端视图保持挂载，减少重复 attach 和界面状态丢失。

### 8.2 Focus 模式

- Workspace 可进入 Focus 模式，隐藏侧栏和常规 Workspace Header，只保留终端与退出按钮。
- 进入/退出时同步调整 macOS 交通灯位置。
- Focus 模式只作用于本次 renderer 运行，不写入持久化 UI 状态。

### 8.3 macOS 桌面体验

- 无普通标题栏窗口，保留并定位 macOS 红黄绿交通灯。
- 页面提供明确的可拖拽区域和不可拖拽交互控件。
- 关闭最后一个窗口后应用仍驻留；从 Dock 再次激活可重新创建窗口。
- 使用原生应用菜单和常用快捷键：
  - `⌘N`：New Work Thread；
  - `⌘⇧N`：New Workspace；
  - `⌘T`：New Terminal；
  - `⌘⇧P`：Add Project；
  - `⌘⇧D`：Add Device。
- 原生菜单同时提供标准编辑、缩放、开发者工具、全屏、窗口和退出操作。

## 9. 数据持久化与运行时边界

### 9.1 已持久化数据

- Work Thread、Project、Device、SSH 连接和隧道配置；
- Project checkout；
- Workspace、worktree 路径、分支和 Base branch；
- Session 类型、名称、顺序、状态、工作目录和恢复元数据；
- Codex conversation ID、tmux session/window 标识和未读结果状态；
- 部分工作台 UI 偏好。

领域数据保存在：

```text
~/Library/Application Support/super-thread/workspace-runtime.json
```

开发版和打包版共用这一稳定目录。

### 9.2 存储可靠性

- 更新时先写临时文件，再通过 rename 替换正式文件，降低写入中断导致文件损坏的风险。
- 当前 schema version 为 4。
- 支持旧快照字段补全与迁移，不会因为升级直接清空已有数据。
- renderer 无 Node.js 直接访问能力；文件系统、Git、SSH、PTY 与外部 URL 均通过经过输入校验的窄 IPC bridge 调用主进程。

## 10. 关键用户流程

### 10.1 首次使用

```text
启动应用
  → 自动注册当前 Mac
  → Add Project（导入或 Clone）
  → New Work Thread
  → New Workspace
  → 自动创建 worktree、work/* 分支和 Terminal 1
```

### 10.2 在远程设备上工作

```text
Add Device（SSH）
  → 可选配置端口转发
  → 导入远程设备上的已有仓库
  → 为 Work Thread 创建远程 Workspace
  → 创建 Terminal / Codex / tmux Session
  → 可选用 VS Code Remote SSH 打开
```

### 10.3 继续之前的工作

```text
关闭窗口（不退出 App）
  → PTY 在主进程中继续运行
  → 重新打开窗口
  → attach + 输出回放

完全退出并重新启动
  → 加载持久化快照
  → 尝试重建可恢复 Session
  → 成功则继续；失败则显示原因并允许 Resume / 新建
```

## 11. 当前限制与非目标

以下能力当前没有实现，不应在产品 Review 中按已有功能验收：

- Windows / Linux 桌面端适配与验证；当前产品和打包配置面向 macOS。
- 应用内账号、多用户、权限系统、云同步或 Cloud Relay。
- Task、Agent、Workflow、Review、Automation、Memory 等上层工作流对象。
- PR 管理、代码评审、文件浏览器、Diff 编辑器或内置代码编辑器。
- SSH 密码托管或密钥管理；依赖系统 SSH 环境。
- 由应用在远程设备上执行 Git Clone；远程项目需先有可导入的仓库目录。
- Project checkout 的独立删除 UI；目前 checkout 随 Project 记录一并清理，且不会删除磁盘仓库。
- Work Thread 重命名。
- Workspace 重命名、跨 Work Thread 移动或跨 Device 迁移。
- 普通 shell 在 App 完全退出后的进程级续接；Resume 会新建 shell。
- 完整终端历史的长期存档；运行时只保留有限输出缓冲。
- SSH 隧道运行状态、错误原因和重连次数的独立可视化页面。
- Settings 页面；原生菜单中的 Settings 当前为禁用状态。
- 自动更新、登录启动、通知中心提醒和系统托盘菜单。

## 12. 产品 Review 建议关注点

1. **核心心智是否清晰**：用户能否理解 Work Thread、Project、Device、Workspace、Session 五层关系。
2. **首次使用成本**：当前必须先有 Project 和活跃 Work Thread 才能创建 Workspace，空状态是否足够引导。
3. **远程体验闭环**：远程仅支持导入已有仓库是否满足目标用户，是否需要补远程 Clone。
4. **“持久终端”预期**：窗口关闭可持续运行，但 App 完全退出后不同 Session 类型的恢复能力不同，产品文案需避免过度承诺。
5. **危险操作体验**：Workspace 强制删除会同时删除 worktree 与工作分支，二次确认和风险信息是否足够明确。
6. **状态可见性**：Session 的 busy / waiting / unread 已落地，但 SSH 隧道健康度仍不可见。
7. **对象管理完整性**：Work Thread、Project、Device 已有列表页；checkout 与 Workspace 的编辑/迁移能力仍有限。
