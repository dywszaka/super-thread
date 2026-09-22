# Workspace Runtime MVP Spec

## 1. Goal

构建一个面向本地及远程开发环境的 Workspace Manager。

MVP 只解决一个问题：

> 用户可以用 WorkThread 组织相关工作，在不同 Device 上管理 Project，为 WorkThread 创建隔离的 Workspace，并在 Workspace 中创建和恢复持久 Terminal Session。

核心模型：

```text
WorkThread
   │ groups 1:N
   ▼
Workspace ─── Project × Device
   │
   │ contains
   ▼
Terminal Session
```

其中：

- WorkThread：组织一组相关 Workspace 的顶级对象
- Project：逻辑 Git 项目
- Device：实际执行工作的机器
- Workspace：Project 在某个 Device 上的一份隔离 Working Copy
- Session：Workspace 中一个持久 Terminal / PTY

MVP 不包含：

- Task
- Agent
- Agent workflow
- Review workflow
- Automation
- Memory
- Cloud Relay
- PR 管理
- 多用户
- 权限系统
- SaaS

---

# 2. Design Principles

## 2.1 Project != Directory

Project 表示逻辑上的代码项目，而不是某台机器上的目录。

例如：

```text
Project
  llama.cpp

Device
  MacBook
  dev-cuda
```

同一个 Project 可以存在于多个 Device：

```text
llama.cpp
├── MacBook
│   └── ~/code/llama.cpp
│
└── dev-cuda
    └── /data/allen/llama.cpp
```

不能因为路径不同创建两个 Project。

---

## 2.2 Workspace owns runtime context

Workspace 是一次工作的 runtime container。

它拥有：

```text
Workspace
├── Device
├── Project
├── Working Directory
├── Git Worktree
├── Git Branch
└── Terminal Sessions
```

而不是把：

```text
cwd
branch
worktree
session
```

挂到 Project 上。

---

## 2.3 Session is ephemeral process, Workspace is durable context

Session 可以结束、重启或重新创建。

Workspace 保留：

```text
filesystem
git changes
branch
working directory
```

因此：

```text
Session #1
     ↓
   exit

Workspace still exists

     ↓

Session #2
```

Session #2 可以继续之前的工作。

---

## 2.4 Device owns execution

任何文件系统、Git、PTY 操作都必须由 Workspace 所属 Device 执行。

Control Plane 不直接操作远程文件系统。

```text
Desktop App
     │
     │ command
     ▼
Device Runtime
     │
     ├── filesystem
     ├── git
     ├── PTY
     └── process
```

---

# 3. Domain Model

核心对象只有五个：

```text
WorkThread
Project
Device
Workspace
Session
```

关系：

```text
                 WorkThread
                      │ 1:N
                      ▼
                  Workspace
                      │ 1:N
                      ▼
                   Session

                   Project
                      │
                      │ 1:N
                      ▼
              ProjectCheckout
                      ▲
                      │
                    Device
                      │
                      │
                      ▼
                  Workspace
```

其中 `ProjectCheckout` 是内部数据结构，不作为主要 UI 对象暴露。

---

# 4. Project

Project 是一个逻辑 Git Repository。

数据结构：

```ts
interface Project {
  id: string

  name: string

  // canonical git remote
  repositoryUrl: string

  createdAt: Date
  updatedAt: Date
}
```

例如：

```json
{
  "id": "proj_llamacpp",
  "name": "llama.cpp",
  "repositoryUrl": "git@github.com:ggml-org/llama.cpp.git"
}
```

Project 不保存：

```text
cwd
local path
branch
worktree
device
```

这些都不是 Project identity。

---

# 5. Device

Device 表示一台能够实际执行 Workspace 的机器。

MVP 支持：

```text
Local Device
Remote Device
```

数据结构：

```ts
interface Device {
  id: string

  name: string

  type: "local" | "remote"

  status:
    | "online"
    | "offline"
    | "unknown"

  createdAt: Date
}
```

例如：

```json
{
  "id": "dev_local",
  "name": "MacBook",
  "type": "local",
  "status": "online"
}
```

远程：

```json
{
  "id": "dev_cuda",
  "name": "dev-cuda",
  "type": "remote",
  "status": "online"
}
```

---

# 6. Device Runtime

每台 Device 运行一个轻量 Runtime。

```text
Device Runtime
│
├── Project Manager
├── Workspace Manager
├── Git Manager
├── Session Manager
└── PTY Manager
```

Local Device：

