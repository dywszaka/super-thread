# Superset macOS 桌面 UI 实现与可复用框架

> 基于当前仓库 `apps/desktop`（应用版本 1.30.0）整理。本文的目标不是复刻 Superset 的业务，而是说明它如何做出 macOS 原生观感，并把其中可迁移的 UI 框架抽象成一套可以用于新 App 的结构。

## 1. 先说结论

Superset Desktop **不是 SwiftUI/AppKit 原生 UI**。它采用的是：

```text
Electron 原生窗口壳
  + React 19 渲染界面
  + Tailwind CSS 4 设计令牌
  + shadcn/ui 风格组件（底层主要是 Radix UI）
  + TanStack Router / Query / DB
  + Zustand 状态管理
  + tRPC + preload bridge 调用本机能力
```

它的“mac 原生感”主要来自以下组合，而不是把页面写成 AppKit 控件：

1. 使用无普通标题栏的 `BrowserWindow`，保留并重新定位 macOS 红黄绿交通灯。
2. React 页面主动给交通灯留出安全区，并用 CSS 声明可拖拽区。
3. 使用 Electron 的原生应用菜单、系统通知、Dock、文件选择器、深链和自动更新。
4. 跟随系统明暗模式，使用系统字体和细边框、低对比度填充等桌面设计语言。
5. 主进程、preload、renderer 三层隔离，renderer 不直接访问 Node.js。
6. 以侧栏、顶部工具条、页签、多分栏 pane、右侧检查器组成桌面工作台，而不是网页式的纵向页面。

因此，如果目标是“快速实现一个像 macOS 原生 App 的跨平台桌面应用”，可以沿用本文抽出的 Electron 框架。如果目标是“真正的 macOS 原生控件、原生可访问性树和最小运行体积”，则应使用 SwiftUI + AppKit；本文第 11 节给出了对应关系。

## 2. 当前实现的整体分层

```text
┌─────────────────────────────────────────────────────────────┐
│ macOS                                                       │
│ 原生窗口 / 交通灯 / 菜单 / Dock / 通知 / 文件面板 / 权限     │
└──────────────────────────────┬──────────────────────────────┘
                               │ Electron main process
┌──────────────────────────────▼──────────────────────────────┐
│ Main                                                        │
│ BrowserWindow、应用生命周期、菜单、协议、更新、系统能力       │
└──────────────────────────────┬──────────────────────────────┘
                               │ preload + contextBridge + tRPC IPC
┌──────────────────────────────▼──────────────────────────────┐
│ Renderer foundation                                         │
│ React、路由、错误边界、主题、i18n、Query、全局 Provider      │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Workbench                                                    │
│ Sidebar │ Top bar │ Tabs / Split panes │ Right sidebar       │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Feature panes                                                │
│ Terminal / File / Diff / Browser / Chat / Page / PR 等       │
└─────────────────────────────────────────────────────────────┘
```

对应源码入口：

| 层 | 关键位置 | 职责 |
| --- | --- | --- |
| 主进程 | `apps/desktop/src/main/index.ts` | Electron 生命周期、协议、系统权限 |
| 窗口 | `apps/desktop/src/main/windows/main.ts` | `BrowserWindow` 参数、窗口恢复、多窗口 |
| 原生菜单 | `apps/desktop/src/main/lib/menu.ts` | macOS application menu 和快捷键 |
| 安全桥 | `apps/desktop/src/preload/index.ts` | `contextBridge`、低层 IPC、tRPC IPC |
| IPC API | `apps/desktop/src/lib/trpc/routers/` | 类型安全的系统能力接口 |
| Renderer 入口 | `apps/desktop/src/renderer/index.tsx` | React、Router、全局错误处理 |
| 根 Provider | `apps/desktop/src/renderer/routes/-layout.tsx` | Query、鉴权、主题关联、Toast |
| 工作台布局 | `apps/desktop/src/renderer/routes/_authenticated/_dashboard/layout.tsx` | 侧栏、TopBar、主内容、右栏插槽 |
| Pane 框架 | `packages/panes/` | tab、split tree、pane registry、拖拽布局 |
| 设计系统 | `packages/ui/` | shadcn/Radix primitives 和公共组件 |
| 主题 | `apps/desktop/src/shared/themes/`、renderer theme store | UI/终端颜色、明暗模式、持久化 |

