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

规则：

- Project identity 仍然是 canonical git remote。
- Project name 用于展示和 Workspace 路径目录段，必须在全局范围内忽略大小写唯一。
- 不同 remote 如果检测出相同默认名称，Add Project 不创建 Project，也不执行不必要的 clone；用户需要输入一个安全且唯一的 Project name 后重试。
- Project name 不能是 `.`、`..`，也不能包含路径分隔符。
- All projects 页面用于新增、重命名和删除 Project，并展示其 checkout、workspace 与 device 关联。
- 删除 Project 前必须先删除其全部 Workspace；删除只清理 SuperThread 中的 Project 与 checkout 记录，不删除设备上的仓库目录。

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

Clone 是独立于 New Workspace 的 Project Setup 操作。Local 与 Remote Device 均可选择 base directory，并由所属 Device Runtime 在该目录下执行 `git clone`；远端使用 SSH 连接及该设备自身的 Git 凭据。

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
  pinned: boolean
  document?: string
  documentUpdatedAt?: Date
  createdAt: Date
  updatedAt: Date
  archivedAt?: Date
}
```

规则：

- 名称在 active 与 archived 范围内忽略大小写唯一。
- 一个 Workspace 必须且只能属于一个 WorkThread。
- WorkThread 可以暂时为空，也可以包含多个 Workspace。
- 点击 WorkThread 默认打开 Document 页；即使还没有 Workspace，也可以独立写文档。Document 不在侧栏单独显示，点击 WorkThread 名称即可进入；其下只显示 Workspace 入口，继续打开终端。
- 每个 WorkThread 拥有一份 Markdown 文档，使用 Markdown 编辑插件提供格式工具栏、源码编辑、分栏预览和纯预览。文档不属于任何 Project 或 Device 的仓库文件。
- 文档在输入停止 500ms 后自动保存；切换页面或窗口失去焦点时立即保存，并显示保存中、已保存或保存失败。失败时保留本地恢复草稿并提供重试，不覆盖正在编辑的内容。
- 文档随 WorkThread 本地持久化，归档、恢复和应用重启不清除文档；永久删除 WorkThread 同时删除文档。文档上限为 2,000,000 个字符，IPC 不裁剪 Markdown 空白。
- 关闭窗口前等待未完成的文档保存；保存失败时保留窗口和草稿。
- WorkThread 置顶由用户手动设置，默认为非置顶；侧栏中置顶的排在前面，其余保持创建顺序。在侧栏右键 WorkThread 可选择置顶或取消置顶。
- All work threads 页不显示置顶状态；Active 和 Archived 列表均按文档更新时间从新到旧排序，未编辑过的文档使用 WorkThread 创建时间。归档、恢复或置顶变更不改变文档排序时间。
- 列表显示 Last update，使用用户本地时间、24 小时制及 `MMDD HH:mm` 格式（如 `1008 09:05`）。
- Archive/Restore 按钮旁提供 Doc 按钮，左侧列表平滑收窄的同时，右侧展开非模态 Markdown 编辑抽屉，关闭时反向收回；系统开启减少动态效果时直接切换。列表始终保留可见、可滚动并可切换其他文档。抽屉复用自动保存，关闭或切换文档时保存草稿，支持关闭按钮和 Escape；Archived 文档也可编辑。
- 归档只隐藏整组内容，不停止 Session 或删除 Git Worktree。
- 只有没有 Workspace 的 WorkThread 可以永久删除；删除确认必须说明其文档也将永久删除。

---

# 10. Workspace

Workspace 是整个系统最核心的 runtime abstraction。

定义：

> Workspace 是 Project 在某个 Device 上的一份 Working Copy；可以直接使用 base checkout，也可以使用隔离的 Git worktree。

数据结构：

```ts
interface Workspace {
  id: string

  name: string

  workThreadId: string
  projectId: string
  deviceId: string
  checkoutId: string

  kind: "main" | "worktree"

  path: string

  branch: string
  baseBranch: string

