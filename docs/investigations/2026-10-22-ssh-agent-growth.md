# dev3-cuda SSH agent 累积排查

排查日期：2026-10-22（Asia/Shanghai）。代码基线：`28b909b`。
范围：SuperThread 的 SSH、终端后台探测、Session 恢复、隧道重连及相关历史提交。
本次仅排查并记录，不修改运行逻辑或远端配置，不连接 dev3-cuda，不启动真实 ssh-agent。

## 结论和证据边界

仓库历史存在能够直接解释大量 ssh-agent 累积的链路：

```text
每个远程 Session 的定时器
  → 新启动一个本地 ssh 客户端，执行远程命令
  → 显式启动用户 shell -lic
  → 重新执行 .zshrc
  → 如果 .zshrc 无条件启动独立 ssh-agent，agent 持续累积
```

这不需要递归或异常快速的重试。一个每秒执行一次的探测，约 38.9 小时可执行 140,000 次；
一个每 1.5 秒执行一次的探测，约 58.3 小时可执行 140,000 次。多个 Session 会叠加。
这些是命令快速完成、持续运行且每次初始化恰好创建一个 agent 的量级估算，不是服务器实测。

当前普通 shell / Codex 分支已避免重复显式加载交互式 shell，但后台高频 SSH 命令执行仍存在。
旧 tmux 分支仍有重复初始化代码，不过当前正常启动会移除内嵌 tmux Session，该分支不是正常新建流程。
不能仅凭源码证明 dev3-cuda 的全部 140,000 个进程都来自本应用，也不能把旧分支当作当前必然发生的行为。
需要核对事故时运行的应用版本、进程创建时间、客户端来源及远端启动配置。

## 历史问题：高频探测反复执行 shell 初始化

- `ff3b258` 引入每个普通终端每 1 秒的活动探测，旧远端实现通过交互式登录 shell 执行。
- `eef394d` 引入每个缺少 conversation ID 的 Codex 每 1.5 秒读取 session index；旧远端实现每次都调用交互式登录 shell。
- `0ec57d5`（2026-10-08 19:31 +08:00）修复普通 shell 活动探测：直接查询 `ps`，不再每秒显式启动交互式登录 shell。
- `a1d4018`（2026-10-08 19:48 +08:00）修复 Codex 探测：只在首次解析一次 shell 配置中的 CODEX_HOME，随后直接读 index；增加防重叠保护，解析失败也不重复初始化。
- `c84f4c0` 将内嵌 tmux 改为 Workspace tmux + iTerm。当前 `src/main/persistence/json-store.ts:49–66` 在每次 load 时移除 `kind=tmux` 的 Session，并迁移 workspace 的 tmux 名称。创建 Session 的 IPC 只接受 shell / codex。

剩余旧代码：`src/main/runtime/terminal-runtime.ts:275–293` 对 tmux 活动查询仍调用
`interactiveLoginShellCommand`。如果直接调用 runtime 创建旧式 tmux Session，仍会每秒执行初始化。
正常加载和新建流程不可达；建议删除这套废弃 runtime 分支，避免以后恢复调用时重新引入事故。

## 当前风险 1：每个远程 shell 每秒新建 SSH 客户端

位置：`src/main/runtime/terminal-runtime.ts:244–248,268–304,344–350`。

每个存活的远程普通终端创建独立的 1 秒定时器，查询远端 shell 的进程组。
即使终端停在 prompt、未选中、WorkThread 已归档或 macOS 窗口关闭，主进程及探测仍可存活。
窗口关闭保留 PTY 是既定功能，但探测没有另行降低频率。

- 快速完成时，每个 Session 每日约 86,400 次 SSH 命令调用；10 个约 864,000 次。
- `live.probing` 防止同一个 Session 的活动查询重叠；没有设备级合并、限流或共享探测通道。
- 失败被捕获，下一次 tick 继续；没有失败退避、熔断或可见错误计数。
- 未由应用配置 SSH 连接复用；实际是否每次重新 TCP 握手、认证取决于用户的 SSH ControlMaster 等配置。SSH 客户端调用数不能直接视作独立网络连接数。
- 当前命令不主动加载 `.zshrc`。若远端 `.zshenv`、服务端包装器或其他启动逻辑再次 source `.zshrc`，风险仍可能被触发，需要远端配置证据。