## 3. macOS 原生窗口壳是怎么做的

### 3.1 隐藏普通标题栏，但保留交通灯

主窗口的关键配置位于 `apps/desktop/src/main/windows/main.ts`：

```ts
const window = new BrowserWindow({
  minWidth: 400,
  minHeight: 400,
  backgroundColor: prefersDark ? "#252525" : "#ffffff",
  acceptFirstMouse: true,
  autoHideMenuBar: true,
  titleBarStyle: "hidden",
  frame: false,
  trafficLightPosition: { x: 16, y: 16 },
  webPreferences: {
    preload,
    partition: "persist:app",
  },
});
```

其中：

- `titleBarStyle: "hidden"` 让网页内容延伸到标题栏区域。
- macOS 分支使用 `trafficLightPosition` 把交通灯固定在侧栏顶部。
- `backgroundColor` 在 React 尚未挂载时也能避免白屏闪烁。
- `acceptFirstMouse: true` 让非激活窗口中的第一次点击直接传给内容，交互更像原生工具 App。
- 当前项目没有实际调用 `setVibrancy`；原生观感主要靠配色和布局，不应把它误解成依赖毛玻璃效果。
- 项目在 macOS 上关闭了 renderer background throttling，规避后台或最小化后 GPU 合成层异常。

### 3.2 页面自己负责拖动窗口

隐藏标题栏以后，必须由 renderer 标记哪些区域可以拖动窗口：

```css
.drag {
  -webkit-app-region: drag;
}

.no-drag {
  -webkit-app-region: no-drag;
}
```

框架约束：

- 标题栏空白区域使用 `.drag`。
- 按钮、输入框、菜单触发器、页签关闭按钮必须使用 `.no-drag`。
- 全屏错误页也必须保留一条独立 drag strip，否则异常时窗口无法移动。
- 交通灯的位置是物理像素概念；页面缩放时不要让安全区跟着错误缩放或被内容覆盖。

推荐把标题栏安全区做成框架组件，而不是让每个页面自己拼：

```tsx
export function WindowDragRegion({ children }: { children?: React.ReactNode }) {
  return (
    <header className="drag relative h-12 shrink-0">
      <div className="no-drag flex h-full items-center pl-20 pr-3">
        {children}
      </div>
    </header>
  );
}
```

`pl-20` 是概念示例。实际项目会根据展开侧栏、折叠 rail、TopBar 与 pane tab bar 的组合分别安排交通灯空间。

### 3.3 原生菜单而不是 HTML 菜单

`apps/desktop/src/main/lib/menu.ts` 使用 Electron `Menu.buildFromTemplate` 构建真正的系统菜单：

- macOS app menu：About、Settings、Services、Hide、Quit。
- File/Edit/View/Window/Help 菜单。
- `undo`、`redo`、`cut`、`copy`、`paste`、`selectAll` 等系统 role。
- Window 菜单使用 `windowMenu` role，自动列出多窗口。
- 使用 `CmdOrCtrl`、macOS 专属 `Cmd+Shift+N` 等 accelerator。
- 菜单动作通过事件或 tRPC 通知 renderer 导航，而不是让主进程持有 React 状态。

这部分对“原生感”很重要。只在页面里实现一个汉堡菜单，会失去 macOS 用户期望的菜单栏、系统快捷键和窗口切换能力。

### 3.4 系统能力仍由主进程提供

当前项目还在主进程处理：

- 系统通知和通知点击回到对应页面。
- Dock 图标与 badge。
- `dialog.showOpenDialog` 文件/目录选择。
- `shell.openExternal` 和 Finder 打开路径。
- 自定义 URL scheme 深链。
- Apple Events、本地网络、麦克风权限说明。
- 自动更新、签名、hardened runtime 和 notarization。
- 系统字体协议；例如通过自定义协议加载 macOS 自带的 SF Mono，而不是把字体文件打包进应用。

原则是：**UI 意图在 renderer，系统副作用在 main，preload 只提供窄而明确的桥。**

