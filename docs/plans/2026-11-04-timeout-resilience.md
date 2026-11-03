# dsh-crew 长任务超时与结果交付 — 实施计划

- 格式：agent-execution-plan/v2
- 文档状态：ready
- 目标：长任务（30–90 分钟）在 Codex 侧不再因为等待预算耗尽而被放弃并取消；即使 MCP 侧超时，worker 的结论也能通过磁盘报告取回。
- 范围：仅 MCP 服务进程侧与 Codex 角色定义。**不改** LLM 重试配置（`maxRetries` 保持 100），不改 hub 进程内代码，不改 web UI。
- 工作目录：`/root/dsh-crew`
- 基线：`/root/dsh-crew` git HEAD `e102aa1`（feat(mcp): add dsh_worker_wait for blocking waits），工作树干净；已安装副本 `~/.codex/agents/ds-{pro,flash}.toml`。
- 目标环境：本机生产（Codex CLI 0.162.1 + DSH web hub `http://127.0.0.1:3080`）。
- 操作边界：允许修改上述仓库文件与 `~/.codex/agents/`；允许在无运行中 job 时原子替换；不允许重启 DSH web 进程。

## 关键事实（已核实）

- `src/server.mjs:538` `dsh_worker_wait` 的 `timeout_seconds` 上限为 900，默认 600——这是单次等待的真实天花板。
- `~/.codex/agents/ds-pro.toml:16`（ds-flash 同）写死 `timeout_seconds=600`，且规定 `timed_out: true` 后“报告且不再等待”。
- 2026-11-03 事故：10:02:39 派发 → 10:12:39 仍运行 → 10:14:32 等 600s → 10:24:32 `timed_out` → 10:26:13 dispatcher 主动 `cancel`。worker 的 13 条 assistant 消息只有 reasoning 与 tool-call，0 条 text，即取消时尚未产出结论。
- `src/hub/index.mjs:775 cancel()` 会 `dispose()` 运行时并锁定 `cancelled`；`planTurn()` 对 `cancelled`/`expired` 直接抛错，无法 resume；`job.result` 仅在 turn 结束时写入，取消后恒为 `null`。
- hub `view()` 不返回 `liveness`，但返回 `lastEventAt`——停滞信号可在客户端由 `lastEventAt` 推出，无需改 hub。
- 每个 Codex 会话独立拉起 `node /root/dsh-crew/src/server.mjs`（当前 3 个进程，启动于 20:26 / 23:55 / 23:56）。因此**替换 MCP 代码不需要重启 DSH**，新会话自然加载新代码。

## 契约

### C01 — 等待语义
- 状态：已确定
- 约束：`timed_out: true` 表示“尚未结束”，不表示失败。单次等待上限 1800s；角色总等待预算 1800×3 = 90 分钟（不含 `dsh_run_worker` 的首段 1800s）。放弃等待仅在 failed/cancelled/expired、连续两次 `stalled`、或预算耗尽三种情况发生。
- 来源：本计划；`docs/install-codex.md` 现有“等待而不轮询”规则。

### C02 — 结果落盘
- 状态：已确定
- 约束：`dsh_run_worker` 在 hub 模式下为每次派发生成 `report_path = <workspace_root>/.crew/<token>/REPORT.md`，并把“收尾写报告”的要求作为一行前置指令附在任务文本前；工具返回值新增 `report_path`。该文件是超时后唯一的确定性交付通道。
- 来源：本计划。

### C03 — 取消禁令
- 状态：已确定
- 约束：角色定义禁止调用 `dsh_worker_cancel`；工具本身保留。
- 来源：本计划；`src/hub/index.mjs:775` 的不可恢复性。

## 工作安排

### T01 — 提高单次等待上限并注入报告路径
- 状态：done
- 依赖：无
- 改动：`src/server.mjs`：`dsh_worker_wait` 的 `timeout_seconds` 改为 `min 1 / max 1800 / default 1800`；新增停滞判定常量与 `quiet_seconds` 输出；`dsh_run_worker` 在 hub 模式生成 report token、前置注入报告指令、返回值新增 `report_path`。
- 产物：修改后的 `src/server.mjs`。
- 契约：C02
- 验收：V01,V03

### T02 — 客户端停滞早退（非破坏性）
- 状态：done
- 依赖：无
- 改动：`src/hub-client.mjs`：`waitFor` 基于 `lastEventAt` 计算 `quietSeconds`；当 `quietSeconds >= 1200` 且状态仍为 running 时，返回 `timed_out: true, stalled: true, quiet_seconds`，不取消、不改 job 状态；`waitPayload` 透传这三个字段。
- 产物：修改后的 `src/hub-client.mjs`。
- 契约：C01,C02
- 验收：V01