判断：当前可达的资源消耗与持续失败重试缺陷；单独不足以证明每次都创建 ssh-agent。

## 当前风险 2：Codex conversation 查询没有停止期限

位置：`src/main/runtime/terminal-runtime.ts:238–242,307–341`。

没有 conversation ID 时每 1.5 秒查询一次。若 index 不存在、格式不兼容、路径解析错误或查询一直失败，
只要 PTY 仍存活，就会持续尝试；只有成功记录 ID 或 PTY 退出才清除定时器。

- 快速完成时，每个 Session 每日约 57,600 次 SSH 命令调用，首次成功路径另含一次环境解析。
- 当前已有单 Session 防重叠与一次性环境解析保护，不应再描述为每 tick 都执行 `.zshrc`。
- 环境解析失败后预先设置的默认路径会被后续查询使用；若自定义 CODEX_HOME 无法解析且默认位置没有 index，可能形成长期无效查询。
- 查询失败静默处理，没有退避、截止时间或设备级配额。

判断：当前可达的无限期后台查询缺陷；旧版本曾直接反复加载 `.zshrc`，当前版本通常不再如此。

## 超时和可观测性方面的补强点

`terminal-runtime.ts:156–170` 的探测在 1.5 秒后仅向直接子进程发送一次 SIGTERM；
`command-runner.ts:9–23` 的普通命令有相同的软超时模式。
Promise 仍等待 `close`，没有强制结束期限、SIGKILL 升级、输出大小上限或取消接口。

- 超时短于探测 SSH 的 `ConnectTimeout=2`，慢连接可能尚未完成便被本地终止。
- 杀掉 SSH 客户端不等于清理远端初始化脚本启动的独立 daemon。
- 异常子进程不退出或子进程后代保持管道时，可能长期悬挂；这需要专门测试，不能据此声称正常 ssh 一定忽略 SIGTERM。
- 失败路径没有保留设备、探测类型、频率和连续失败次数，妨碍事故归因。

这部分是代码层面的防护缺口，本次没有复现真实进程泄漏。

## 已检查且没有发现同类无限建 shell 路径的部分

- `SshTunnelSupervisor` 使用 `ssh -N -T`，不执行远程命令；失败重试为 1、2、4、8、16、30 秒并封顶 30 秒，已有 generation 防旧事件、重复 timer 保护及移除/关闭清理。不能把它直接当作重复执行 `.zshrc` 的来源。没有实测自定义服务端 hook。
- Codex 异常退出自动恢复受到 `autoRestoredCodexSessionIds` 限制：同一应用进程内每个 Session 自动恢复至多一次；唤醒事件另可尝试恢复失败 Session，没有发现紧密递归重连。
- Renderer attach 只附着现有 PTY 并取回缓冲；切换页面或刷新 snapshot 不直接创建 SSH。新建 Session 有进行中请求去重。
- 设备 ping 由新增设备或用户刷新触发，没有发现定时自动 ping 循环。Git 和目录操作按请求执行，不是每秒后台探测源。

这里的“没有发现”仅限所检查路径，不代表完整安全审计。

## 隔离验证

通过注入 `TerminalRuntime` 的 `runProbe` 拦截 SSH，不访问网络；把生成的远程命令放在本机
隔离的 zsh 环境运行。ZDOTDIR 指向临时目录，`.zshrc` 仅向计数文件追加一行，tmux 使用无副作用的替身。
每个场景手动触发 5 次探测，验证命令构造和初始化次数，不是 5 秒计时负载测试。

| 场景 | 探测次数 | 拦截的 SSH 调用 | `.zshrc` 执行次数 |
| --- | ---: | ---: | ---: |
| 当前普通 shell | 5 | 5 | 0 |
| 旧 tmux runtime 分支 | 5 | 5 | 5 |
| 旧 tmux，初始化后模拟查询失败 | 5 | 5 | 5 |
| 当前 Codex，index 始终不存在 | 5 | 6 | 1 |
| 当前 Codex，初始化后模拟查询失败 | 5 | 5 | 1 |