  // 首次从 iTerm 打开时分配并持久化；每个 Workspace 唯一
  tmuxSessionName?: string

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
  "path": "~/.superthread/workspaces/llama.cpp/nvfp4-kernel",
  "branch": "work/nvfp4-kernel",
  "baseBranch": "master",
  "status": "ready"
}
```

规则：

- Workspace 名称在创建时决定 worktree 路径与 `work/{workspace-name}` 分支，且在同一 Device 上唯一。
- 侧栏右键 Workspace 可编辑 Workspace 信息；只有名称可以修改，Project、Device、路径、分支与 Base branch 均只读。
- 重命名只更新展示名称与 `updatedAt`，不重命名目录、不改分支、不改 tmux session 名称，也不影响已存在的 Session 与其工作目录。
- 重命名后的名称仍受与创建相同的约束：去除首尾空格、不能为空、不超过 80 个字符，只允许字母、数字、`.`、`_`、`-`，且不能与同一 Device 上其他 Workspace 重名。

---

# 11. Workspace Creation

Workspace 有两种创建模式：

- `main`：直接使用所选 `Project × Device` 的 base checkout，不创建 worktree 或分支。每个 `Project × Device` 最多只能有一个 main Workspace；若已被其他 WorkThread 使用，创建必须被阻止，并提示现有 Workspace 与所属 WorkThread。
- `worktree`：从 base checkout 的本地 ref 创建隔离的 Git worktree 和 `work/{workspace-name}` 分支。

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
git -C /data/allen/llama.cpp worktree add \
  -b work/nvfp4-kernel \
  ~/.superthread/workspaces/llama.cpp/nvfp4-kernel \
  master
```

Workspace 必须从 Setup/Import 时记录的 base checkout 及其本地已有 ref 创建。创建流程不隐式执行 `fetch`，也不要求 Device 拥有 origin 的网络访问或 SSH 凭据；如果需要最新远端提交，用户应先在 base checkout 中自行同步。`baseBranch` 在该 checkout 中不存在时，创建应直接报告对应的 Git 错误。

新建 `worktree` Workspace 时，可以展开可选的 Link files and folders，勾选 base checkout 中未被 Git 跟踪的文件或目录（包括 ignored 内容与空目录）。完全未跟踪的目录作为整体提供选择，已包含 tracked 文件的目录只列出其未跟踪子项。默认不选；切换 Project、Device 或重新打开创建窗口时清空选择。`main` 模式不提供此选项。

由所属 Device Runtime 在新 worktree 中按相同的相对路径建立 `ln -s` 软链接，指向该 Device 上 base checkout 的原始路径；嵌套条目保留相对目录结构。链接共享原文件内容，修改会作用于 base checkout 中的源文件，不复制内容或自动跟踪文件。创建前重新验证选择，拒绝越界、Git metadata、已被跟踪或消失的源路径；不覆盖新 worktree 中已有的文件、目录或软链接，也不沿目标父目录软链接写入。链接失败时回滚 worktree、branch 与 Workspace metadata，回滚失败时保留 error 记录供处理。删除 worktree 只移除链接，不删除源内容；未被新 worktree 的忽略规则排除的链接按普通未跟踪文件参与删除风险检查。

得到：

```text
Project
llama.cpp

base checkout
/data/allen/llama.cpp

        │
        ├── Workspace A
        │   ~/.superthread/workspaces/llama.cpp/nvfp4-kernel
        │
        └── Workspace B
            ~/.superthread/workspaces/llama.cpp/benchmark
```

本机和远程 Device 都使用所属 Device 用户的 home 目录：

```text
~/.superthread/workspaces/{project-name}/{workspace-name}
```

Runtime 必须在对应 Device 上解析 home 目录，不能把带引号的字面 `~` 当作路径传给远程命令。

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
   ▼ rollback metadata
 not created