## 4. Renderer UI 技术栈与依赖

以下版本来自当前 `apps/desktop/package.json` 和 `packages/ui/package.json`。

### 4.1 必需的框架依赖

| 用途 | 依赖 | 当前版本 |
| --- | --- | --- |
| 桌面运行时 | `electron` | 41.10.3 |
| Electron 构建 | `electron-vite` | 4.0.1 |
| 打包、签名、发布 | `electron-builder` | 26.8.1 |
| UI runtime | `react`、`react-dom` | 19.2.3 |
| 语言与构建 | `typescript`、`vite` | 6.0.3、7.3.5 |
| React 编译 | `@vitejs/plugin-react` | 5.2.0 |
| 样式 | `tailwindcss`、`@tailwindcss/vite` | 4.2.2、4.2.2 |
| 动画 utilities | `tw-animate-css` | 1.4.0 |
| class 合并 | `clsx`、`tailwind-merge` | 2.1.1、3.5.0 |
| 组件变体 | `class-variance-authority` | 0.7.1 |
| 图标 | `lucide-react`、`react-icons` | 0.563.0、5.6.0 |

### 4.2 组件系统

`packages/ui` 是一个 shadcn/ui 风格的源码组件包，不是运行时“黑盒组件库”。组件实现主要建立在 Radix primitives 上：

- Dialog / AlertDialog / Sheet
- DropdownMenu / ContextMenu / Menubar
- Popover / HoverCard / Tooltip
- Select / Checkbox / Radio / Switch / Slider
- Tabs / Accordion / Collapsible
- ScrollArea / Separator / Progress / Avatar
- `@radix-ui/react-slot` 用于 `asChild` 组合
- `cmdk` 1.1.1 用于命令面板
- `sonner` 2.0.7 用于 toast
- `vaul` 1.1.2 用于 drawer
- `react-hook-form` 7.72.0 + `@hookform/resolvers` 5.2.2 + `zod` 4.4.3 用于表单

项目通过 `@superset/ui/button`、`@superset/ui/dialog` 这种子路径导出组件。基础组件使用 Tailwind utility、CVA 变体和 `cn(clsx + tailwind-merge)` 组合 class。

### 4.3 路由、服务端状态与本地状态

| 用途 | 依赖 | 当前版本 | 框架中的位置 |
| --- | --- | --- | --- |
| 文件路由 | `@tanstack/react-router` | 1.170.16 | 页面导航、route layout、错误页 |
| 异步数据 | `@tanstack/react-query` | 5.101.4 | 请求缓存、mutation、失效策略 |
| 类型安全 RPC | `@trpc/client`、`@trpc/react-query`、`@trpc/server` | 11.16.0 | renderer ↔ main / service |
| Electron RPC transport | `trpc-electron` | 0.1.2 | preload IPC 通道 |
| 本地 UI 状态 | `zustand` | 5.0.12 | 侧栏、主题、页签、偏好 |
| reactive collections | `@tanstack/db`、`@tanstack/react-db` | 0.6.17、0.1.95 | 本地集合与 live query |
| 缓存持久化 | `idb-keyval` | 6.2.2 | IndexedDB Query cache |

推荐的状态边界：

- URL 可表达的页面状态放 Router。
- 异步资源和主进程调用放 Query/tRPC。
- 短生命周期、跨组件 UI 状态放 Zustand。
- 大量 entity 数据放数据库或 IndexedDB，不要无限写入 `localStorage`。
- `localStorage` 只保留小而有界的单例偏好，并为废弃 key 提供清理策略。

### 4.4 桌面工作台与富内容依赖

这些依赖不是最小 UI 壳必需的，可按产品能力选择：