```text
Desktop App
     │
     ▼
Local Runtime
```

Remote Device：

```text
Desktop App
     │
     │ transport
     ▼
Remote Runtime
```

MVP 不定义 Cloud Relay。

Remote transport 可以先使用：

```text
SSH
```

未来可以替换：

```text
SSH
Tailscale
WebSocket Relay
Cloud Relay
```

Runtime API 不应该感知 transport。

---

# 7. ProjectCheckout

ProjectCheckout 表示：

> 一个 Project 在某个 Device 上的物理 checkout。

数据结构：

```ts
interface ProjectCheckout {
  id: string

  projectId: string
  deviceId: string

  path: string

  createdAt: Date
}
```

例如：

```text
Project:
llama.cpp

        │

        ├── ProjectCheckout
        │   device = MacBook
        │   path = ~/code/llama.cpp
        │
        └── ProjectCheckout
            device = dev-cuda
            path = /data/allen/llama.cpp
```

唯一约束：

```text
(projectId, deviceId)
```

MVP 一个 Project 在一个 Device 上最多存在一个 base checkout。

---

# 8. Project Setup

Project 创建后，不代表它已经存在于某台 Device。

Project：

```text
llama.cpp
```

可能显示：

```text
MacBook      ✓ Setup
dev-cuda     Not Setup
dev3-cuda    Not Setup
```

用户可以执行：

### Clone

```text
Setup Project
→ Device: MacBook
→ Parent Directory: ~/code
```

Runtime：

```bash
git clone <repository-url> ~/code/llama.cpp
```

然后创建 ProjectCheckout。

Clone 只允许在 Local Device 执行。Remote Device 不显示 Clone 入口，服务层也必须拒绝远端 clone 请求。

### Import Existing Repository

如果已经存在：

```text
/data/allen/llama.cpp
```

用户选择：

```text
Import Existing
→ Device: dev-cuda
→ Browse: /data/allen/llama.cpp
```

Runtime 验证：

```bash
git -C /data/allen/llama.cpp rev-parse --show-toplevel
git -C /data/allen/llama.cpp remote get-url origin
```

验证成功后创建 ProjectCheckout。

---

# 9. WorkThread

WorkThread 是组织 Workspace 的顶级对象，不是 Task、Workflow 或执行状态。

```ts
interface WorkThread {
  id: string
  name: string
  status: "active" | "archived"
  createdAt: Date
  updatedAt: Date
  archivedAt?: Date
}
```

规则：

- 名称在 active 与 archived 范围内忽略大小写唯一。
- 一个 Workspace 必须且只能属于一个 WorkThread。
- WorkThread 可以暂时为空，也可以包含多个 Workspace。
- 归档只隐藏整组内容，不停止 Session 或删除 Git Worktree。
- 只有空 WorkThread 可以永久删除。

---

# 10. Workspace

Workspace 是整个系统最核心的 runtime abstraction。

定义：

> Workspace 是 Project 在某个 Device 上的一份隔离 Working Copy。

数据结构：

```ts
interface Workspace {
  id: string

  name: string

  workThreadId: string
  projectId: string
  deviceId: string
  checkoutId: string

  path: string

  branch: string
  baseBranch: string

  status:
    | "creating"
    | "ready"
    | "error"

  createdAt: Date
  updatedAt: Date
}
```

例如：

```json
{
  "id": "ws_nvfp4",
  "name": "nvfp4-kernel",
  "projectId": "proj_llamacpp",
  "deviceId": "dev_cuda",
  "path": "/data/workspaces/nvfp4-kernel",
  "branch": "work/nvfp4-kernel",
  "baseBranch": "master",
  "status": "ready"
}
```

---

# 11. Workspace Creation

用户：

```text
New Workspace

Work Thread:
Improve NVFP4

Project:
llama.cpp

Device:
dev-cuda

Name:
nvfp4-kernel

Base Branch:
master
```

系统首先查：

```text
ProjectCheckout(project, device)
```

不存在则：

```text
Project not setup on dev-cuda
```

要求先 Setup。

存在：

```text
/data/allen/llama.cpp
```

Runtime 执行：

```bash
git -C /data/allen/llama.cpp fetch

git -C /data/allen/llama.cpp worktree add \
  -b work/nvfp4-kernel \
  /data/workspaces/nvfp4-kernel \
  master
```

得到：

```text
Project
llama.cpp

base checkout
/data/allen/llama.cpp

        │
        ├── Workspace A
        │   /data/workspaces/nvfp4-kernel
        │
        └── Workspace B
            /data/workspaces/benchmark
```