```

创建 Git worktree 失败时，不保留一个可见的 Workspace 记录。旧版本遗留且没有 worktree path 的 `error` Workspace 可以直接删除 metadata，不执行 Git 命令。

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

删除 `main` Workspace 只停止其 Session 并删除 Workspace 与 Session metadata；保留 base checkout 目录、文件、Git 分支及 ProjectCheckout 记录。即使选择 Force Delete，也不删除 main 目录。旧记录缺少或错误标记 `kind` 时，如果 Workspace 路径与 base checkout 路径相同，仍按此规则处理。

删除 `worktree` Workspace：

1. 使用 base checkout 中的本地 ref 检查未提交修改、未跟踪文件，以及相对 base branch 尚未合并的提交（不隐式 fetch）
2. 停止所有 Session
3. 删除 Git Worktree
4. 删除对应 Branch
5. 删除 Workspace 和 Session metadata

Runtime：

```bash
git worktree remove <workspace-path>
git branch -D <workspace-branch>
```

如果存在未提交修改、未跟踪文件或未合并提交：

```text
Workspace delete blocked.
```

默认禁止删除。

用户必须明确选择：

```text
Force Delete
```

才允许：

```bash
git worktree remove --force
git branch -D <workspace-branch>
```

只有在 PTY/连接、Git worktree 和 branch 删除成功后，才删除持久化 Workspace 与 Session 记录。失败时必须保留 metadata，避免 UI 状态与实际 Git 状态失配。

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
    | "restore-failed"

  kind:
    | "shell"
    | "codex"

  order: number

  shell: string

  pid?: number
  cwd?: string
  activityStatus?: "idle" | "busy" | "waiting-input"
  exitReason?: "process-exit" | "user-closed" | "runtime-stopped" | "restore-failed"
  exitCode?: number
  restoreError?: string
  codexConversationId?: string
  resultUnread?: boolean

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
  "kind": "shell",
  "order": 0,
  "cwd": "/data/workspaces/nvfp4-kernel",
  "activityStatus": "idle",
  "shell": "/bin/zsh"
}
```

`status` 描述 PTY 生命周期；产品界面中的 `running` 描述终端是否正在执行工作，两者不可混用。只有
`status === "running" && activityStatus === "busy"` 才计为 running。任何内嵌 Terminal（shell 或 Codex）
在前台工作或 command 执行时为 `busy`；工作结束且结果尚未被用户查看时为 `waiting-input`，结果所在 Terminal
在前台窗口中显示后转为 `idle`。普通 shell 只有前台 command 占用 Terminal、需要等待完成或
通过 Ctrl+C 中断时才为 `busy`，停留在交互式 shell prompt 时为 `idle`。直接运行的
Codex 必须基于最近的累计终端输出判断，不能让输入框之后的 footer/status 重绘把等待状态覆盖为 `busy`。
首次启动后仅显示输入框、权限请求或其他需要输入的界面不代表有未读结果，不得单独触发 waiting。

---

# 15. Terminal Runtime

Workspace 的新建 Terminal 菜单提供 `Custom…`，可创建、编辑和删除 Device 下的自定义终端入口。每个入口包含名称和启动目录，名称在同一 Device 下忽略大小写唯一；不同 Device 可使用相同名称。入口作为 Device 配置持久化，不引入新的顶级领域对象。Workspace 菜单只显示其所属 Device 的入口，同一 Device 的多个 Workspace 复用同一组入口。

点击入口会在该 Workspace 中新建普通 shell Session，由 Workspace 所属 Device 在指定目录启动。保存和启动时均验证目录存在并可访问，`~` 按所属 Device 的用户 home 解析；目录不存在、Device 不可用或入口不属于当前 Device 时显示错误，不回退到 Workspace 目录。Session 保存实际启动目录，恢复时继续使用该目录。编辑或删除入口不影响已创建的 Session，也不修改 Workspace 的路径、worktree 或 Git 分支。

创建 Session 可以选择两种 managed Terminal 类型：

- `shell`：普通 Terminal，在 Workspace 当前目录启动 shell。
- `codex`：在 Workspace 当前目录启动 Codex CLI；缺少 Codex CLI 时回退为 `shell` 并提示。
- `tmux` 不创建 SuperThread Session 或内嵌 Terminal。每个 Workspace 只拥有一个 tmux session；首次选择 `tmux in iTerm` 时按 Workspace 名称分配并持久化 session 名称，若 Device 上已有同名 session，则依次追加 `-2`、`-3` 等数字。Runtime 在 Workspace 所属 Device 上确保该 session 存在，然后让 iTerm 通过本地命令或 SSH 直接 attach，不加载可能截断命令的交互式登录 shell。已有 iTerm terminal window 时在当前窗口新建并选中 tab；没有 terminal window 时才新建 window。重复打开必须复用同一个 tmux session，不得创建额外 tmux window 或 SuperThread Session 记录。缺少 tmux 或 iTerm 时直接提示错误，不回退为内嵌 shell。