| 能力 | 依赖 | 当前版本 |
| --- | --- | --- |
| 拖拽排序 | `@dnd-kit/core`、`@dnd-kit/sortable` | 6.3.1、10.0.0 |
| 跨组件拖放 | `react-dnd`、`react-dnd-html5-backend` | 16.0.1 |
| 可调面板 | `react-resizable-panels` | 3.0.6 |
| mosaic 工作区 | `react-mosaic-component` | 6.1.1 |
| 动画 | `framer-motion` / `motion` | 12.38.0 |
| 终端 | `@xterm/xterm` 及 addons | 6.1 beta 系列 |
| 代码编辑器 | CodeMirror 6 packages | 6.x |
| 富文本编辑器 | Tiptap packages | 3.30.5 |
| 图表 | `recharts` | 2.15.4 |
| 国际化 | `@lingui/core`、`@lingui/react` | 6.6.0 |
| 错误监控 | `@sentry/electron` | 7.16.0 |

### 4.5 原生/系统集成依赖

| 能力 | 依赖 | 当前版本 |
| --- | --- | --- |
| PTY | `node-pty` | 1.2.0-beta.14 |
| 原生键盘映射 | `native-keymap` | 3.3.9 |
| 本地 SQLite | `better-sqlite3` | 12.11.1 |
| 自动更新 | `electron-updater` | 6.8.3 |
| 日志 | `electron-log` | 5.4.3 |

如果自己的 App 没有终端、代码编辑器、内嵌浏览器或本地数据库，不要照搬这些重量级依赖。

## 5. 设计系统是怎么组织的

### 5.1 CSS 变量是设计令牌的单一接口

全局样式把语义颜色定义为 CSS variables，再映射给 Tailwind：

```css
:root {
  --background: #151110;
  --foreground: #eae8e6;
  --card: #201e1c;
  --muted: #2a2827;
  --muted-foreground: #a8a5a3;
  --border: #2a2827;
  --accent: #2a2827;
  --sidebar: #1a1716;
  --sidebar-foreground: #eae8e6;
  --radius: 0.625rem;
}
```

组件只能依赖 `bg-background`、`text-foreground`、`border-border` 这样的语义 token，不应直接依赖某个主题的 hex 值。这样主题切换时只更新变量，不重写组件。

建议为新 App 保留的最小 token：

```text
background / foreground
surface / surfaceForeground
popover / popoverForeground
primary / primaryForeground
secondary / secondaryForeground
muted / mutedForeground
accent / accentForeground
destructive / warning / success
border / input / ring
sidebar / sidebarForeground / sidebarAccent / sidebarBorder
radius
```

### 5.2 主题由 store 解析，再同步各渲染器

主题 store 的职责不只是切换 `.dark`：

1. 解析 `system`、light theme、dark theme 和自定义 theme。
2. 把 UI 色写入 `document.documentElement.style`。
3. 同步 `.dark` / `.light` class。
4. 生成终端主题。
5. 把必要的启动期颜色写入持久化存储，避免首帧闪烁。
6. 在 Windows/Linux 同步 Electron title-bar overlay 颜色；macOS 的交通灯不需要这一步。
7. 监听系统配色变化，在选择 `system` 时重新解析主题。

应把“主题定义”和“主题应用器”拆开。业务组件只消费 token，不直接操作 DOM 或 Electron。

### 5.3 UI 包只放跨页面组件

当前仓库的组件组织原则很适合抽成通用框架：

- 一个组件一个目录：`Component/Component.tsx + index.ts`。
- 只被一个父组件使用的组件放到父组件 `components/` 下。
- 被两个以上兄弟使用时，提升到它们最近的共同父级。
- 真正跨页面的 primitive 才进入 `packages/ui`。
- shadcn primitive 保持 `components/ui/button.tsx` 这种单文件 kebab-case，以兼容 CLI 更新。

## 6. 抽出的 UI 框架

下面是去掉 Superset 业务后的通用工作台框架。

### 6.1 框架由六层组成

```text
1. NativeShell
   窗口、菜单、Dock、通知、文件面板、权限、更新

2. SafeBridge
   preload contextBridge + typed RPC；renderer 不能直接碰 Node

3. AppKernel
   ErrorBoundary、i18n、Theme、Query、Router、Toast

4. DesignSystem
   tokens、primitives、icons、交互规范、可访问性

5. Workbench
   WindowChrome、Sidebar、TopBar、TabStrip、SplitPane、RightInspector

6. Features
   业务页面和 pane，通过 registry 注入 Workbench
```

最重要的依赖方向是：