---

# 12. Workspace Lifecycle

MVP 生命周期保持极简：

```text
creating
   │
   ▼
 ready
   │
   ▼
 delete
```

失败：

```text
creating
   │
   ▼
 error
```

不引入：

```text
Executing
Blocked
Review
Done
```

这些属于 Task / Workflow，而不是 Workspace。

---

# 13. Workspace Delete

删除 Workspace：

1. 停止所有 Session
2. 删除 Git Worktree
3. 可选删除 Branch
4. 删除 Workspace metadata

Runtime：

```bash
git worktree remove <workspace-path>
```

如果存在未提交修改：

```text
Workspace has uncommitted changes.
```

默认禁止删除。

用户必须明确选择：

```text
Force Delete
```

才允许：

```bash
git worktree remove --force
```

Branch 默认不删除。

---

# 14. Session

Session 表示 Workspace 中一个 Terminal Session。

```ts
interface Session {
  id: string

  workspaceId: string

  name: string

  status:
    | "running"
    | "exited"

  shell: string

  pid?: number

  createdAt: Date
  exitedAt?: Date
}
```

例如：

```json
{
  "id": "session_123",
  "workspaceId": "ws_nvfp4",
  "name": "Terminal 1",
  "status": "running",
  "shell": "/bin/zsh"
}
```

---

# 15. Terminal Runtime

创建 Session：

```text
Workspace
/data/workspaces/nvfp4-kernel

        ↓

PTY
cwd=/data/workspaces/nvfp4-kernel

        ↓

/bin/zsh
```

Runtime：

```text
Session Manager
       │
       ▼
PTY Manager
       │
       ▼
Shell Process
```

需要支持：

```text
stdin
stdout
stderr
resize
exit
```

UI 和 Runtime 之间：

```text
Terminal UI
     │
     │ websocket / local IPC
     ▼
Session Runtime
     │
     ▼
PTY
```

---

# 16. Session Persistence

MVP 的“持久”定义：

> UI 页面关闭或 Desktop App 断开，不杀掉 PTY process。

例如：

```text
Terminal
$ make -j32

Desktop App closed

        ↓

make continues running
```

重新打开：

```text
Desktop App
     ↓
Workspace
     ↓
Session
     ↓
Reconnect PTY
```

MVP 暂时不要求：

> Device Runtime 重启以后恢复同一个 PTY。

这需要 tmux / screen / process supervisor 等额外机制，可以放到 V2。

---

# 17. Main UI

MVP 只实现一个主界面。

不做：

```text
Project Settings Page
Workspace Detail Page
Task Page
Agent Page
```

所有核心操作都在主界面完成。

布局：

```text
┌───────────────────────────────────────────────────────────┐
│ WorkThread / Project / Workspace               + New      │
├───────────────┬───────────────────────────────────────────┤
│               │                                           │
│ All workspaces│  Improve FP4 / llama.cpp / nvfp4-kernel   │
│ All threads   │  dev-cuda · work/nvfp4-kernel             │
│ All devices   │                                           │
│               │                                           │
│ Projects      │                                           │
│ llama.cpp     │                                           │
│ modelopt      ├───────────────────────────────────────────┤
│ sglang        │                                           │
│               │                                           │
│ ───────────   │              Terminal                     │
│               │                                           │
│ Work Threads  │  $ git status                             │
│ ▾ Improve FP4 │  On branch work/nvfp4-kernel              │
│   nvfp4-kernel│                                           │
│ ▸ Benchmarks  │                                           │
│               │                                           │
├───────────────┴───────────────────────────────────────────┤
│ nvfp4-kernel     benchmark      quant-test                │
└───────────────────────────────────────────────────────────┘
```

---

# 18. UI Information Architecture

左侧栏负责选择 scope：

```text
All workspaces
All work threads
All devices

Projects

llama.cpp
modelopt
sglang

────────

Work Threads

▾ Improve FP4
  nvfp4-kernel
  quant-test
▸ Benchmarks
```

Project 和单个 WorkThread 都是 Workspace filter。All work threads 打开 active/archived 管理页面；All devices 打开 Device 管理页面，可查看连接状态和资源占用、添加或编辑 Remote Device、检测连接，并删除未被 checkout 使用的 Remote Device。Local Device 由应用管理，不能编辑或删除。归档 WorkThread 及其 Workspace 不出现在其他 active scope。