iTerm attach 必须使用可用性探测得到的 tmux 绝对路径。Local Device 通过非交互式 `/bin/sh -c` 解释 `cd` 与 `exec`，不得依赖 iTerm profile 的 PATH 或把 shell 语法直接作为 profile command；Remote Device 则把相同的绝对路径和 attach 命令交给 SSH 执行。

Codex 与 Workspace tmux 的可用性探测、创建必须使用 Device 用户的交互式登录 shell，使 SSH
设备上的 `.bashrc` / `.zshrc`、Conda、nvm 等 PATH 配置与普通 Terminal 中的行为一致；iTerm attach
是例外，必须直接执行，避免有 TTY 时的 shell 初始化逻辑替换 attach 命令。
新建 Terminal 或 Codex 后，Renderer 必须立即展示并选中仅存在于 UI 状态中的初始化标签页；
成功后用持久化 Session 替换该标签页，失败后保留错误、Retry 和 Close，且 Retry 复用同一标签页。
未创建成功的初始化标签页不得写入持久领域数据。

Terminal 输入必须保留 xterm 的原生 IME composition 处理，以支持中文输入法的全角标点等
非 ASCII 字符。Codex Session 中 `Shift+Enter` 插入换行而不提交 prompt；普通 `Enter`
继续提交，shell Session 的按键行为保持终端默认语义。

普通 shell Session 的周期性活动检查只查询进程组；本地不得启动登录 shell，远端通过 SSH
直接执行 `ps`，不得反复加载交互式登录 shell 的初始化文件，避免触发自动 tmux attach
或重复创建长期存活的 SSH agent。
Codex conversation 查询只在首次检查时解析一次登录 shell 中的 `CODEX_HOME`，后续直接读取
同一路径的 session index；查询不得并发重叠，解析失败后也不得周期性重跑 shell 初始化。

创建普通 Session：

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
rename
reorder
mark viewed
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

重新连接时，Runtime 返回带单调序号的终端历史快照；UI 必须先完成历史解析，再接通输入转发，并只追加快照序号之后的实时输出。历史回放不得把终端能力查询产生的响应再次写入 PTY。

Desktop Runtime 启动时必须核对持久化 Session 与真实 runtime 状态，不能信任旧 PID。上次退出或连接中断时仍标记为 `running` 的 Session 会按 Workspace 批量恢复；恢复时使用各自记录的 `cwd`，`codex` Session 优先用记录的 Codex conversation 恢复。直接运行的 Codex 不承诺从被中断的执行中途继续。旧快照中的内嵌 tmux Session 迁移为 Workspace 的唯一 `tmuxSessionName`，不再恢复内嵌 PTY。

单个 Session 恢复失败时只影响自身：状态变为 `restore-failed`，保留 `restoreError`，UI 提供 Resume 重试和新建同类型 Session 入口。其他 Session 的恢复继续执行。

用户主动关闭 Terminal tab 时，Runtime 关闭当前 PTY 或远程连接，并删除该 Session 的持久化记录。Workspace tmux 不显示为 Terminal tab，其生命周期由远端 tmux 与 iTerm 客户端负责。主动关闭的 Terminal 不会在下次打开 Workspace 时自动恢复。Terminal 名称、顺序、类型、工作目录和恢复标识需要持久化。

Session 进入 `exited` 或 `restore-failed` 状态后，Terminal 页面中央提供 Resume 操作。Resume 保留原 Session 的 id、名称与标签页，在记录的 cwd 或 Workspace 路径中重新启动 PTY，并将 Session 状态更新为 `running`；它不承诺恢复已经退出的 shell 进程内存或历史终端缓冲。

Remote Session 的交互式 SSH 连接必须配置连接超时和 server keepalive。SSH 在 Session 创建、恢复或网络中断时退出，即使退出发生在持久化启动状态之前，也必须把原 Session 记录为 `exited` 并显示 Resume；不得遗留没有真实 PTY 的 `running` 状态。Resume 必须复用原 Session metadata。iTerm 中的远程 tmux 连接使用相同的连接超时与 server keepalive 参数。