```text
Features → Workbench → DesignSystem
             ↓
          AppKernel → SafeBridge → NativeShell
```

DesignSystem 不能反向依赖业务；SafeBridge 不能导出任意 `ipcRenderer.send(channel)` 给业务代码。

### 6.2 可复用目录骨架

```text
apps/desktop/
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── windows/createMainWindow.ts
│   │   ├── menu/createApplicationMenu.ts
│   │   └── native/
│   │       ├── dialogs.ts
│   │       ├── notifications.ts
│   │       └── updater.ts
│   ├── preload/
│   │   ├── index.ts
│   │   └── contract.ts
│   └── renderer/
│       ├── index.tsx
│       ├── app/AppKernel.tsx
│       ├── routes/
│       ├── features/
│       └── styles/globals.css
packages/
├── ui/
│   └── src/
│       ├── components/ui/
│       ├── components/WindowDragRegion/
│       ├── components/WindowControlsInset/
│       ├── tokens/
│       └── lib/cn.ts
├── workbench/
│   └── src/
│       ├── AppFrame/
│       ├── Sidebar/
│       ├── TopBar/
│       ├── TabStrip/
│       ├── SplitPane/
│       ├── RightInspector/
│       └── ResizablePanel/
└── platform-contract/
    └── src/index.ts
```

如果 pane 系统是产品核心，再单独增加 `packages/panes`。如果 App 只有普通列表 + detail 页面，不要一开始就引入 split tree。

### 6.3 AppFrame 的稳定插槽

通用工作台不应该知道具体业务，只定义插槽：

```ts
export interface AppFrameProps {
  sidebar: React.ReactNode;
  topBar?: React.ReactNode;
  content: React.ReactNode;
  rightSidebar?: React.ReactNode;
  overlays?: React.ReactNode;
  sidebarMode: "expanded" | "rail" | "closed";
}
```

布局结构：

```tsx
export function AppFrame(props: AppFrameProps) {
  const sidebarOutsideTopBar = props.sidebarMode === "expanded";

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {sidebarOutsideTopBar && props.sidebar}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {props.topBar}
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {!sidebarOutsideTopBar && props.sidebar}
          <main className="relative min-h-0 min-w-0 flex-1">
            {props.content}
          </main>
        </div>
      </div>

      {props.rightSidebar}
      {props.overlays}
    </div>
  );
}
```

这个结构保留了项目里最有价值的布局思想：

- 根节点固定为 viewport，不让 body 自己滚动。
- 每一级 flex 容器都显式使用 `min-w-0 min-h-0`，防止内容撑破工作区。
- 滚动属于具体 pane，而不是整个窗口。
- expanded sidebar 可以独立占据整高；collapsed rail 可以进入 TopBar 所在列。
- 右栏使用稳定 slot，避免业务 pane 直接改根布局。
- modal、toast、command palette 等全局浮层统一挂载。

### 6.4 Pane 模型

`packages/panes` 的核心不是 UI，而是一棵可序列化 split tree：

```ts
type LayoutNode =
  | { type: "pane"; paneId: string }
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      first: LayoutNode;
      second: LayoutNode;
      splitPercentage?: number;
    };

interface Tab<TData> {
  id: string;
  activePaneId: string | null;
  layout: LayoutNode;
  panes: Record<string, Pane<TData>>;
}
```

在新 App 中继续采用这个模型，可以自然支持：

- 一个 tab 中水平或垂直拆分多个 pane。
- pane 拆分、移动、关闭、替换和尺寸持久化。
- 将 pane 移到其他 tab 或新 tab。
- pane 类型 registry；框架不需要 import 每个业务 pane。
- 工作区布局序列化后恢复。

推荐 registry contract：

```ts
export interface PaneDefinition<TData> {
  kind: string;
  render(data: TData, context: PaneContext): React.ReactNode;
  getTitle(data: TData): string;
  getIcon?(data: TData): React.ReactNode;
  canClose?(data: TData): boolean | Promise<boolean>;
}

export type PaneRegistry<TData> = Record<string, PaneDefinition<TData>>;
```

