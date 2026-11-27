# Workspace Runtime MVP Spec

界面外观跟随系统浅色/深色模式，参考 Codex 使用中性灰层次、柔和边界与圆角选中态。正文为 14px，侧栏导航为 13px，文档为 16px / 1.75 行高，阅读区域最大宽度 840px；工作区工具栏保持紧凑尺寸。侧栏上方 All xxx 导航固定，下方 Work Threads 与 Workspaces 共用独立滚动区域，Settings 固定在底部。完整颜色与尺寸规范见 `docs/mac-native-ui-framework.md` 第 15 节。

侧栏选中态只高亮当前打开的条目：打开 Workspace 时，仅工作区行使用圆角选中背景，父级 WorkThread 保持透明底色并加强名称与图标；打开线程文档时，才高亮线程行。当前条目提供 `aria-current="page"`，保留常规字重、键盘焦点环及独立的悬停反馈。

首次读取应用快照失败且重试耗尽时，启动动画退出，显示可复制的错误说明与 Reload 操作；恢复后重新加载可进入正常工作台。错误页面仍保留窗口拖动区与 no-drag 控件。

All work threads 中点击整条记录打开文档，列表不显示 Terminal 或重复的 Doc 按钮；Restore 与 More 保持独立操作。Finish / Archive / Delete 位于 More 菜单，Archived 列表保留 Restore。文档抽屉作为内容区右侧覆盖层打开，宽度为 Work Threads 内容区的 2/3，不挤压或隐藏底层列表；所有窗口宽度均采用相同布局。底层 Work Threads 标题与列表保持尺寸、位置和滚动，打开期间设为 inert / aria-hidden，并由页面内遮罩拦截点击；点击露出的底层页面、关闭按钮或 Escape 均收起抽屉，底层操作不会同时触发；遮罩悬停显示普通箭头，按下时保持原遮罩背景，不继承普通按钮的按下填充或闪白。resize 不重建编辑器。文档抽屉在固定布局宽度下用 220ms 位移动画从右侧滑入、关闭时向右滑出；退出期间保持挂载并设为 inert / aria-hidden，动画完成后清理详情、恢复列表滚动和焦点。关闭立即触发既有自动保存，不等待动画完成；快速关闭/重开沿同一动画进度反向播放，resize 不重播入场。减少动态效果时直接切换。

All work threads 的 Last update 使用本机时区，按 `yyyy-MM-dd HH:mm` 显示文档更新时间（未编辑时使用创建时间）。归档记录额外显示 `Duration Nd`，从原始 `createdAt` 到当前 `archivedAt`，每 24 小时计一天并向下取整，不足一天显示 `<1d`；悬停可查看起止时间。缺失、无效或早于创建时间的归档时间不显示时长。恢复后继续使用现有 active 年龄提醒，再次归档以新的归档时间计算。

Doc 使用40px单行标题栏与32px Document/Todos 切换栏，保存反馈与关闭/返回始终可见。普通年龄并入切换栏；提醒及强提醒仍在标题下显示完整文字和语义色。格式通过 Document 的提示说明，正文仍为16px且保持原自动保存与错误重试行为。

Workspace 概览以名称、项目/设备、线程/分支分层展示，长字段有完整提示。本地计数标为 local active（仅busy活动），远程计数标为 remote connected；不改既有监测与排序。两者均为零时显示 No terminal activity，不将空闲但仍存活的终端误称为不存在。

## 1. Goal

构建一个面向本地及远程开发环境的 Workspace Manager。

MVP 只解决一个问题：

> 用户可以用 WorkThread 组织相关工作，在不同 Device 上管理 Project，创建独立 Workspace 或用 WorkThread 组织 Workspace，并在 Workspace 中创建和恢复持久 Terminal Session 与 Browser 标签。

核心模型：

```text
WorkThread
   │ optionally groups 1:N
   ▼
Workspace ─── Project × Device
   │
   │ contains
   ▼
Terminal Session / BrowserTab / FilePreviewTab
```

其中：

- WorkThread：组织一组相关 Workspace 的顶级对象
- Project：项目记录，可对应普通目录或 Git 仓库
- Device：实际执行工作的机器
- Workspace：Project 在某个 Device 上的工作目录，可直接使用项目目录或创建 Git worktree
- Session：Workspace 中一个持久 Terminal / PTY
- BrowserTab：Workspace 持有的本机网页视图及其最后访问地址
- FilePreviewTab：Workspace 持有的只读文件预览标签，通过所属 Device 读取文件

MVP 不包含：

- Agent Task / 自动执行任务
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

## 2.1 Project supports directories with optional Git

Project 用于组织项目内容，不要求目录中存在 Git 或 origin remote。

新增项目时，由所选 Device 解析并验证实际目录，按 `(deviceId, resolvedPath)` 判重。路径去除 `.`、`..`、尾随分隔符并解析软链接；同一目录的别名不能重复添加。不同 Device 可以使用相同路径；不同目录可以使用相同 Project name 或 Git remote，但必须填写不同的 Project code，不按 remote 自动合并。

用户仍可通过 Set Up Project 显式把已有 Project 关联到其他 Device 的目录；已有 Project、checkout 与 Workspace 关联保留。

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
├── Terminal Sessions
└── Browser Tabs
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

核心对象包括 Workspace 所持有的 BrowserTab：

```text
WorkThread
Project
Device
Workspace
Session
BrowserTab
FilePreviewTab
```

关系：

```text
                 WorkThread
                      │ optional 1:N
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

Project 是项目记录，Git remote 与默认分支是可选元数据，不作为唯一标识。

数据结构：

```ts
interface Project {
  id: string

  code: string
  name: string

  // Optional Git metadata
  repositoryUrl?: string
  defaultBranch?: string