退出整个应用时，如果存在 `status === "running" && activityStatus === "busy"` 的 Session，主进程必须展示确认提醒并列出仍在执行的 Session。Codex 等待输入和停留在 shell prompt 的空闲 Session 不触发提醒。macOS 上只关闭窗口不触发该提醒，窗口关闭期间 PTY 继续存活并可重新附着。

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
│   llama.cpp   │                                           │
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
All projects
All work threads
All devices

────────

Work Threads

▾ Improve FP4
  nvfp4-kernel
  llama.cpp
  quant-test
  modelopt
▸ Benchmarks
```

Project 和单个 WorkThread 都是 Workspace filter。侧栏中的 WorkThread 提供右键菜单，用于调整优先级或归档；展开后的 Workspace 提供右键菜单，用于编辑 Workspace 信息，其中只有名称可以修改。All projects 打开 Project 管理页面，可新增、重命名和删除未被 Workspace 使用的 Project。All work threads 打开 active/archived 管理页面；All devices 打开 Device 管理页面，可查看连接状态和资源占用、添加或编辑 Remote Device、检测连接，并删除未被 checkout 使用的 Remote Device。Local Device 由应用管理，不能编辑或删除。归档 WorkThread 及其 Workspace 不出现在其他 active scope。

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
│   llama.cpp
└── quant-test
    modelopt
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

每个 Workspace 分别记住最后访问的 Session。切换到其他 Workspace 再返回时，恢复该 Workspace 上次选中的 Session；只有记录的 Session 已不存在时才回退到第一个可用 Session。

左侧栏和 All work threads 页面按 WorkThread 优先级排序。左侧栏的 WorkThread 行在悬停、键盘聚焦或右键点击时提供优先级快捷菜单；修改后立即持久化和重新排序，但不得改变当前 scope、展开状态或 Workspace 选择。创建 WorkThread 时可以选择优先级，默认为 Normal。

左侧栏可以整栏隐藏。隐藏时主界面只保留左上角展开按钮，按钮必须避开 macOS 交通灯。侧栏展开/隐藏状态、原宽度以及每个 WorkThread 的展开状态是本地 workbench 偏好，重开应用后保持。

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
~/.superthread/workspaces/llama.cpp/nvfp4-kernel
```

右上角并列提供 `Open in VS Code` 与 `tmux in iTerm`。前者对本地 Workspace 使用 VS Code 的本地文件 URI，对 Remote Device 上的 Workspace 使用 VS Code Remote-SSH URI，并使用该 Device 已保存的 SSH user、host 和非默认 port；后者在 iTerm 当前窗口打开 Workspace 的唯一 tmux session。Workspace 尚未 ready 时禁用这两个操作。

Header 在有状态需要注意时显示紧凑 Session 汇总：正在执行、Codex 等待输入、Codex 已完成但未读、恢复失败。切换到带未读 Codex 结果的 Terminal 后清除未读标记。

---

# 21. Terminal Area

Workspace 默认创建一个 Session：

```text
Terminal 1
```

允许：

```text
+ New Terminal
+ New Codex
Double-click Terminal name to rename
Drag Terminal tabs to reorder
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
cwd = session.cwd || workspace.path
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

New Workspace 只提示需要先 Setup，并提供前往独立 Project Setup 操作的入口；不在该弹窗内执行 clone 或 import。完成 Setup 后，用户重新创建 Workspace。

独立 Project Setup 支持在 Local 或 Remote Device 上选择 base directory 后 Clone Project，也支持 Import Existing。

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

如果检测到不同 remote 的默认 name 与现有 Project name 大小写等价，表单保留当前输入并显示 Unique Project Name 字段。用户输入唯一名称后可以重试；没有名称冲突时保持原流程。

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
workspace.rename()
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
session.rename()
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

当前 JSON MVP 快照带有 `schemaVersion`。旧快照通过迁移保留数据；缺少文档的 WorkThread 使用空文档。文档自动保存与终端 runtime 更新串行写入同一份原子快照，避免并发覆盖。

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
rename
switch
delete
open in VS Code (local and Remote-SSH)

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