例如点击：

```text
Project: llama.cpp
```

显示所有 Device 上：

```text
llama.cpp

nvfp4-kernel
benchmark
loader-fix
```

点击 WorkThread 显示它包含的 Workspace：

```text
Improve FP4
├── nvfp4-kernel
└── quant-test
```

---

# 19. Workspace Switcher

底部或顶部提供 Workspace Tabs：

```text
[nvfp4-kernel] [benchmark] [loader-fix] [+]
```

切换 Workspace：

```text
Workspace A
     ↓
Terminal Sessions A

Workspace B
     ↓
Terminal Sessions B
```

Terminal 永远属于 Workspace。

---

# 20. Workspace Header

顶部只显示必要信息：

```text
llama.cpp / nvfp4-kernel

dev-cuda
work/nvfp4-kernel
```

可以展开查看：

```text
Project
llama.cpp

Device
dev-cuda

Branch
work/nvfp4-kernel

Base
master

Path
/data/workspaces/nvfp4-kernel
```

---

# 21. Terminal Area

Workspace 默认创建一个 Session：

```text
Terminal 1
```

允许：

```text
+ New Terminal
```

例如：

```text
[Terminal 1] [Build] [Benchmark] [+]
```

不同 Session：

```text
Terminal 1
$ codex

Build
$ cmake --build build

Benchmark
$ ./llama-bench
```

全部：

```text
cwd = workspace.path
```

---

# 22. New Workspace Flow

点击：

```text
+ New
```

弹出：

```text
New Workspace

Work Thread
[ Improve FP4 ▼ ]

Project
[ llama.cpp ▼ ]

Device
[ dev-cuda ▼ ]

Name
[ nvfp4-kernel ]

Base Branch
[ master ▼ ]

                Cancel   Create
```

如果 Project 未 setup：

```text
llama.cpp isn't available on dev-cuda.

[Import Existing]
```

完成 Setup 后继续创建 Workspace。

Remote Device 只能 Import Existing。Local Device 可以选择 Import Existing 或 Clone Project。

---

# 23. Add Project Flow

左侧：

```text
Projects
+ Add Project
```

MVP 两种方式：

```text
Import Existing Repository
```

或者：

```text
Git Repository URL
```

Import：

```text
Device: MacBook or dev-cuda
/path/to/repo
```

系统读取：

```text
name
origin URL
default branch
```

创建：

```text
Project
+
ProjectCheckout
```

---

# 24. Add Device Flow

MVP：

```text
File → Add Device
```

Device 通过左侧栏的 All devices 管理页面集中展示，但单个 Device 不作为 Workspace filter；它仍参与 Workspace 创建和运行时选择。

Local Device 自动存在。

Remote Device：

```text
Name
dev-cuda

Host
dev-cuda

SSH User
allen

SSH Tunnels (optional)
Local 3000 → Remote 127.0.0.1:3000
Remote 5432 → Local 127.0.0.1:15432
```

底层 transport：

```text
SSH
```

但领域模型不保存 SSH-specific runtime state。

可以独立定义：

```ts
interface DeviceConnection {
  deviceId: string

  transport: "local" | "ssh"

  config: {
    host?: string
    user?: string
    port?: number
    tunnels?: Array<{
      direction: "local-to-remote" | "remote-to-local"
      sourcePort: number
      destinationHost: string
      destinationPort: number
    }>
  }
}
```

每个 Remote Device 可以配置多个 SSH tunnel。`local-to-remote` 在本机 loopback 地址监听，转发到从远程机器可访问的目标；`remote-to-local` 在远程 loopback 地址监听，反向转发到从本机可访问的目标。默认不暴露到局域网或公网。

Tunnel 配置属于持久连接配置，但 SSH tunnel 进程、PID、重试次数和连接状态都属于 runtime state。Desktop Runtime 使用 `ssh -N`、keepalive 与 `ExitOnForwardFailure` 维护每个 Device 的 tunnel 进程；断网或 SSH 退出后按指数退避自动重连，macOS 从睡眠恢复时立即重建连接，应用退出时终止 tunnel 进程。

这样未来：

```text
SSH → Relay
```

不会修改 Device / Workspace 模型。

---

# 25. Runtime API

Control Plane 与 Device Runtime 之间只暴露 primitive operations。

WorkThread 属于 Control Plane metadata，提供 create/archive/restore/delete；归档不向 Device Runtime 发送命令。

## Device

```text
device.ping()
device.info()
```