  createdAt: Date
  updatedAt: Date
}
```

例如：

```json
{
  "id": "proj_llamacpp",
  "code": "llama.cpp",
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

- Add Project 校验 code 全局唯一及同一 Device 上解析后的实际目录唯一；相同 remote、相同名称但不同路径可以使用不同 code 分别添加。
- Project code 必填且全局唯一，去除首尾空白后保存，按 Unicode NFC 与大小写不敏感判重；最长 80 字符，不允许 `.`、`..`、路径分隔符或控制字符。Add Project 与 Edit Project 均提供 code 输入及校验，持久化事务内再次检查唯一性，防止并发冲突。
- Project name 用于展示，可以重名；同名项目在选择列表中展示 Device 与路径以便区分。新 worktree 路径使用 `~/.superthread/workspaces/<project code>/<workspace name>`。
- schema 16 为已有项目补齐 code：优先使用 Git remote URL 最后的仓库名，去掉 `.git`；无 remote 时使用 Project name。非法路径字符替换为 `-`，无有效名称时使用 `project`，重名追加 `-2`、`-3` 等数字后缀，并保留已有有效 code。
- 修改 code 仅影响以后创建的 worktree。历史 Workspace 的记录、路径、分支与设备目录均不处理、不迁移。
- Project name 不能是 `.`、`..`，也不能包含路径分隔符。
- All projects 页面用于新增、编辑名称与 code、删除 Project，并展示其 checkout、workspace 与 device 关联。
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

> 一个 Project 在某个 Device 上的物理目录，可以是普通文件夹或 Git checkout。

数据结构：

```ts
interface ProjectCheckout {
  id: string

  projectId: string
  deviceId: string

  path: string
  isGit?: boolean
  defaultBranch?: string

  createdAt: Date
}
```

`isGit` 在新记录中明确标识目录是否为 Git 根目录；旧记录缺少该字段时按原有 Git checkout 处理。普通目录不保存虚构的 remote 或 branch。

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
(deviceId, resolvedPath)
```

同一 Device 的同一路径不能归属多个 Project。Set Up Project 仍为一个 Project 在每个 Device 关联一个 base 目录；若要在同一 Device 添加其他目录，使用 Add Project 创建独立记录。

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

Clone 是独立于 New Workspace 的 Project Setup 操作。Local 与 Remote Device 均可选择 base directory，并由所属 Device Runtime 在该目录下执行 `git clone`；新建项目的 Clone URL 同样支持选择 Local 或 Remote Device，并在所选设备浏览或输入父目录；切换设备清空目录选择。父目录由目标设备解析（包括 `~` 和软链接），clone 成功并读取仓库信息后才记录 Project 与该设备的 ProjectCheckout；失败保留表单以便修正重试。远端 clone 与 fetch 共用 SSH 命令执行器，沿用本机 `~/.ssh/config`（包括 `ForwardAgent`）及 SSH Agent 环境；已配置 Agent 转发时可使用本机 Agent 中的密钥访问 Git 远端，无需把私钥复制到设备。

### Import Existing Directory

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

Runtime 首先验证目录存在且可访问，并通过所属 Device 上的 `pwd -P` 解析实际路径（包括 `~` 和软链接）。Git 为可选能力：仅在所选目录本身为 Git 根目录时检测 origin 与默认分支；没有 origin 的仓库也可导入，没有 Git 命令或不是 Git 仓库的目录按普通目录导入。选择 Git 仓库的子目录时保留所选目录，不自动替换为仓库根目录。

在串行持久化事务内检查 Device 与实际目录的唯一性后创建 ProjectCheckout；重复提交与并发导入不能生成重复记录。显式 Set Up Project 的 Import 同样只要求有效且未被占用的目录，不要求匹配 remote。没有 Git remote 的 Project 只能 Import，不能 Clone。

---

# 9. WorkThread

WorkThread 是组织 Workspace 的顶级对象，不是 Task、Workflow 或执行状态。

### Work / Life 类型

- WorkThread 固定支持 `work` / `life`，UI 显示 Work / Life。可选 `type` 缺失、null 或空字符串时按 Work 读取；不补写旧记录、不提升快照 schema、不执行迁移。新建输入省略类型仍兼容 Work；显式输入仅接受这两个固定值。
- 侧栏最上方原应用图标位置提供 Work / Life 文字下拉，移除应用图标及 Work Threads 标题下的分段按钮。触发器显示当前类型与小箭头，圆角浮层以勾选标明当前项；支持 Enter / Space 打开和选择、方向键及 Home / End 导航、Escape 关闭并恢复焦点、Tab 离开与点击外部关闭，保留交通灯安全区和 no-drag 控件。默认 Work，本机记住上次选择；切换只显示该类型的活跃线程，置顶、拖动与 Option+↑/↓ 均在当前类型内操作。All work threads 与 All todos 的内容及侧栏计数同步按类型筛选；项目、设备、All workspaces 与独立 Workspace 不受此筛选影响。
- 切换类型进入该类型的 All work threads，关闭线程详情/抽屉并触发现有文档保存；在 All todos 内切换则留在 TODO 汇总。切换不终止 PTY、不清除创建草稿或线程展开状态。列表搜索/项目/时间/状态筛选在切换类型时恢复默认值，避免新类型被旧筛选隐藏。打开全局 workspace 总览中的线程 Workspace 时，侧栏自动显示其所属类型。
- 新建向导第一步提供 Type，默认取当前侧栏类型；关闭并重开保留草稿的原类型，确认页展示类型。创建开始后锁定类型，失败重试保持已创建线程的类型；完成并打开线程时显示相应类型。
- 侧栏线程右键菜单和 All work threads 的 More 提供 Move to Life / Work，支持活跃与归档线程。独立 typed bridge `setWorkThreadType({ id, type })` 经主进程校验并串行保存，仅修改类型与 `updatedAt`，保留文档、TODO、置顶、排序、Workspace 和 Session；创建中或 Finish 中禁止修改。当前打开的线程被移动时仍保持打开，侧栏跟随显示新类型；列表中的条目移出当前筛选范围。名称继续跨类型全局唯一。

### 定义模板与时长提醒

- New work thread 使用三步向导：填写名称与 Markdown → 配置至少一个 Workspace（可多个）→ 确认并创建。内容预填可编辑模板，默认包含「目标、范围、完成标准」及引导文字，允许修改或清空。模板仅初始化新草稿，不覆盖已有草稿。
- 向导仅选择已存在 checkout 的 Project × Device；缺少时提示先到项目管理准备。每项复用独立 Workspace 的类型、名称、基础分支、可选链接表单。提交前检查线程重名、已有及批内 Workspace 名称冲突、checkout 可用性和同线程内的 main 重复；跨线程共用主目录时在配置及确认页显示非阻断提醒。
- 主进程按稳定操作 ID 与配置项 ID 管理单个运行时创建流程：先原子保存名称与正文并返回真实 thread ID，再依次创建 Workspace。所有 Workspace 及默认 Terminal 初始化成功才提示整体完成；弹窗可见时打开 Doc 并展开线程，弹窗已关闭时仅通知，不切换页面。
- 某项失败暂停后续创建，保留成功项，允许修改失败及未执行项再继续；成功项锁定，重试不重复创建线程、Workspace 或终端，也不覆盖已保存的 Doc。单项失败沿用 Workspace 回滚；若回滚残留记录，显示记录与错误，删除残留前禁止重试。
- 关闭、Escape 或点击遮罩保留草稿和进度；创建中关闭弹窗不取消主进程操作，再次点击 New Work Thread 恢复。运行时只保留一个未结束向导，运行中禁止放弃及删除/归档对应线程，相关 Workspace 也不能删除。未提交可 Discard draft；暂停时可 Discard remaining，保留已创建实体。完全退出应用后仅保留已创建实体，不持久化向导配置或自动继续。
- Settings 可从侧栏底部、应用菜单及 `Cmd+,` 打开，编辑模板与两个提醒阈值，提供保存、取消、恢复默认。恢复默认仅修改设置草稿，保存后生效；空模板有效。模板更新仅影响之后打开的创建弹窗，不覆盖已有 Doc 或正在填写的创建内容。
- 应用设置保存在 `AppSnapshot.settings`：`workThreadTemplate`、`workThreadReminderDays`、`workThreadStrongReminderDays`，模板上限与 Doc 同为 2,000,000 字符且不裁剪空白；两个阈值须为正安全整数，且加强阈值大于首次阈值。默认 3 天／7 天。快照 schema 15 为旧快照补充默认设置，不修改既有 WorkThread、文档、TODO 或运行数据。
- 时长从最初 `createdAt` 起按连续 24 小时累计，不因编辑、重命名、置顶、归档或恢复而重置。仅 active 条目展示时长与提醒；恢复后包括归档期间的时间。未来创建时间按零计算，无效时间不显示提醒。每分钟及窗口重新聚焦时刷新，修改阈值立即更新展示。
- 侧栏显示 `<1d`、`3d` 等紧凑时长，列表显示完整时长，悬停可查看创建时间与建议；Doc 页面和列表 Doc 抽屉同时显示时长与达到阈值后的非阻断建议：检查完成标准，及时 review、合并及收尾，或拆分剩余工作。使用语义色与文字／图标共同区分中性、首次提醒和加强提醒。排序仍遵循原有规则。
- 不增加通知弹窗、自动归档、自动拆分、review 状态或自动 Git 操作。描述直接使用已有文档的搜索能力，不另设独立描述字段。
- Typed bridge 增加 `saveSettings(AppSettings): Promise<void>` 与 `settings` 菜单动作；`createWorkThread` 输入支持可选 `content`，省略时保持空文档兼容行为，返回真实 thread ID。新增 `submitWorkThreadCreation`、`workThreadCreation`、`discardWorkThreadCreation` 与进度订阅；配置项禁止传入归属线程 ID。IPC 输入在主进程校验，设置及创建使用现有串行原子保存机制。

```ts
interface WorkThread {
  id: string
  name: string
  type?: "work" | "life" | "" | null // missing/empty values read as Work
  status: "active" | "archived"
  pinned: boolean
  sidebarOrder?: number
  document?: string
  documentUpdatedAt?: Date
  todos?: Todo[]
  projectIds?: string[] // successfully deleted Workspaces' projects, retained for filtering
  completion?: { outcome: "completed" | "cancelled"; note: string; finishedAt: Date } // last successful Finish
  createdAt: Date
  updatedAt: Date
  archivedAt?: Date
}
```

规则：

- 名称在 active 与 archived 范围内忽略大小写唯一。
- 侧栏右键 WorkThread 可重命名；名称去除首尾空格后须为 1–80 个字符，且不得与 active 或 archived 的其他 WorkThread 重名。重命名只更新名称和 `updatedAt`，保留文档、Workspace 和 Session。
- 一个 Workspace 可以独立存在，也可以在创建时归属于一个活跃 WorkThread。旧快照保留原有关联。
- 历史或创建中/失败后保留的 WorkThread 可以暂时为空，也可以包含多个 Workspace；新建向导要求至少配置一个 Workspace。
- 点击 WorkThread 默认打开 Document 页；即使还没有 Workspace，也可以独立写文档。Document 不在侧栏单独显示，点击 WorkThread 名称即可进入；其下只显示 Workspace 入口，继续打开终端。
- 每个 WorkThread 拥有一份 Markdown 文档，使用飞书式单栏所见即所得编辑器，输入 Markdown 标记时原地转换成标题、列表、引用、加粗等格式，无需切换编辑和预览；支持选中文字后的格式工具栏、斜杠块菜单、表格和撤销/重做。底层仍以 Markdown 自动保存。文档不属于任何 Project 或 Device 的仓库文件。
- Doc 正文及链接预览浮层中的 HTTP(S) 链接单击后在应用内新建 Browser 标签，无需 Cmd/Ctrl。仅选择当前活跃 WorkThread 下 ready 的 Workspace：一个时直接打开并切换，多个时弹窗选择 Workspace（显示项目和设备），取消不创建标签；没有可用 Workspace 时提示先创建或修复，归档线程提示先恢复。打开失败保留文档和选择并显示错误，离开文档沿用自动保存。邮件链接仍调用系统邮件应用，页内锚点保持原行为，其他协议继续阻止；链接浮层的编辑、复制和删除操作保留。不自动识别裸文本网址，不复用已有同地址标签。
- 文档在输入停止 500ms 后自动保存；切换页面或窗口失去焦点时立即保存，并显示保存中、已保存或保存失败。失败时保留本地恢复草稿并提供重试，不覆盖正在编辑的内容。
- 文档随 WorkThread 本地持久化，归档、恢复和应用重启不清除文档；永久删除 WorkThread 同时删除文档。文档上限为 2,000,000 个字符，IPC 不裁剪 Markdown 空白。
- 每个 WorkThread 可管理每日 TODO，Document 与 Todos 在同一页面通过标签切换；All work threads 的文档抽屉也复用该界面。TODO 是本地清单，不包含执行、Agent 或 Workflow 状态。
- 所属活跃 WorkThread 的 ready Workspace 在主界面右侧提供 Doc 抽屉，复用同一份 Document / Todos 与自动保存。默认展开，宽度为 Workspace 内容区的 1/3，与 Terminal 区域（包含标签栏）同顶同底并排显示；Workspace Header 不在抽屉高度内。标签栏右侧按钮可主动展开或收起，Doc 关闭按钮也可收起；收起时立即保存，Terminal 占满内容区，PTY 和标签选择保持。独立 Workspace 不显示 Doc。Focus 模式保留相同入口。
- Doc 左边界可拖动调宽，也可聚焦分隔条后用左右方向键调整；双击或 Enter 恢复 1/3，Home / End 调到最小 / 最大比例。宽度偏好限定 20%–65%，窄窗口额外保证 Doc 至少 260px、Terminal 至少 240px；因此默认比例在窄窗口可被最小尺寸约束。宽度及收起状态作为本地 workbench 偏好跨 Workspace 与重启保留。缩放不重建文档编辑器或终端，Browser / File Preview 原生视图随内容边界同步，拖动期间暂时隐藏。
- TODO 保存 id、1–500 字符标题、`YYYY-MM-DD` 日期、创建/更新时间以及可选完成时间；新建日期默认为用户本地的今天，支持编辑标题/日期、完成、重新打开和删除。所有修改经校验 IPC 在主进程串行持久化，与 Markdown 保存互不覆盖，TODO 修改不改变文档更新时间。
- WorkThread 的 Todos 显示全部未完成项及完成时间距当前不超过 7 × 24 小时的已完成项，按日期分组并区分 Incomplete / Completed；到期记录只从此视图隐藏，不删除。页面定时以及窗口重新聚焦时刷新时间筛选。
- 左侧 All todos 汇总所有 active 和 archived WorkThread 的全部 TODO，区分未完成与已完成、按日期分组并显示所属 WorkThread，可新增、编辑、完成、重新打开和删除；侧栏数字表示未完成总数。历史完成记录无时间限制。
- TODO 随 WorkThread 归档、恢复及应用重启保留；永久删除 WorkThread 同时删除全部 TODO，确认文案须说明文档和 TODO 都将删除。旧快照升级至 schema 12 时为 WorkThread 补充空 TODO 列表，不改变既有文档与运行数据。
- 关闭窗口前等待未完成的文档保存；保存失败时保留窗口和草稿。
- WorkThread 置顶由用户手动设置，默认为非置顶；侧栏中置顶的排在前面；置顶与非置顶条目分别支持拖动调整组内顺序，拖动时显示插入位置，顺序本地持久化并在应用重启后恢复。尚未手动排序时保持创建顺序，新建条目追加到非置顶组末尾。聚焦条目后也可用 Option+↑/↓ 调整组内顺序。排序不改变置顶状态、文档更新时间或 All work threads 页的排序。在侧栏右键 WorkThread 可选择置顶或取消置顶。
- 侧栏缩到最小宽度时，菜单、WorkThread、Workspace 与 Project 名称在右侧 padding 内显示省略号，不能撑宽列表或贴到分隔边线；悬停名称可查看完整文字。
- All work threads 页不显示置顶状态；提供 All / Active / Archived，默认 Active，均按文档更新时间从新到旧排序，未编辑过的文档使用 WorkThread 创建时间。All 将两种状态合并排序，且仅在 All 的每行显示 Active / Archived 标识。列表不提供 Terminal 或 Doc 按钮，点击记录打开 Doc；Restore 及 More 中的操作根据每个线程的真实状态提供。归档、恢复或置顶变更不改变文档排序时间。
- All work threads 页提供项目与时间筛选，搜索框缩窄，All / Active / Archived 使用固定 246px 总宽及固定分段宽度，数量采用等宽数字并预留 2 位数空间；更长数量省略展示，悬停及可访问名称保留完整值。筛选结果数量变化不改变状态控件或后续控件的位置。普通宽度下全部控件在同一行；窄列表可换行，但项目下拉与时间控件保持同一行。去掉 Project / Last update 的可见标签，保留 aria-label 和悬停说明；项目下拉固定 200px 宽度；清空筛选图标始终预留固定位置，无有效筛选时仅隐藏并禁用，不移出布局，避免日期筛选开关造成位移。默认 All projects，时间数字为 0、单位为周。Project 按线程任一 Workspace 的 projectId 匹配，包含归档线程及跨项目/设备的 Workspace，同一线程只出现一次；项目选项显示名称与 code，名称相同时可区分。成功删除 Workspace（包括 Finish）在同一持久化事务中将其项目 ID 去重保留到 WorkThread 的可选 projectIds；创建失败的回滚不新增历史关联。删除 Project 时清理对应历史 ID。原快照无需迁移，保留的可选字段可直接读写；旧版本已删除 Workspace 且没有关联记录的线程无法反推项目。
- 时间使用 0–12 的数字下拉框，后接可点击选中的「周｜月」，单位按钮通过 aria-pressed 表达选择，选中项使用高对比实心背景和反色文字，不显示勾选图标。数字为 0 时选中项改用灰色实心背景和反色文字，保持灰显且仍可区分单位。0 代表不进行时间筛选，整组时间控件呈灰色但仍可操作；切换周/月时保留数字，数字为 0 时切换单位不启用筛选。1–12 代表最近相应周或月，按文档更新时间（未编辑时为创建时间）筛选，不使用归档、重命名、TODO 或运行状态的时间。周为连续 7 × 24 小时，月按本地日历回退并将月底夹到目标月最后一天，边界包含。每分钟及窗口重新聚焦时刷新。项目、时间与关键词按交集组合，三个状态的数量均反映当前组合；切换状态及打开/关闭文档保留全部筛选，筛选变化不关闭文档，无结果时提供清空筛选，页面离开后不持久化这些筛选。
- All work threads 页提供名称与已保存 Document 可见文字的本地搜索，All / Active / Archived 共用关键词并分别显示匹配数量，切换标签保留关键词；任一字段命中即展示，保留原文档更新时间排序。搜索不区分大小写，首尾空白去除、连续空白归一化，按连续文本匹配，标点按字面处理；不包含 TODO、Workspace 文件、终端和未保存草稿。输入防抖 150ms，中文组合输入完成后再搜索，空关键词恢复当前项目/时间范围内的列表，搜索词仅在当前页面保留。
- 搜索结果高亮名称命中，文档命中时展示首个命中附近至多约 180 字符的纯文本片段并高亮，覆盖 Markdown 标题、列表、表格、代码与链接文字；不执行文档 HTML。无匹配结果时显示独立空态及清空操作。点击继续打开现有 Doc 抽屉，不在编辑器内定位或高亮；改变搜索不关闭已打开的文档，关闭抽屉时若原触发结果已被过滤则将焦点返回搜索框。自动保存成功后搜索结果随快照更新，文档提取结果按内容缓存。
- 列表显示 Last update，使用用户本地时间、24 小时制及 `MMDD HH:mm` 格式（如 `1008 09:05`）。
- 点击列表记录（包括卡片留白）打开页面内覆盖式 Markdown 编辑抽屉，键盘可聚焦记录并通过 Enter / Space 打开；Restore / More 不触发文档打开。列表不再提供 Terminal 跳转或重复的 Doc 按钮。抽屉使用固定布局宽度，从右侧滑入、关闭时滑出，不在动画期间反复缩放编辑器；快速关闭/重开反转当前动画。所有窗口中抽屉均覆盖在当前列表上方，宽度为 Work Threads 内容区的 2/3；底层列表不缩窄、不换行重排，遮罩点击只关闭抽屉，不执行被遮挡的列表或标题栏动作；悬停显示普通箭头，按下时不变色或闪白。收起后保留筛选与滚动。抽屉复用自动保存，关闭立即保存草稿，支持关闭按钮和 Escape；退出动画结束后卸载编辑器并恢复焦点。系统开启减少动态效果时直接切换；Archived 文档也可编辑。
- Finish 是独立的收尾操作，可从侧栏 WorkThread 菜单、All work threads 的 More 和 active Doc 标题栏进入。先展示全部 Workspace 的项目/设备、路径、目录保留或 worktree/branch 删除后果、运行终端数量及与单独删除相同的 Git 风险检查；风险项逐个勾选确认强制删除，检查失败不能强制绕过。返回或关闭弹窗不删除任何数据。
- Finish 弹窗可选择完成情况 Completed（完成，默认）或 Cancelled（取消），并填写可选的多行说明（最多 5,000 字符，保留空白）。两种结果均执行相同的 Workspace 清理与归档；Go back 仅关闭弹窗，不执行 Finish。刷新检查及失败重试保留当前完成情况与说明，重新打开弹窗默认完成、空说明。
- 主进程接收 `finishWorkThread({ id, workspaceIds, forceWorkspaceIds, outcome?, note? })`，校验确认列表与当前归属完全一致、force ID 不越界；先复查整组，删除时逐项再次检查。未提交改动、未跟踪文件、未合并提交均沿用 `deleteWorkspace` 的检查；main/普通目录及历史 base alias 仅删除 metadata 与终端/浏览器/预览记录，保留项目目录。`inspectWorkThreadFinish(id)` 返回确认所需的逐项检查结果，不改变数据。
- Finish 仅适用于 active 线程，创建中不能执行；执行期间禁止同线程重复 Finish、Archive、Delete，以及创建/单独删除其 Workspace 或新建终端。全部 Workspace 删除后才归档；文档、TODO 与项目/checkouts 保留，不增加 finished 状态。空线程可以直接 Finish。
- 全部清理成功后，将 `completion: { outcome, note, finishedAt }` 与归档状态在同一事务中持久化；省略 outcome / note 的旧调用默认 completed / 空字符串，非法结果或超长说明在 IPC 入口拒绝。旧记录不推断完成情况，普通 Archive 不新增完成记录，不需要快照迁移。Doc 顶部可展开查看最后一次 Finish 的结果、时间与原文说明；恢复为 active 后标为 Last finish，下次成功 Finish 覆盖。说明独立于文档和 TODO，不影响文档搜索及更新时间。
- 删除中途失败立即停止，显示已删除数量和失败原因，线程不归档，也不更新完成记录；已删除 Workspace 不回滚，重新检查后仅处理剩余项。确认后新增/减少 Workspace 必须刷新重审；新出现的 Git 风险仍会阻止未经 force 确认的删除。Restore 仅恢复线程，不能恢复已删除的 worktree。
- 归档只隐藏整组内容，不停止 Session 或删除 Git Worktree。
- 只有没有 Workspace 的 WorkThread 可以永久删除；删除确认必须说明其文档和全部 TODO 也将永久删除。

---

# 10. Workspace

Workspace 是整个系统最核心的 runtime abstraction。

定义：

> Workspace 是 Project 在某个 Device 上的工作目录；普通文件夹直接使用项目目录，Git 仓库也可以使用隔离的 Git worktree。

数据结构：

```ts
interface Workspace {
  id: string

  name: string

  workThreadId?: string
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

- All workspaces 打开独立总览，不自动进入 Workspace；点击列表项后进入对应 Workspace。总览和对应 Project 视图显示独立 Workspace 与活跃 WorkThread 的 Workspace，隐藏归档 WorkThread 的 Workspace。页面与每行分别展示本机正在执行工作的 Terminal 数量（`status=running && activityStatus=busy`）以及已连接的远程 Terminal 数量（`status=running && activityStatus=unknown`）。远程不做忙闲探测，连接数不代表正在执行工作。按两者合计降序排列，同数量保持原顺序，并随运行状态更新。
- Workspace 名称在创建时决定 worktree 路径与 `work/{workspace-name}` 分支，且在同一 Device 上唯一。
- 侧栏右键和 Workspace 操作菜单可编辑 Workspace 信息；只有名称可以修改，归属、Project、Device、路径、分支与 Base branch 均只读。
- 重命名只更新展示名称与 `updatedAt`，不重命名目录、不改分支、不改 tmux session 名称，也不影响已存在的 Session 与其工作目录。
- 重命名后的名称仍受与创建相同的约束：去除首尾空格、不能为空、不超过 80 个字符，只允许字母、数字、`.`、`_`、`-`，且不能与同一 Device 上其他 Workspace 重名。

---

# 11. Workspace Creation

Workspace 操作菜单提供 **Push & create MR…**（GitHub 为 PR）。每次打开菜单检查真实 Git 分支并从 Mac 查询 origin 推送仓库的全部 MR/PR；任意状态（打开、关闭、已合并）已有请求时隐藏创建选项，分页并核对源仓库，避免其他 fork 的同名分支误挡。未连接平台时显示 Connect code hosting；查询错误时显示 Review MR setup，进入同一面板恢复，不假定不存在请求。普通目录、无 origin、detached HEAD、当前分支等于基础分支或多个 origin push URL 不提供创建入口。

首次使用在统一面板配置 GitHub.com、GitLab.com 或自托管 GitLab。Mac 管理 API Token，设备仅负责 Git 操作，均无需 gh/glab。表单提供平台类型、HTTP/HTTPS 地址、Token 权限说明、系统浏览器创建 Token 链接、可显示/隐藏的密码式输入框；验证账号与当前仓库读取权限后保存并进入确认页，不自动推送。GitHub 引导 Fine-grained Token，指定仓库及 Pull requests 写入、Contents 读取；GitLab 引导 api scope。只读验证不保证创建权限，403/组织审批/SSO 等错误在创建时明确展示。GitLab 支持自定义端口及部署路径前缀；SSH 别名映射按设备与 Git 远端主机保存，可显式选择已有连接。每个平台地址保留一个账号，供本机各 Workspace 复用。

Settings 的 Code hosting connections 支持查看账号与平台地址、重新验证、替换 Token 和移除连接；移除删除本机 Token 及映射，不撤销平台 Token。Token 在主进程使用当前 Electron 的 safeStorage 加密，独立原子保存到应用数据目录 git-hosting.json，文件权限 0600；密文绑定平台类型和地址，加密或解密不可用时阻止保存/使用，不回退明文。Token 仅经受校验 IPC 输入一次，不可回读，不进入领域快照、workbench 持久化、查询缓存、终端、SSH 或日志。API 请求由 Mac 发起，凭据仅发送到确认的平台 API，拒绝重定向。Mac 须能访问 API；网络、代理/VPN、证书错误可修改连接及重试，不自动改用远端 CLI 或跳过证书验证。

确认页只读展示仓库、设备、API 账号、源/目标分支和待推送提交；标题预填最新提交主题，正文默认空，均可编辑。存在未提交文件时说明只推送已提交内容。提交前重新验证分支、HEAD、目标、推送地址及连接版本，变化时要求刷新重审并保留输入；推送固定 URL、提交及明确同名分支 refspec，不自动提交、强制推送、推送其他分支/标签或递归推送子模块。API 创建目标为 Workspace 基础分支，仅支持同仓库请求，不自动创建 fork。

同一面板展示 Checking → Pushing → Creating → Success/Failed；主进程按目录去重并保留进度，运行中可 Hide，重开恢复，禁止删除该目录的 Workspace 或 Finish 清理。Git push 使用设备既有 SSH key/credential helper，失败提供所属设备的新 Git push repair Terminal；不注入命令或复制 API Token，修复后重开面板刷新重试。API 401 可重新连接，权限/仓库/限流/网络错误分类显示并保留草稿；若分支已推送明确标记部分成功。POST 失败或超时先查询是否已有请求，重试同样先查询，避免重复创建。成功显示请求链接。草稿、进度与结果仅在当前应用运行时保留；重启后使用加密连接重新检查，不恢复或自动重放推送。领域数据无需迁移，已有 CLI 登录不自动导入。

侧栏 Workspaces 分组的加号和 All workspaces 的 New Workspace 打开独立创建表单，省略 Work Thread 字段。在线程内创建时默认选中当前活跃线程。⌘⇧N 按当前范围选择创建表单。独立 Workspace 创建成功后直接打开，详情显示 Standalone。

Workspace 有两种创建模式：

- 普通文件夹自动选择 `main`，禁用 worktree、base branch 和 Link files and folders；主进程同样拒绝普通目录的 worktree 与链接请求。终端、浏览器与文件预览继续可用，branch/baseBranch 为空，界面不展示空的 Git 分支项。
- `main`：直接使用所选 `Project × Device` 的 base checkout，不创建 worktree 或分支。不同 WorkThread 可以共用同一主目录，独立 Workspace 也可与线程共用；每个 WorkThread 内及独立 Workspace 分组内，同一 `Project × Device` 最多保留一个 main Workspace，主进程以串行事务校验。Workspace 名称仍在同一设备内唯一。配置表单及向导确认页列出共用目录的 Workspace 名称和所属 WorkThread（包括归档线程）或 Standalone，并非阻断地提醒文件改动、Git 分支切换会相互影响，建议需要隔离时使用 worktree。各 Workspace 保持独立记录及终端；删除或 Finish 只清理自己的记录及会话，保留主目录与其他共用者。
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
~/.superthread/workspaces/{project-id}/{workspace-name}
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

### Submodule 改动摘要与留存

- Finish 与单独删除在清理前同时采集主仓库 commits，存入各 Workspace 的 `workspaceChanges[].changes.repository`（可选，含 `currentCommit`、完整 `commits: { hash, subject }[]` 与可选 `warning`）。范围为创建时固定 commit 到本次固定 HEAD 的 Git 可达差集，不依赖当前 base 或是否已合并，不按日期或作者过滤，包含 merge 带入的历史；主仓库不使用子模块的 20 条展示上限。main 目录 Workspace 同样采集。Changes 页提供带数量的可展开列表，并复用复制、导出及明确追加到 Doc；不自动改写正文。记录沿用 pending/deleted/failed、按 workspace ID 重试及归档/恢复/重启保留规则。
- 创建时为空 Git 仓库记录 `gitBaseline.unborn: true`，之后从首个 commit 开始采集。旧 Workspace 仍使用明确标注的 inferred 起点；unknown 起点显示不能确定期间提交。已保存的旧摘要没有 repository 字段时显示「当时未采集」，不反推已删除 worktree 的历史，不需要快照迁移。重写或切换历史导致起点不再为 HEAD 祖先时显示警告；被 reset/rebase 丢弃、不再可达的提交不包含在范围中，也不声称所有提交均由本次工作作者创建。已知起点但对象缺失或 Git log/SSH 读取失败会阻止清理，不保存假空列表。

- schema 17 为 Workspace 增加可选 `gitBaseline`，为 WorkThread 增加可选 `workspaceChanges`；均为所属对象的嵌入数据，不引入新的顶级领域对象。旧快照不回填虚假的创建起点。
- 新 Git Workspace 在启动默认终端前记录固定主仓库 commit 和可读取的各级 submodule 起始 commit；worktree 在复制/链接文件之前捕获。未初始化 submodule 的起点由该固定 commit 中的 gitlink 解析，之后初始化不会重新设置起点。直接目录 Workspace 可记录当时已检出的子模块版本；起始已带未提交文件时标记归属不确定，避免将既有工作归为本次开发。创建时无法捕获则记录 unknown，不阻止工作区创建。
- 旧 Workspace 使用当前 Git 历史的 merge-base 推导起点，明确标为 inferred，说明原始创建点未知；无法推导或缺少对象时标记 unknown。当前 base branch 的移动不能改变新 Workspace 的固定起点。
- 单独删除采用应用 Modal，和 Finish 共用逐项摘要，显示路径、本次是否涉及改动（未发现变化/文件变化/版本更新/新增/删除/无法确认）、起始/当前 commit、未提交/未跟踪状态、相对当前 base gitlink 尚未合入的提交。父仓库 index 中记录的版本与实际检出 HEAD 不同时单独显示，已暂存但未检出的版本更新仍计入本次变化和未合入风险。详情列出文件路径和起点后的提交 hash/subject，每个子模块最多显示 100 个文件和 20 个提交，截断时明确说明。纯版本变化不推断代码作者；摘要不是对改过后完全撤销的编辑行为的完整审计。
- 当前删除风险与本次改动分开：已合入当前 base 的提交仍能显示为本次版本变化；检查不完整仍是可确认警告。未初始化且无风险的子模块无需额外 force。main Workspace 仅展示摘要，继续保留项目目录，不因子模块改动要求 force。
- 预检查、刷新与取消不写入删除记录、不停止终端；worktree 检查可 fetch 更新 Git 远端跟踪 ref，但不修改本地分支、文件或 index。用户确认后，线程所属 Workspace 的完整摘要先保存为 pending，再清理 Git/终端，成功后与 metadata 删除一起保存为 deleted；清理失败保存 failed 和错误。应用中断遗留的 pending 显示“结果未确认”，不能声称删除成功。重试按 workspace ID 更新同一记录，保留已成功项的摘要，整组 Finish 仍仅在全部清理成功后归档。
- 删除开始前同时将摘要保存为 Workspace 的可选 `deletion` 清理凭据，独立 Workspace 也保留，成功清理时随 Workspace metadata 移除；无需迁移旧快照。部分删除或应用中断后，Delete / Finish 只向前继续，不重建 Git 或目录。只有存在匹配 Workspace ID、路径和分支的 pending/failed 凭据时，才允许进入恢复；旧 WorkThread 可使用 Changes 中已有的同类记录。Git worktree 完整时仍执行最新 base/risk/commit 检查；Git registration 或 `.git` 已被移除时保留原起点、commits、submodule 摘要和检查时间，不再尝试从残缺目录重新采集历史，并提示剩余文件无法检查新增改动，要求显式逐项确认后继续清理。
- 恢复清理重新检查所属 Device 的目录与精确 worktree registration：目录尚存时重试删除，目录或对应分支已不存在时按该步骤已完成继续，仅清理对应 registration、branch、Session/tabs 和 Workspace metadata，不全局 prune，不使用 sudo。权限不足继续保存失败记录，提示用户在所属设备修复权限或手动移除目录，再 Refresh checks 并重试 Delete / Finish；不能将 SSH、权限或探测失败当成目录不存在。远端恢复探测要求 Python 3；清理拒绝指向其他位置的 Workspace 软链接及 base checkout（包括别名）或其祖先目录。全部 Workspace 清理成功后 Finish 才归档，保留原摘要、Doc、TODO 和项目关联；普通 Archive 仍只隐藏整组，不触发清理。
- WorkThread 的 Changes 页签提供摘要、结果、复制 Markdown、原生保存对话框导出 `.md`，在 Workspace 删除、Finish、归档与重启后保留。Add summary to Doc 明确追加到当前本地草稿后自动保存，不由删除流程自动重写用户文档。导出取消或失败不影响已有目标文件。
- 独立 Workspace 提供相同的复制和导出能力，成功删除后结果对话框保持打开，Done 才关闭；独立摘要不作为新的全局历史集合保存。
- 新窄 IPC `inspectWorkspaceDeletion(id)` 预检查（含必要的 base fetch）；`exportWorkspaceChanges(markdown)` 校验有界文本并通过所属窗口的原生保存对话框写入本机，renderer 不获得通用文件写入能力。`deleteWorkspace` 返回删除结果摘要，执行前仍重新 fetch 并检查风险。

删除 `main` Workspace 只停止其 Session 并删除 Workspace、Session、BrowserTab 与 FilePreviewTab metadata；保留 base checkout 目录、文件、Git 分支及 ProjectCheckout 记录。即使选择 Force Delete，也不删除 main 目录。旧记录缺少或错误标记 `kind` 时，如果 Workspace 路径与 base checkout 路径相同，仍按此规则处理。

删除 `worktree` Workspace：

1. 在所属 Device 的 base checkout 中先 fetch 最新远端 base，再检查未提交修改、未跟踪文件，以及相对该 base 尚未合并的提交。优先使用本地 base branch 配置的 upstream remote/branch；无 upstream 但存在 origin 时使用 origin 同名分支；base 本身是远端跟踪 ref 时刷新其对应 remote/branch（支持 remote HEAD）。无可用远端映射的本地 ref、仅本地 upstream、tag 或固定 commit 继续在本地比较。fetch 仅更新对应远端跟踪 ref，不 pull、不切换或移动本地分支、不递归 fetch 子模块；每次检查固定 fetch 后的 commit，主仓库与 submodule 共用该版本。fetch 最长等待 30 秒；远端不可用、分支删除或认证失败时检查报错，不能回退到旧 ref 或通过 force 绕过，且不停止终端或删除 Workspace。打开删除弹窗、刷新与实际删除前的复查均采用该规则；创建 worktree 仍不隐式 fetch。提交历史不包含原分支时，补充检查合并结果；若无冲突且合并后的 tree 与 base 相同，视为内容已合入，兼容 squash merge 及其后 base 的更新。检查不修改 checkout/worktree 的文件或 index；仍有内容差异、合并冲突或 Git 不支持该检查时，保留未合并警告。单独删除与 Work Thread Finish 使用相同规则。
   - 递归检查已初始化的 submodule，按路径提示未提交修改、未跟踪文件和当前 HEAD 中尚未合入刷新后 base 所记录 submodule 版本的提交；嵌套 submodule 沿 base 中记录的 gitlink 逐级比较，不以 Workspace 中已暂存或已提交的新 gitlink 作为基准。子模块自身不 fetch；忽略 submodule 的用户配置不能隐藏这些风险。无法验证 submodule 状态、base 缺少对应 gitlink 或本地缺少比较所需对象时，提示检查不完整及潜在代码丢失风险，仍允许用户确认后删除。
   - 相对起点未变化、没有自身未提交/未跟踪文件且检查完整的 submodule 不产生删除警告，也不要求额外 force 确认，即使其已有版本相对当前 base 存在未合入提交。起点已检出 HEAD 与父仓库记录的 gitlink 可以不同，分别比较对应的起始版本，不能把已有差异算作本次版本更新。嵌套模块的文件和版本变化在所属模块单独检查，不把嵌套状态向上重复标成父模块的未提交文件。实际改动的未合入提交、未提交/未跟踪文件及检查不完整仍为可确认警告；用户取消时不停止终端、不删除目录或记录。通过风险检查及必要的用户确认后，已初始化的 submodule 自动使用 Git 所要求的 `git worktree remove --force`，单独删除与 Finish 共用该流程。未初始化的 submodule 不额外要求 force。
2. 停止所有 Session
3. 删除 Git Worktree
4. 删除对应 Branch
5. 删除 Workspace、Session、BrowserTab 和 FilePreviewTab metadata

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

只有在 PTY/连接、Git worktree 和 branch 删除成功后，才删除持久化 Workspace、Session、BrowserTab 与 FilePreviewTab 记录。失败时必须保留 metadata，避免 UI 状态与实际 Git 状态失配。

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

  kind: "shell"

  order: number

  shell: string

  pid?: number
  cwd?: string
  activityStatus?: "idle" | "busy" | "waiting-input" | "unknown"
  exitReason?: "process-exit" | "user-closed" | "runtime-stopped" | "restore-failed"
  exitCode?: number
  restoreError?: string
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

`status` 描述 PTY 生命周期；`activityStatus` 描述能可靠观测到的活动。本地 Terminal 通过本地进程组采样区分
`busy` 与空闲，命令完成后未读结果为 `waiting-input`，查看后为 `idle`。远程 Terminal 只保留交互 SSH
连接，存活时活动标记为 `unknown`；不得为了判断忙闲周期性创建 SSH，也不得把未知状态展示为空闲或忙碌。

---

# 15. Terminal Runtime

- Terminal 的选区通过系统剪贴板复制，支持 Cmd+C 和原生 Edit → Copy；Ctrl+C 保留中断进程语义。全屏应用接管鼠标且没有终端自身选区时，Copy 转发标准 Ctrl+Insert 复制请求，由应用复制其内部选区。macOS 仍可按住 Option 拖动强制选择终端文字。
- 支持 tmux、Codex 等 CLI 发出的 OSC 52 剪贴板写入（UTF-8 文本，最多 2,000,000 字节），使 tmux 配置的鼠标选中后自动复制可到达本机系统剪贴板。本机和 SSH 终端使用相同处理；不读取或向 CLI 返回剪贴板内容，忽略无效、空或超限请求，历史重放不触发剪贴板写入。

Workspace 的新建 Terminal 菜单提供 `Custom…`，可创建、编辑和删除 Device 下的自定义终端入口。每个入口包含名称和启动目录，名称在同一 Device 下忽略大小写唯一；不同 Device 可使用相同名称。入口作为 Device 配置持久化，不引入新的顶级领域对象。Workspace 菜单只显示其所属 Device 的入口，同一 Device 的多个 Workspace 复用同一组入口。

点击入口会在该 Workspace 中新建普通 shell Session，由 Workspace 所属 Device 在指定目录启动。保存和启动时均验证目录存在并可访问，`~` 按所属 Device 的用户 home 解析；目录不存在、Device 不可用或入口不属于当前 Device 时显示错误，不回退到 Workspace 目录。Session 保存实际启动目录，恢复时继续使用该目录。编辑或删除入口不影响已创建的 Session，也不修改 Workspace 的路径、worktree 或 Git 分支。

创建 Session 只支持普通 shell Terminal：

- `shell`：普通 Terminal，在 Workspace 当前目录启动 shell。
- `tmux` 不创建 SuperThread Session 或内嵌 Terminal。每个 Workspace 只拥有一个 tmux session；首次选择 `tmux in iTerm` 时按 Workspace 名称分配并持久化 session 名称，若 Device 上已有同名 session，则依次追加 `-2`、`-3` 等数字。Runtime 在 Workspace 所属 Device 上确保该 session 存在，然后让 iTerm 通过本地命令或 SSH 直接 attach，不加载可能截断命令的交互式登录 shell。已有 iTerm terminal window 时在当前窗口新建并选中 tab；没有 terminal window 时才新建 window。重复打开必须复用同一个 tmux session，不得创建额外 tmux window 或 SuperThread Session 记录。缺少 tmux 或 iTerm 时直接提示错误，不回退为内嵌 shell。

iTerm attach 必须使用可用性探测得到的 tmux 绝对路径。Local Device 通过非交互式 `/bin/sh -c` 解释 `cd` 与 `exec`，不得依赖 iTerm profile 的 PATH 或把 shell 语法直接作为 profile command；Remote Device 则把相同的绝对路径和 attach 命令交给 SSH 执行。

Workspace tmux 的可用性探测、创建必须使用 Device 用户的交互式登录 shell，使 SSH
设备上的 `.bashrc` / `.zshrc`、Conda、nvm 等 PATH 配置与普通 Terminal 中的行为一致；iTerm attach
是例外，必须直接执行，避免有 TTY 时的 shell 初始化逻辑替换 attach 命令。
新建 Terminal 后，Renderer 必须立即展示并选中仅存在于 UI 状态中的初始化标签页；
成功后用持久化 Session 替换该标签页，失败后保留错误、Retry 和 Close，且 Retry 复用同一标签页。
未创建成功的初始化标签页不得写入持久领域数据。

Terminal 输入保留 xterm 的原生 IME composition 处理，并补齐输入法在按键按下期间直接提交
`insertText`、没有 keypress 的路径，确保中文全角标点首次输入即生效且不重复。普通 Enter
仍发送回车；非 composition 期间的 Shift+Enter 发送标准 CSI-u `ESC [ 13 ; 2 u`，让 Codex
等 CLI 区分换行与提交。本机和 SSH 终端使用相同编码，不探测前台应用；输入法候选确认键
继续交给 xterm，不将候选确认误编码为 CLI 换行。

普通本地 Session 的周期性活动检查只运行本地 `ps`，不得启动登录 shell。远程 Session 不进行后台
SSH 活动查询，不创建 PID 探测文件，不读取 Codex index，也不为工具查找或会话恢复建立周期查询。
关闭 Terminal tab 或退出应用时即时检查真实进程树，只把仍有前台、后台或暂停任务的 Terminal
列入运行程序确认，显示 Workspace、Terminal 名称和程序名；只有空闲登录 shell 时直接关闭或退出。
不使用持久化 PID、`status=running`、历史活动状态或远程 `unknown` 推断正在运行程序。
远程 shell 启动时通过原交互 PTY 的带随机标识 OSC 帧一次性报告 shell PID，主进程剥离帧并仅在
当前 runtime 内保存；不落盘、不增加后台 SSH。显式关闭/退出时按设备合并一次有超时的 SSH `ps`
查询；无法检查（如连接建立中、SSH 不通、权限或命令不支持）单独列为「无法确认」，不冒充运行程序。
取消确认保留 Terminal；重复退出或关闭同一 Terminal 不叠加弹窗。已退出任务和 zombie 不算运行，
已脱离终端且不再属于 shell 进程树的服务不在此检查范围。macOS 仅关闭窗口仍保留 PTY，不做终止确认。
创建 Session 的 UI、IPC 和 runtime 只接受 shell；移除内嵌 Codex 与 tmux 的启动、探测、恢复和控制分支。
用户仍可自行在普通 shell 或 iTerm 中运行任何 CLI。

### Codex 会话记录

Device 增加 `codexRecordingEnabled` 配置，界面标签为「启用 Codex 会话记录」。新 Device（含首次安装创建的本机 Device）默认开启；旧 Device 缺失该字段时保持关闭，不回填、不读取历史 Codex ID 或记录。已有 Device 可以在 Devices 页勾选并保存；远程 Device 的新增、编辑配置也提供开关。关闭立即停止保存新观察，已有记录继续保留；开启后需新建或重新启动内嵌 Terminal 才能加载集成。

新增/开启时通过该 Device 已有的执行方式自动部署 Python 3 采集脚本到 `~/.superthread/integrations/codex/`，不需要 root。仅合并 `$CODEX_HOME/hooks.json`（默认 `~/.codex/hooks.json`）中的 SuperThread `SessionStart` / `UserPromptSubmit` 命令，保留其他 Hook，修改前备份。安装幂等、原子写入，格式无效时保留原文件并显示错误。安装失败不阻止保存 Device 或使用普通 Terminal；Devices 提供错误详情及 Reinstall collector 重试。安装成功只表示文件已安装，不宣称 Hook 已受信任；用户需要在 Codex `/hooks` 首次确认信任，SuperThread 不绕过信任检查。

仅覆盖 WorkThread 下的本机/SSH 内嵌 bash、zsh Terminal，不覆盖 iTerm、tmux、其他 shell 或另行连接的 Codex app server。集成通过会话内的 shell 函数调用原 CLI，原样传递参数，不探测或自动添加 `--no-daemon`。直接运行 `codex` 保留共享后台服务及本地 Codex 对远程运行会话的发现/接管能力，不记录到 WorkThread。只有用户显式运行 `codex --no-daemon` 时才启用记录上下文；该模式绕过共享服务，运行会话不能同时在本地 Codex 中共享。共享 daemon 可能保留其他 Terminal 的环境，因此不保存其不确定归属，也不按 cwd 猜测。管理子命令、显式连接 app server、选项值或 `--` 后的同名文本不能误开启记录。保留正常登录 shell 启动文件，不修改用户的 shell 配置；CLI 参数支持情况由原 CLI 校验。升级后在设备上新建 Terminal 或 Reinstall collector 替换已安装脚本；Hook 拒绝旧版本残留的记录上下文，避免共享服务继续使用旧标识。

Terminal 启动时生成只用于当前 PTY 的随机标识。Hook 将真实 Codex `session_id`、事件、cwd 和截断至 160 字符的提问摘要，通过原 PTY/SSH 输出通道的私有 OSC 帧回传。主进程增量解析、校验标识/事件/大小，剥离帧后才发送到 renderer 和 replay；无新后台 SSH、HTTP 服务或周期查询。通过 Terminal → Workspace → WorkThread / Project / Device 关联，不能按 cwd 猜测归属。同目录多个 WorkThread 不混记；独立 Workspace 没有 WorkThread，因此不生成此类记录。

记录是 WorkThread 的 `codexSessions` 值记录，不改变代表 shell PTY 的 `Session`，不引入 Agent / Task / Workflow。保存 Codex ID、项目 ID/名称/code、设备 ID/名称、Workspace ID/名称、首次 Terminal ID、cwd、首条观察到的提问摘要（明确标注「提问摘要」，不冒充 Codex 原生标题）、首次/最近观察时间。不保存完整提示词、会话正文或历史日志。按 `(workThreadId, projectId, deviceId, codexSessionId)` 去重；resume / compact 同一 ID 不增加数量；新建、clear 或 fork 产生新 ID 时新增。一个 ID 在不同 WorkThread 中被使用时，各线程记录自己观察到的关联。

WorkThread 的 Document / Todos / Changes 后增加 **Codex (数量)** 页签，支持同样的键盘导航，按 Project 分组、组内按最近观察时间倒序展示记录；数量为唯一会话数，不是进程启动数、提问数或完整历史总数。没有记录时说明开启、信任 Hook、新 Terminal 和显式 `codex --no-daemon` 的步骤，并说明记录模式无法同时共享运行会话，普通 `codex` 保留共享。此阶段只记录与展示，不提供会话恢复、正文查看或删除记录操作。关闭 Terminal、删除 Workspace、Finish、归档、重启均保留记录及项目/设备名称快照；删除整个 WorkThread 才随之删除。

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

Desktop Runtime 启动时必须核对持久化 Session 与真实 runtime 状态，不能信任旧 PID。上次退出或连接中断时仍标记为 `running` 的 Session 会按 Workspace 批量恢复；恢复时使用各自记录的 `cwd` 启动普通 shell。schema 13 将旧 Codex 标签迁移为已退出的普通 shell，保留 id、名称、目录、顺序与旧 conversation ID 参考值，清除旧 PID 与专用运行状态；用户可手动 Resume，不自动执行 Codex。旧快照中的内嵌 tmux Session 迁移为 Workspace 的唯一 `tmuxSessionName`，不再恢复内嵌 PTY。

单个 Session 恢复失败时只影响自身：状态变为 `restore-failed`，保留 `restoreError`，UI 提供 Resume 重试和新建同类型 Session 入口。其他 Session 的恢复继续执行。

用户主动关闭 Terminal tab 时，Runtime 关闭当前 PTY 或远程连接，并删除该 Session 的持久化记录。Workspace tmux 不显示为 Terminal tab，其生命周期由远端 tmux 与 iTerm 客户端负责。主动关闭的 Terminal 不会在下次打开 Workspace 时自动恢复。Terminal 名称、顺序、类型、工作目录和恢复标识需要持久化。

Session 进入 `exited` 或 `restore-failed` 状态后，Terminal 页面中央提供 Resume 操作。Resume 保留原 Session 的 id、名称与标签页，在记录的 cwd 或 Workspace 路径中重新启动 PTY，并将 Session 状态更新为 `running`；它不承诺恢复已经退出的 shell 进程内存或历史终端缓冲。

Remote Session 的交互式 SSH 连接必须配置连接超时和 server keepalive。SSH 在 Session 创建、恢复或网络中断时退出，即使退出发生在持久化启动状态之前，也必须把原 Session 记录为 `exited` 并显示 Resume；不得遗留没有真实 PTY 的 `running` 状态。Resume 必须复用原 Session metadata。iTerm 中的远程 tmux 连接使用相同的连接超时与 server keepalive 参数。

退出整个应用时，如果存在本地忙碌 Session 或活动未知的远程连接，主进程必须展示确认提醒并列出这些 Session，避免关闭无法判断忙闲的远程工作。本地已知空闲 Session 不触发提醒。macOS 上只关闭窗口不触发该提醒，窗口关闭期间 PTY 和已经建立的 SSH 隧道继续存活并可重新附着，但不得不断创建新的 SSH。窗口关闭时取消待执行的隧道重试，禁止断线或系统唤醒触发后台重连；重新打开窗口后只恢复已断开的隧道，保留健康连接。原连接上的 keepalive 不创建新 SSH 进程或 shell。

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

Workspaces
  local-sandbox
```

Work Threads 与 Workspaces 是两个独立可折叠的分组，默认展开，分别保存折叠状态。折叠时保留当前页面与线程节点的展开状态，分组的新建按钮始终可用。Workspaces 分组只列出独立 Workspace，线程所属 Workspace 继续显示在对应线程下。

侧栏的 Workspace 统一使用两行布局：第一行显示 Workspace 名称，第二行显示「Device 名称 · Project 名称」，同项目在不同设备上的 Workspace 可直接通过设备名称区分。保留本机／远程图标，设备名称始终显示，不依赖颜色或悬停辨认。窄侧栏中设备名称最多占上下文行的 65%，项目名使用剩余空间，两者独立省略；悬停整行及无障碍名称提供完整 Workspace、Device 和 Project 信息。线程内与独立 Workspace 使用相同规则，保留现有分组、排序和点击／右键行为。

Project 和单个 WorkThread 都是 Workspace filter。侧栏中的 WorkThread 提供右键菜单，用于调整优先级或归档；展开后的 Workspace 提供右键菜单，用于编辑 Workspace 信息，其中只有名称可以修改。All projects 打开 Project 管理页面，可新增、重命名和删除未被 Workspace 使用的 Project。All work threads 打开 All / Active / Archived 管理页面，支持项目和文档更新时间筛选；All devices 打开 Device 管理页面，可查看连接状态和资源占用、添加或编辑 Remote Device、检测连接，并删除未被 checkout 使用的 Remote Device。Local Device 由应用管理，不能编辑或删除。归档 WorkThread 及其 Workspace 不出现在其他 active scope。

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

Workspace Header 固定为 40px 的单行，显示：

```text
nvfp4-kernel ▾ · dev-cuda · work/nvfp4-kernel       [Focus 图标] [⋯]
```

Workspace 名称优先保留，Device 与 Branch 使用次级文字。宽度不足时省略并可悬停查看完整文字，Header 与操作区均不换行；侧栏收起时保留 macOS 交通灯与展开侧栏按钮的安全区。点击名称展开现有详情浮层，查看 WorkThread、Project、Device、Type、Branch、Base 与完整 Path。

右侧保留 Focus 图标和 Workspace actions 菜单。菜单提供 `Open in VS Code`、`tmux in iTerm`、`New Workspace`、`Rename workspace…` 和 `Delete workspace`；标签栏 `＋` 仍负责新建 Terminal、Browser 和 File Preview。VS Code 对本地 Workspace 使用本地文件 URI，对 Remote Workspace 使用 Remote-SSH URI，并沿用 Device 已保存的 SSH user、host 和非默认 port。两类 URI 均携带 `windowId=_blank`：由 VS Code 按完整目录 URI 匹配并置前已打开的窗口，没有匹配时新建窗口，不替换其他目录的窗口；同项目的不同 worktree 按各自目录分别打开。tmux 操作在 iTerm 当前窗口打开 Workspace 的唯一 tmux session。Workspace 尚未 ready 时禁用 Focus 与外部打开操作；外部打开期间禁用对应菜单项。菜单或详情可通过 Escape 或点击外部关闭，Escape 将焦点归还入口。

有需要注意的 Session 时只显示一个紧凑计数标记，汇总正在执行、等待输入与恢复失败的数量；悬停及辅助技术可读取各项数量，标记颜色优先表示恢复失败、其次等待输入。远程未知活动不推断为忙碌或等待。

Terminal、Browser 和文件预览共用的标签栏固定高 32px，保留关闭、拖动排序及 ⌘1–⌘9；标签过多时横向滚动。Browser 和文件预览工具栏均为 32px，使用 28px 控件，文件预览顶部总高为 104px。普通 Browser 地址可编辑，文件路径保持只读并通过文件夹入口选择文件。Focus 标题栏同样为 40px，保留退出入口及交通灯安全区。正文、弹窗和全局 34px 控件不缩放。

---

# 21. Terminal Area

Workspace 默认创建一个 Session：

```text
Terminal 1
```

允许：

```text
+ New Terminal
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
Import Existing Directory
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

系统解析目录并读取：

```text
resolved path
name (optional override, otherwise folder name)
origin URL (optional)
default branch (Git roots only)
```

创建：

```text
Project
+
ProjectCheckout
```

Import 支持本机和远端普通文件夹、没有 origin 的 Git 仓库及完整 Git 仓库。只拒绝同一 Device 的重复实际路径；项目名称与 remote 可以重复。表单提供可选 Project name，并说明 Git 可选。失败保留输入；成功后 Project 列表显示 Device 与完整目录，普通文件夹不展示虚构的 Git 信息。Clone 继续使用 Git URL，并在完成后使用同样的目录判重。

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

Tunnel 配置属于持久连接配置，但 SSH tunnel 进程、PID、重试次数和连接状态都属于 runtime state。Desktop Runtime 使用 `ssh -N`、keepalive 与 `ExitOnForwardFailure` 维护每条映射独立的 tunnel 进程；有窗口打开时，断网或 SSH 退出后按指数退避自动重连，macOS 从睡眠恢复时重建连接；所有窗口关闭后暂停重试与唤醒重连，重新打开窗口时恢复已断开的隧道；应用退出时终止 tunnel 进程。

Device 页默认折叠 tunnel 明细，显示 active 数量及端口预览；展开可查看每条映射的方向、源端口、目标与实时状态。编辑时既有映射以摘要行展示，每次只展开一条；新增映射置顶、自动展开并聚焦端口，不需要滚动到底部。最多 32 条映射。

保存配置后立即自动连接，无需 Check connections；后者只检查 SSH 可达性，不代表 tunnel 生效。未保存映射标记 Unsaved，运行态区分 Connecting、Active、Retrying 与 Paused。只有 SSH 已确认监听建立后才显示 Active；反向映射等待服务端确认。Active 不代表目标应用已启动或应用请求一定成功。失败时显示 SSH 错误并自动退避重试，状态经独立 typed IPC 实时更新，不写入持久快照。未修改的映射在保存时保持原连接，单条映射失败不影响其他映射。

编辑时提前标出配置冲突并阻止保存，主进程在串行持久化事务内再次校验：本机源端口在所有 Device 的 local-to-remote 配置之间唯一；同一 host（忽略大小写）与 SSH port 的 remote-to-local 源端口唯一（不因 SSH user 不同而隔离）。不同 host 别名指向同一机器，或其他应用占用端口，只能由 SSH 实际建立时检测并显示失败原因。

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
Project ≠ Git remote identity (directories belong to Device checkouts)

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


## Workspace Browser Tabs

- Browser 在窗口连续缩放时保持网页可见，只更新原生视图边界；切换标签或显示覆盖层时才隐藏。菜单、弹窗或拖动覆盖 Browser / File Preview 时，先获取当前视口快照并绘制在 renderer 中，再隐藏原生视图，避免内容区域变黑；关闭覆盖层后恢复同一原生页面，不重载或重置滚动位置。快照只在内存中保留，恢复、切换或关闭标签时释放，过期截图不得隐藏或覆盖新的页面。

BrowserTab 是 Workspace 持有的本机网页视图记录，不复用代表 PTY 进程的 Session。它保存 `id`、`workspaceId`、`url`、`title`、`order`、`createdAt` 和 `updatedAt`；旧快照迁移为没有 Browser 的集合。地址、标题、顺序属于持久数据，加载状态、错误和前进后退能力属于运行时状态。

- 在 Workspace 中持续按住 Command 3 秒后，前九个 Terminal / Browser / File Preview 标签（含初始化标签）按当前混合排序显示 ⌘1–⌘9；按 Command + 对应数字立即切换，无需等待提示，网页获得焦点时同样有效。数字切换、松开 Command、窗口失去焦点、切换 Workspace 或打开应用弹窗时立即隐藏提示并取消待显示计时；数字切换后本次长按不再显示提示，重新按住 Command 才重新计时。应用弹窗打开时暂停此快捷键。
- ⌘W 关闭当前 Workspace 的当前标签，Terminal、Browser、File Preview 和初始化标签均沿用各自关闭按钮的行为；没有当前标签时不关闭窗口。⌘R 刷新当前 Browser 页面或重新读取当前 File Preview，不重载应用、不切换 Workspace 或打开 WorkThread Doc；Terminal 不执行刷新。网页内容或工具栏获得焦点时同样有效，应用弹窗打开时暂停这两个标签操作。File 菜单的 Close Tab 和 View 菜单的 Reload Tab 使用相同分发；Close Window（⌘⇧W）与 Reload App（⌘⇧R）保留为独立的窗口级操作。
- 现有标签栏加号可创建多个 Browser，与 Terminal 并列选择、关闭和拖拽排序；排序覆盖同一 Workspace 的全部 Terminal 与 Browser。
- 地址栏只接受 HTTP(S)。裸域名默认 HTTPS，localhost 与本机回环地址默认 HTTP。输入地址后先保存再加载；主框架导航、重定向和站内地址变化更新最后访问地址。页面标题更新标签标题。
- 每个 Browser 使用主进程独立创建的 WebContentsView，禁止 Node integration、preload 注入、未授权权限和下载；网页不具有应用 IPC 权限。后退、前进、刷新、加载状态和错误提示由应用地址栏提供。
- 网页请求打开新的 HTTP(S) 窗口时，在原 Workspace 创建 Browser 标签；不允许其他协议打开新窗口或导航。
- 标签切换保留网页状态；窗口布局变化同步网页边界，应用弹窗、覆盖菜单或拖拽时隐藏网页视图。
- 关闭主窗口销毁网页视图；窗口重开或应用重启后，恢复全部未关闭 Browser 并自动加载各自最后访问地址。前进、后退历史不恢复。关闭标签删除其记录，删除 Workspace 一并清理 Browser 记录和视图。Terminal 的原有运行时生命周期保持独立。
- Remote Workspace 的 Browser 仍运行于 Mac 本机，localhost 指 Mac；远程网页可使用已有 SSH 端口转发访问。

验收覆盖多个 Browser 创建与地址独立保存、主框架及站内导航更新、混合排序、关闭删除、旧快照迁移、窗口重开和应用重启自动加载、Workspace 删除清理，以及真实 Electron 中网页加载、导航控件、安全隔离、弹窗遮挡、浅深色、窄窗口、交通灯间距、拖拽与 Terminal 输入输出及切换。

## Workspace 文件预览

- Workspace 标签栏「＋」提供 File Preview。新建预览的选择弹窗从 Workspace 根目录开始，可使用面包屑、上级目录及刷新浏览文件；目录和 PDF、HTML、Markdown 文件可选，支持 `.pdf`、`.html`、`.htm`、`.md`、`.markdown`，扩展名忽略大小写。路径保留合法文件名中的空格与换行；弹窗和工具栏均只读显示路径，只能通过目录浏览和文件选择打开文件。
- 文件通过所属 Device 读取。本地使用 Node 文件 API，远端使用现有系统 SSH 配置临时执行 Python 3 辅助代码，不部署常驻服务或开放端口。缺少 Python 3、连接失败、文件消失、权限不足及超限均显示明确错误并可重试。
- FilePreviewTab 独立于 PTY Session 和普通 BrowserTab，保存 id、workspaceId、规范化的 Workspace 相对路径、fileType、order、createdAt 和 updatedAt。重复打开同一 Workspace 的实际文件路径会聚焦已有标签。标签与 Terminal、Browser 混合排序、关闭及使用 ⌘1–⌘9 切换。
- schema 14 增加 `filePreviewTabs` 集合，旧数据迁移为空集合。重启及窗口重开后恢复标签与顺序，在首次选择时读取最新内容；加载状态、错误、文件字节和 SSH 子进程属于运行时数据，不写入快照。成功删除 Workspace 后清理其预览标签及运行时。
- 预览为只读。PDF 使用内置查看器支持翻页和缩放，协议支持 Range；HTML 支持内嵌 JavaScript、Workspace 内的 JS/module 文件和基于内嵌数据的动态图表（含表达式编译与 Blob Worker），同时阻止 fetch、XHR、WebSocket 等数据连接；Markdown 渲染标题、列表、表格、引用与代码块，关闭原始 HTML。不运行 Markdown 图表脚本。
- 主文件、目录及关联资源均检查实际路径，拒绝越界、目标位于 Workspace 外的软链接和非普通文件。相对资源从当前文件目录解析，根相对资源从 Workspace 根目录解析；仅自动加载 Workspace 内资源，不请求 CDN。受支持的文件链接打开预览标签，用户点击的 HTTP(S) 链接打开普通 Browser 标签。
- 工具栏采用 32px 高的单行地址栏，显示只读的 Workspace 相对路径、刷新按钮及文件夹按钮。文件夹按钮从当前文件所在目录打开选择弹窗，选择文件后在当前标签切换 PDF、HTML、Markdown，保留标签 id、顺序及创建时间，持久化更新后的路径和格式。目标已在其他预览标签打开时切到已有标签；取消选择保留原页面，选择失败在弹窗内提示错误；Escape 关闭弹窗。切换格式时重建对应的隔离视图，避免复用错误的脚本设置。刷新重新读取文件和关联资源；切换标签保留页面，不轮询 SSH。HTML/Markdown 上限 5 MiB，PDF 和单个关联资源上限 50 MiB，超限报错且不截断。文件缓存总量上限 256 MiB，最多同时进行四个读取请求；关闭标签或窗口释放其缓存并取消请求，旧请求结果不得覆盖新内容或重建标签。
- 文件工具栏提供 Download 图标，点击后使用绑定所属窗口的 macOS 保存对话框选择本机路径，默认保留源文件名。远程 Workspace 使用既有 SSH 配置重新读取当前文件，本地 Workspace 支持另存副本。只下载原始主文件，不保存 Markdown 渲染后的 HTML，不打包 HTML/CSS/图片等关联资源。下载沿用 Workspace 实际路径校验、Python 3 要求、30 秒 SSH 超时及 HTML/Markdown 5 MiB、PDF 50 MiB 上限，不使用预览缓存。读取完整文件后在目标目录暂存并原子替换；读取、写入失败或取消时保留已有目标文件并清理暂存内容。下载中按钮显示忙碌并禁用重复操作；取消不报错，成功或失败提供提示，失败可再次点击重试。关闭标签、切换该标签的文件、删除 Workspace 或关闭所属窗口时取消未完成下载。下载不改变标签、路径、排序或持久化 schema。
- Renderer 仅通过标签 id 请求下载，不传 SSH 参数、源路径、根目录或本机保存路径；主进程沿用 IPC 来源检查与 Zod 校验，目标位置仅由原生保存对话框返回。沙箱页面自身的自动下载仍被阻止。
- Renderer 仅使用校验过的窄 IPC：浏览 Workspace 文件、打开/关闭预览、刷新、下载、布局和运行状态。文件视图使用独立内存 session、沙箱 WebContentsView 和专用协议，无 Node 或应用 preload，禁止页面权限、页面发起的下载及任意导航；弹窗、菜单和拖动期间隐藏原生视图。

验收覆盖本地与真实 SSH 的三种文件、中文及特殊文件名、关联资源和相对路径、软链接边界、PDF 二进制与 Range、HTML 内嵌数据动态图表、Workspace 脚本加载、Markdown/SVG 脚本及外部连接阻止、刷新与断线重试、重复打开、混合排序与快捷键、旧快照迁移、窗口重开和 Workspace 删除清理，以及浅深色、窄窗口、交通灯、拖动区、弹窗遮挡和 Terminal 生命周期回归。

## UI 质感与可读性

- 应用采用中性灰配色并跟随系统浅色/深色外观；主要操作使用黑白反色，链接和键盘焦点使用蓝色，成功、警告与错误使用独立语义色。
- 使用系统 UI 字体与默认字体平滑策略，不强制修改应用缩放。正文和导航为 14px，按钮/菜单为 13px，辅助信息为 12px，页面标题为 20px，常规/强调/标题字重为 400/500/600。普通文字在实际背景上的对比度至少为 4.5:1。
- 新安装侧栏默认宽度为 240px；保留已保存宽度与 184–340px 调整范围。单行导航高 36px，普通按钮和输入框高 34px；最窄侧栏仍在右侧留白内省略长名称。
- 文档正文为 15px、1.65 行高，阅读容器最大宽度为 800px，代码为 13px；抽屉内自适应收窄，表格与代码块独立横向滚动。编辑器工具栏、TODO、菜单、弹窗和浏览器工具栏沿用统一 token。
- 终端在两种系统外观下均保留中性深色背景，使用 14px 等宽字体、1.3 行高和完整 ANSI 明暗色；终端容器、标签和空状态共享颜色来源。字体及布局变化应正确触发 fit/resize，保留既有 PTY attach 和剪贴板行为。
- 最小 880×560 窗口内，操作区可换行，表单正文可滚动且底部操作始终可达；交通灯安全区、窗口拖动区、控件 no-drag 和原生网页遮挡继续有效。

验收应在同一显示器、100% 应用缩放下保留前后截图，覆盖浅/深色、默认/最小窗口、侧栏展开/折叠/最窄、长中文名称与路径、文档抽屉、键盘焦点和弹窗。终端需实测创建、attach、输入输出、ANSI、中英文、resize、切换、复制粘贴、关闭以及关闭窗口后的重连；浏览器需实测工具栏导航、边界和弹窗遮挡。