这里应复用“模型与交互”，不要把 Superset 的 Terminal、PR、Agent 等业务 pane 一起抽走。

### 6.5 Provider 顺序

建议让 AppKernel 保持稳定，避免 feature 任意向根部叠 Provider：

```tsx
<EmergencyErrorBoundary>
  <I18nProvider>
    <ThemeProvider>
      <TypedRpcProvider>
        <QueryClientProvider>
          <RouterProvider />
          <Toaster />
          <GlobalDialogs />
        </QueryClientProvider>
      </TypedRpcProvider>
    </ThemeProvider>
  </I18nProvider>
</EmergencyErrorBoundary>
```

EmergencyErrorBoundary 必须尽量无依赖：即使鉴权、RPC、主题或路由初始化失败，也要能显示可拖动、可滚动、可重试的错误界面。

## 7. 最小 Electron 壳的实现模板

### 7.1 主窗口

```ts
import { BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";

export function createMainWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#181818" : "#f7f7f7",
    titleBarStyle: "hidden",
    frame: false,
    trafficLightPosition: { x: 16, y: 16 },
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  return window;
}
```

说明：当前 Superset 因内嵌浏览器能力开启了 `webviewTag`。新 App 默认不要开启；确有需求时再增加隔离、导航 allowlist 和 guest 权限策略。

### 7.2 preload contract

不要把完整 `ipcRenderer` 暴露给页面。按能力定义白名单 API：

```ts
export interface DesktopBridge {
  platform: NodeJS.Platform;
  selectDirectory(): Promise<string | null>;
  openExternal(url: string): Promise<boolean>;
  onMenuAction(listener: (action: MenuAction) => void): () => void;
}
```

```ts
import { contextBridge, ipcRenderer } from "electron";

const bridge: DesktopBridge = {
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke("dialog:select-directory"),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  onMenuAction: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, action: MenuAction) =>
      listener(action);
    ipcRenderer.on("menu:action", wrapped);
    return () => ipcRenderer.removeListener("menu:action", wrapped);
  },
};

contextBridge.exposeInMainWorld("desktop", bridge);
```

对于中大型 App，建议像当前项目一样使用 tRPC 把输入校验、类型推断和 React Query hooks 串起来；小型 App 使用手写 typed bridge 即可。

### 7.3 Renderer 全局 CSS

```css
html,
body,
#root {
  width: 100vw;
  height: 100vh;
  margin: 0;
  overflow: hidden;
}

html,
body {
  user-select: none;
  -webkit-font-smoothing: antialiased;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
}

input,
textarea,
[contenteditable="true"],
.selectable {
  user-select: text;
}

.drag { -webkit-app-region: drag; }
.no-drag { -webkit-app-region: no-drag; }
```

不要全局禁止文本选择后忘记给编辑器、日志、Markdown 和输入框恢复选择能力。

## 8. 哪些代码适合抽取，哪些不适合

### 8.1 可以抽成框架

- `packages/ui/src/components/ui/` 中通用 primitives。
- `packages/ui/src/lib/utils.ts` 的 `cn` 工具。
- CSS semantic tokens 和主题应用模式。
- Window drag region、traffic-light inset、TopBar、ResizablePanel。
- `packages/panes` 的 split-tree 模型、store 和 registry 思路。
- Renderer 的错误边界分层。
- main / preload / renderer 的 typed bridge 模式。
- 原生菜单和 renderer action 的事件边界。

### 8.2 应保留在业务层

- 登录、组织、计费和 feature flags。
- workspace、agent、task、PR 等实体模型。
- Terminal/File/Diff/Browser/Chat 各 pane 的实现。
- Superset 品牌颜色、图标和文案。
- PostHog、Sentry、更新服务端地址等产品基础设施。
- 面向当前数据库结构的 CollectionsProvider。

### 8.3 不建议机械复制的部分

当前桌面 App 已经是成熟产品，根 Provider 和 dashboard layout 承担了大量兼容逻辑。直接复制会把新项目带入以下负担：

- 多窗口、旧版/新版 workspace 共存逻辑。
- 大量本地持久化 schema 和迁移。
- 终端、浏览器、远程 host、云服务的生命周期。
- 产品专属的 telemetry、auth 和 subscription。