## Project

```text
project.setup()
project.import()
project.status()
```

## Workspace

```text
workspace.list()
workspace.create()
workspace.delete()
workspace.status()
```

## Session

```text
session.list()
session.create()
session.attach()
session.write()
session.resize()
session.kill()
```

不要提供：

```text
executeTask()
runAgent()
reviewTask()
```

Runtime 不理解这些高层业务概念。

---

# 26. Local Persistence

Control Plane 保存：

```text
projects.json
devices.json
work_threads.json
workspaces.json
checkouts.json
```

或者 MVP 直接 SQLite：

```text
projects
devices
work_threads
project_checkouts
workspaces
sessions
```

推荐 SQLite。

当前 JSON MVP 快照带有 `schemaVersion`。WorkThread 模型启用时不迁移旧快照；缺少版本或版本不匹配的数据会被清空，并由启动流程重新创建 Local Device。

关系：

```text
projects
   │
   └── project_checkouts ─── devices
                │
                └── workspaces ─── work_threads
                        │
                        └── sessions
```

---

# 27. Runtime State vs Persistent State

必须严格区分。

### Persistent

```text
Project
Device
WorkThread
ProjectCheckout
Workspace
Session metadata
```

### Runtime

```text
Device online/offline

Session PID
PTY handle
WebSocket connection
terminal client connection
SSH tunnel process / retry state
```

例如：

```text
Session
id = abc
status = running
```

不能只相信数据库。

Runtime 启动时应该 reconcile：

```text
DB says running
       +
PTY doesn't exist
       ↓
Session = exited
```

---

# 28. MVP Architecture

最终架构：

```text
┌──────────────────────────────────────┐
│              Mac App                 │
│                                      │
│ Project / WorkThread / Workspace UI  │
│                                      │
│            Terminal UI               │
└──────────────────┬───────────────────┘
                   │
             Control API
                   │
          ┌────────┴─────────┐
          │                  │
          ▼                  ▼
    Local Runtime       Remote Runtime
                         (via SSH)
          │                  │
     ┌────┴────┐        ┌────┴────┐
     │         │        │         │
     Git      PTY       Git      PTY
     │         │        │         │
 Workspace  Session  Workspace  Session
```

领域层：

```text
              WorkThread
                   │
                   ▼
               Workspace
                   │
                   ▼
                Session

                 Project
                    │
                    ▼
            ProjectCheckout
              /           \
         Device         Workspace
                            │
                            ▼
                         Session
```

---

# 29. MVP Scope

第一版完成标准只有五件事。

1. WorkThread

能够：

```text
create
list
archive / restore
delete when empty
group workspaces
```

2. Project

能够：

```text
add
import
list
```

3. Device

能够：

```text
local device
add SSH device
online/offline detection
local and reverse SSH port forwarding
automatic tunnel reconnect after network loss or system wake
```

4. Workspace

能够：

```text
create
list
switch
delete

git worktree isolation
```

5. Terminal Session

能够：

```text
create
attach
switch
close

PTY keeps running when UI disconnects
```

最终用户体验：

```text
打开 App

        ↓

创建 WorkThread
Improve FP4

        ↓

选择 llama.cpp

        ↓

选择 dev-cuda

        ↓

New Workspace
nvfp4-kernel

        ↓

自动创建 Git Worktree

        ↓

Terminal

$ codex
```

然后用户可以切换到：

```text
modelopt / fp4-test
```

再切回来：

```text
Improve FP4 / llama.cpp / nvfp4-kernel
```

原来的 Terminal Session 仍然存在。

---

# 30. MVP 最重要的架构约束

整个实现过程中始终保持：

```text
WorkThread
    = Which effort groups these workspaces?

Project
    = What codebase?

Device
    = Where does it run?

Workspace
    = Where does this work happen?

Session
    = What process am I interacting with?
```

不要让它们互相侵入：

```text
Project ≠ local directory

Device ≠ SSH connection

WorkThread ≠ Task / Workflow

Workspace ≠ Task

Session ≠ Workspace

Session ≠ Agent
```

尤其不要在 MVP 中加入：

```text
Task
Execution
Agent
Workflow
Step
Review
```

这些概念。

先验证：

> **WorkThread → Workspace × (Project × Device) → Persistent Terminal**

这条链路本身是否足以成为一个好用的多项目、多机器开发工作台。

如果成立，再在 Workspace 之上增加 Agent / Task 等高层语义，而不改变底层 Runtime Model。