### T03 — 重写角色等待规则
- 状态：done
- 依赖：T01,T02
- 改动：`codex/agents/ds-pro.toml`、`codex/agents/ds-flash.toml` 第 4 条改为：`dsh_worker_wait` 单次 1800、exec 头 `1830000`、最多 3 段；`timed_out` 继续等；`stalled` 时用 `dsh_worker_message` 发一次“汇报进展并写 REPORT.md”后再等一段；新增第 7 条禁止 `dsh_worker_cancel`；报告前先读 `report_path`。同步安装到 `~/.codex/agents/`。
- 产物：两个 toml（仓库版与已安装版一致）。
- 契约：C01,C03
- 验收：V02,V03

### T04 — 文档同步
- 状态：done
- 依赖：T01,T03
- 改动：`docs/mcp-tools.md`（wait 上限与新增字段）、`docs/install-codex.md`（等待公式 1800→1830000、分段预算、禁止取消、报告路径）。
- 产物：两份文档。
- 契约：C01,C03
- 验收：V03

### T05 — 回归测试
- 状态：done
- 依赖：T01,T02,T03,T04
- 改动：无代码改动；运行现有测试并在必要时新增 `tests/wait-budget.test.mjs` 覆盖 1800 上限与 `quietSeconds` 计算。
- 产物：测试输出。
- 契约：C01,C02
- 验收：V01

### T06 — 择机部署并观察
- 状态：done
- 依赖：T05
- 改动：把 T01/T02 文件写入 `/root/dsh-crew/src/`（即部署路径，两处 profile 均为指向该目录的符号链接），T03 的 toml 用 `mv` 原子写入 `~/.codex/agents/`。不重启 DSH。
- 产物：生产路径上的新代码 + 部署记录：2026-11-04 00:15 CST，部署前 running job 数 = 0（`hub-1-mw0irgjx` cancelled、`hub-2-mw0vj9if` idle）；sha256 前 16 位 `src/server.mjs`=0fe8766aab3216ad、`src/hub-client.mjs`=9441dc085ba52d1b、`ds-pro.toml`=1a377220b82d74fa、`ds-flash.toml`=f543179b7d01a622；git 提交 `7e33ffb`。
- 契约：C01,C02,C03
- 验收：V02,V04

## 共享验收

### V01 — 单元与静态检查
- 方法：在 `/root/dsh-crew` 运行 `node --test tests/*.test.mjs`；对改动文件运行 `node --check`。
- 通过标准：全部测试通过，无语法错误；新增断言覆盖 1800 上限与停滞字段。
- 结果：PASS
- 证据：2026-11-04 00:14 CST 在 `/root/dsh-crew` 执行 `node --test tests/*.test.mjs`：121 tests / 121 pass / 0 fail（新增 `tests/report-path.test.mjs` 2 项、`tests/hub-client-wait.test.mjs` 3 项停滞用例）；`node --check src/server.mjs src/hub-client.mjs` 均通过。

### V02 — 角色文件一致性
- 方法：`diff` 仓库版与 `~/.codex/agents/` 安装版；`grep` 确认 1800/1830000/禁止 cancel 三项存在。
- 通过标准：两份文件内容一致（除路径行），三项规则均存在。
- 结果：PASS
- 证据：2026-11-04 00:15:51 CST，`diff <(sed 路径替换 codex/agents/ds-{pro,flash}.toml) ~/.codex/agents/ds-{pro,flash}.toml` 两份均 identical；`grep` 三项规则每份各命中 3 行。

### V03 — 配置字段核对
- 方法：读取改动后的 `src/server.mjs` 工具 schema 与文档表格。
- 通过标准：schema `max(1800)`、`report_path`、`quiet_seconds` 与文档描述一致。
- 结果：PASS
- 证据：`src/server.mjs` 的 `dsh_worker_wait` schema 为 `min(1).max(1800).default(1800)`；`npm run build:mcp` 重建后 `lib/server.mjs:15640` 同步为 1800；`docs/mcp-tools.md` 与 `docs/install-codex.md`、`codex/prompts/dsh-playbook.md` 均已改写同一套语义。

### V04 — 部署后冒烟
- 方法：新开一个 `node /root/dsh-crew/src/server.mjs` 进程做 `initialize` + `tools/list`（stdin JSON-RPC），或调用 `dsh_worker_probe`；确认 `dsh_worker_wait` 描述出现 1800。
- 通过标准：新进程返回新 schema；hub `/config` 与 `/jobs` 不受影响。
- 结果：PASS
- 证据：2026-11-04 00:15 CST，新进程 stdio 冒烟返回 6 个 core 工具，`dsh_worker_wait.timeout_seconds` default=1800 maximum=1800；同一时刻 `GET /_dsh/dsh-crew/config` 仍返回 `ok:true`，`/jobs` 为 1 cancelled + 1 idle，无 running。

## 不做什么

- 不改 `maxRetries`（用户明确要求保留 100）。
- 不改 hub 进程内代码，因此不需要重启 DSH web，也不会中断当前会话。
- 不移除 `dsh_worker_cancel` 工具，只在角色层禁用它。