正确方法是先复制边界和 contract，再按自己的 feature 一项项接入。

## 9. 建议的最小依赖集

如果新 App 继续使用 Electron，第一阶段只需要：

```json
{
  "dependencies": {
    "@radix-ui/react-dialog": "1.1.15",
    "@radix-ui/react-dropdown-menu": "2.1.16",
    "@radix-ui/react-popover": "1.1.15",
    "@radix-ui/react-tooltip": "1.2.8",
    "@tanstack/react-query": "5.101.4",
    "@tanstack/react-router": "1.170.16",
    "class-variance-authority": "0.7.1",
    "clsx": "2.1.1",
    "lucide-react": "0.563.0",
    "react": "19.2.3",
    "react-dom": "19.2.3",
    "sonner": "2.0.7",
    "tailwind-merge": "3.5.0",
    "tw-animate-css": "1.4.0",
    "zod": "4.4.3",
    "zustand": "5.0.12"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.2.2",
    "@vitejs/plugin-react": "5.2.0",
    "electron": "41.10.3",
    "electron-builder": "26.8.1",
    "electron-vite": "4.0.1",
    "tailwindcss": "4.2.2",
    "typescript": "6.0.3",
    "vite": "7.3.5"
  }
}
```

这不是从当前 `package.json` 复制出来的完整集合，而是从中裁剪出的 UI 壳起点。版本应在新项目创建时统一锁定和测试，不要把不同时间的 Radix/shadcn 文件混装。

第二阶段按需求增加：

- 多 pane：先实现自有 split tree，或抽取 `packages/panes`。
- 类型安全 IPC：`@trpc/*` + `trpc-electron` + `superjson`。
- 表单：`react-hook-form` + resolvers。
- 排序拖拽：`@dnd-kit/*`。
- 国际化：Lingui。
- 终端、编辑器、富文本等最后加入。

## 10. 实施顺序

推荐按以下顺序实现自己的 App：

1. **NativeShell**：先做窗口、交通灯、拖拽区、菜单和安全 preload。
2. **Design tokens**：只实现 light/dark 两套语义色，保证首帧不闪烁。
3. **AppKernel**：错误边界、Router、Query、Toast。
4. **AppFrame**：Sidebar + TopBar + Content + Right slot。
5. **基础组件**：Button、Input、Dialog、Menu、Tooltip、ScrollArea。
6. **持久化偏好**：只保存 sidebar width、theme、最近页面等有界数据。
7. **Pane system**：确实需要多任务/分屏时再加入。
8. **业务 feature**：通过 route 和 pane registry 注入，不修改壳层。
9. **macOS 收尾**：菜单 role、键盘快捷键、Dock、通知、签名、公证、权限说明。
10. **故障体验**：测试 renderer 未挂载、RPC 不可用、离线、主题损坏和窗口恢复失败。

第一版完成标准：

- 窗口启动无白闪。
- 交通灯不遮挡任何交互元素。
- 所有可点击控件都不在 drag hit area 中。
- Cmd+C/V/Z、Cmd+,、Cmd+W 和 Window 菜单符合 macOS 预期。
- light/dark 切换后窗口背景、popover、terminal/editor（若有）一致。
- renderer 无 Node 全局对象，系统调用只通过白名单 bridge。
- 侧栏缩放不会造成主内容溢出。
- 根错误页不依赖业务 Provider，且窗口仍可拖动。

## 11. 如果要做真正的 SwiftUI/AppKit 原生 App

Electron 框架可以保留信息架构，但技术实现应按下表替换：