复现脚本本次保存在 `/tmp/superthread-ssh-audit/repro.ts`，属于临时诊断材料。
它没有创建实际 PTY / tmux / ssh-agent；本次未做真实远程终端、打包应用或服务器验证。

现有 148 项测试通过：`node --import tsx --test tests/*.test.ts`。
`npm test` 原命令因 sandbox 禁止 tsx CLI 的本地 IPC socket（EPERM）无法启动，故用同一 tsx loader 直接运行 Node 测试入口。
`npm run build` 通过。现有测试验证了普通 shell 不显式加载交互式 shell，以及 Codex 一次解析/防重叠，
没有约束一天内 SSH 总调用量、失败退避或遗留 tmux runtime 初始化行为。

## dev3-cuda 归因所需证据

本机可读的默认持久化快照仅有本地 Device，无远程 Device 或 Session；不能用它还原此前 dev3-cuda 的运行状态。
本次 sandbox 也禁止读取本机进程表，因此没有确认当前运行的应用 bundle 或客户端 PID。
未读取远端配置或进程表；未认定现有代码版本就是事故时部署版本。

建议从已有管理连接采集，避免先开启新的高频探测：

1. 先确认“14 万”是活进程、僵尸进程还是残留 socket / 目录数。用 `ps -eo user,pid,ppid,lstart,stat,comm` 筛选 ssh-agent，并按用户、状态和创建时间聚合。父进程已退出的 agent 可能重挂至 PID 1，PPID=1 不能独立证明来源。
2. 对齐 sshd 的登录/断开时间、来源 IP、用户，与 agent 的创建时间分布，区分周期性 SuperThread 探测和其他客户端。命令执行 session 和 TCP 连接可能因复用而不同。
3. 核对事故客户端实际安装/启动的 bundle 与上述修复提交，尤其是否仍运行 2026-10-08 修复之前的构建；仓库 HEAD 更新不代表在运行的进程已更新。
4. 只检查启动文件中相关语句：`.zshrc` 的 agent 启动/复用逻辑，`.zshenv`、`.zprofile`、系统启动文件及 SSH 包装器是否加载它。不要采集密钥内容、完整环境或其他不相关配置。
5. 在停止发起探测的客户端后比较短时间内 agent 数量增长斜率，保留时间与客户端状态，才能补齐因果证据。仅关闭 macOS 窗口不能停止本应用后台 runtime。

## 修复优先次序建议

1. 优先消除每个 tick 新建远程命令 session：按 Device 共享持久的非交互探测通道，在远端同一个进程中采样；或利用现有终端的事件上报。单加 ControlMaster 只能减少握手，不能避免每次远程 shell 初始化。
2. 加设备级并发/请求配额、连续失败指数退避与抖动、取消和硬超时。可见性变化只能调整探测频率，不能破坏关闭窗口后 PTY 继续工作的约定。
3. Codex 查询设置明确的时间/尝试预算；超出后停止后台查询并记录可见诊断，恢复策略单独定义，不能无限静默读取默认路径。
4. 删除不再被产品使用的内嵌 tmux runtime 分支，保留必要的快照迁移。
5. 远端 agent 采用单用户受管理实例或经过活性检查与互斥的共享实例；`.zshrc` 不应每次无条件启动 daemon。仅判断 SSH_AGENT_PID 是否为空不足以实现跨登录复用。先停止增长源并确认进程归属，再制定清理方案。

这些是后续实现建议，不是本次已修复的行为。

## 外部语义依据

- [zsh Startup/Shutdown Files](https://zsh.sourceforge.io/Doc/Release/Files.html)：`.zshrc` 属于交互式 shell 初始化；普通非交互 SSH 命令不必然执行它，`.zshenv` 的加载规则不同。
- [zsh Invocation](https://zsh.sourceforge.io/Doc/Release/Invocation.html)：`-i` 强制交互，即使使用 `-c` 执行命令。
- [OpenSSH ssh(1)](https://man.openbsd.org/ssh.1)：`-N` 不执行远程命令；连接复用与远程命令执行 session 是不同概念。
- [OpenSSH ssh-agent(1)](https://man.openbsd.org/ssh-agent.1)：以 command 子进程模式启动的 agent 有随 command 退出的生命周期；不能假定 shell 中 eval 启动的独立实例随 SSH 断开自动结束。