| 当前 Electron/React | 原生 macOS 对应 |
| --- | --- |
| `BrowserWindow` | SwiftUI `WindowGroup` + 必要时获取 `NSWindow` |
| hidden title bar + traffic lights | `NSWindow` full-size content view / transparent titlebar |
| CSS drag region | AppKit window drag area 或窗口背景拖动策略 |
| Electron `Menu` role | SwiftUI `Commands` / `CommandMenu` |
| React + Tailwind | SwiftUI View + modifier + 自定义 Design Tokens |
| CSS variables | Asset Catalog + Environment 中的 theme/token |
| Radix Dialog/Menu/Popover | SwiftUI `sheet`、`alert`、`Menu`、`popover` |
| TanStack Router | `NavigationStack` 或 enum 驱动的 app router |
| Zustand | Observation framework 的 `@Observable` model |
| React Query | service protocol + async/await + 显式 cache actor/model |
| tRPC preload bridge | Swift service protocols；不再需要 JS bridge |
| IndexedDB / localStorage | SwiftData、SQLite 或 `UserDefaults`（仅小偏好） |
| split-tree pane | 递归 `HSplitView` / `VSplitView` + 可序列化布局模型 |
| Sonner toast | 自定义 overlay / notification presenter |

真正原生版的最小系统依赖可以只用 Apple SDK：

```text
SwiftUI
AppKit
Observation
Foundation
UniformTypeIdentifiers
UserNotifications
OSLog
```

架构仍建议保持本文六层，只是删除 SafeBridge，把 NativeShell 与 SwiftUI AppKernel 直接连接：

```text
AppKit/SwiftUI NativeShell
        ↓
AppKernel（Router / Theme / Services / Error presentation）
        ↓
Workbench（Sidebar / Toolbar / Tabs / Split panes / Inspector）
        ↓
Features
```

不要逐像素把 Web 组件翻译成 SwiftUI。应该复用的是：语义 token、布局槽、pane 数据模型、命令模型和状态边界。

## 12. 关键风险与注意事项

1. **“原生观感”不等于“原生 UI”**：Electron 仍携带 Chromium，内存、包体积、文本输入和可访问性细节与 AppKit 不同。
2. **交通灯与页面缩放**：标题栏安全区必须被当成框架基础设施，不能散落在 feature 页面。
3. **拖拽区吞点击**：任何交互控件都必须显式 `no-drag`。
4. **首帧主题**：窗口背景色、HTML fallback token 和持久化主题必须一致。
5. **不要暴露通用 IPC**：bridge 应按能力授权并在 main 端用 schema 校验输入。
6. **不要滥用 localStorage**：它同步加载、容量小且生命周期长；实体集合放 SQLite/IndexedDB。
7. **不要过早引入 pane 系统**：它会显著增加焦点、快捷键、拖拽、恢复和关闭确认的复杂度。
8. **原生菜单与 renderer 快捷键要分工**：避免同一组合键被菜单 role 和页面同时消费。
9. **窗口异常页也属于窗口壳**：错误时仍要能拖动、关闭、复制错误和重试。
10. **系统权限需要打包配置**：开发环境可用并不代表签名、公证后的安装包可用。

## 13. 推荐阅读的仓库文件

按理解顺序阅读：

1. `apps/desktop/src/main/windows/main.ts`
2. `apps/desktop/src/main/lib/menu.ts`
3. `apps/desktop/src/preload/index.ts`
4. `apps/desktop/src/renderer/index.tsx`
5. `apps/desktop/src/renderer/globals.css`
6. `apps/desktop/src/renderer/routes/-layout.tsx`
7. `apps/desktop/src/renderer/routes/_authenticated/_dashboard/layout.tsx`
8. `apps/desktop/src/renderer/stores/theme/store.ts`
9. `packages/ui/src/components/ui/button.tsx`
10. `packages/ui/src/globals.css`
11. `packages/panes/src/types.ts`
12. `packages/panes/src/core/store/store.ts`
13. `apps/desktop/electron-builder.ts`

## 14. 最终抽象

如果只保留一句架构原则，可以记成：

> 用原生窗口承载一个受严格边界保护的 Web renderer；用语义化设计令牌和无网页滚动范式的工作台布局获得桌面感；用 typed bridge 把系统能力送进 UI；用 registry 把业务页面和 pane 插入框架，而不是让业务反过来控制窗口壳。

这套框架适合 IDE、数据库工具、AI 工作台、文件管理器、运维面板等高密度桌面应用。普通单窗口表单 App 则应删掉 pane、DND、collection persistence 等复杂层，只保留 NativeShell、SafeBridge、AppKernel、DesignSystem 和简化版 AppFrame。
