# DSH 0.2.1-rc.4 兼容性核对（T02）

- 核对日期：2026-10-31（Asia/Shanghai）
- 运行时：`/usr/lib/node_modules/@deepseek-ai/dsh`
- 运行时版本：`0.2.1-rc.4`
- 目标包：`@zseven-w/dsh-crew@0.1.0-rc.14`
- 核对方式：只读已安装包的 `lib/types/*.d.ts`，不 import DSH、不启动 agent、不触碰 live session。

## 结论

DSH `0.2.1-rc.4` 的已发布类型声明中，dsh-crew 多轮 worker 所需的 **7 项核心能力全部存在**；另有 2 项可选能力也存在。实现侧应当按能力探测降级，**不要按版本号分支**。

## 探测命令与结果

探测脚本：

- `/root/dsh-crew/scripts/probe-runtime.mjs`
- 只读取 `dsh-agent`、`dsh-agent-loop`、`dsh-session`、`dsh-user-questions` 的类型声明；
- 另外只读 `dsh-agent-preset-registry`、`dsh-workspace` 两项补充能力；
- 输出确定性 JSON（文件列表排序、无时间戳），核心检查全部命中时 exit 0。

```bash
cd /root/dsh-crew
node scripts/probe-runtime.mjs > /tmp/probe-final1.json
echo $?
node scripts/probe-runtime.mjs > /tmp/probe-final2.json
echo $?
diff -u /tmp/probe-final1.json /tmp/probe-final2.json && echo IDENTICAL
```

实测输出（两次运行）：

```text
0
0
IDENTICAL
```

两次输出均为 7165 字节，SHA-256 相同：

```text
56a56efa9524267e7901829209ee05e37ab55d9183914a34f18ce4429d196e9f  /tmp/probe-final1.json
56a56efa9524267e7901829209ee05e37ab55d9183914a34f18ce4429d196e9f  /tmp/probe-final2.json
```

JSON 摘要：

```json
{
  "runtime": {
    "version": "0.2.1-rc.4"
  },
  "summary": {
    "core": 7,
    "coreOk": 7,
    "supplementary": 2,
    "supplementaryOk": 2,
    "missing": []
  }
}
```

## 核心能力矩阵

| 检查 id | 类型声明 | 证据位置 | 结果 |
| --- | --- | --- | --- |
| `agents.create` | `create(options: CreateAgentOptions): Promise<AgentHandle>;` | `dsh-agent/lib/types/index.d.ts:278` | 存在 |
| `agents.resume` | `resume(options: ResumeAgentOptions): Promise<AgentHandle>;` | `dsh-agent/lib/types/index.d.ts:286` | 存在 |
| `agent.followup` | `followup(input: UserMessage): void;` | `dsh-agent-loop/lib/types/agent.d.ts:41` | 存在 |
| `agent.steer` | `steer(input: UserMessage): void;` | `dsh-agent-loop/lib/types/agent.d.ts:42` | 存在 |
| `agent.whenIdle` | `whenIdle(): Promise<void>;` | `dsh-agent-loop/lib/types/agent.d.ts:55` | 存在 |
| `sessions.flush` | `flush(session: Session): Promise<boolean>;` | `dsh-session/lib/types/index.d.ts:483` | 存在 |
| `userQuestions.request` | `'user-questions/request'(this: Scoped<Agent>, ...): Promise<AskUserQuestionAnswer>;` | `dsh-user-questions/lib/types/types.d.ts:145` | 存在（`@mode waterfall`） |
| `agentPresets`（补充） | `agentPresets: AgentPresetRegistry;` | `dsh-agent-preset-registry/lib/types/index.d.ts:18` | 存在 |
| `workspaceRegistry`（补充） | `workspaceRegistry: WorkspaceRegistry;` | `dsh-workspace/lib/types/index.d.ts:82` | 存在 |

声明原文核对命令：

```bash
DSH=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
sed -n '278p;286p' "$DSH/dsh-agent/lib/types/index.d.ts"
sed -n '41p;42p;55p' "$DSH/dsh-agent-loop/lib/types/agent.d.ts"
sed -n '483p' "$DSH/dsh-session/lib/types/index.d.ts"
sed -n '145p' "$DSH/dsh-user-questions/lib/types/types.d.ts"
sed -n '18p' "$DSH/dsh-agent-preset-registry/lib/types/index.d.ts"
sed -n '82p' "$DSH/dsh-workspace/lib/types/index.d.ts"
```

输出：

```text
    create(options: CreateAgentOptions): Promise<AgentHandle>;
    resume(options: ResumeAgentOptions): Promise<AgentHandle>;
    followup(input: UserMessage): void;
    steer(input: UserMessage): void;
    whenIdle(): Promise<void>;
    flush(session: Session): Promise<boolean>;
        'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>;
        agentPresets: AgentPresetRegistry;
        workspaceRegistry: WorkspaceRegistry;
```

## 这些能力在 dsh-crew 里的用途

- `ctx.agents.create` / `ctx.agents.resume`：创建 worker；多轮会话恢复时用 `resume` 接回原 agent。
- `handle.agent.followup` / `handle.agent.steer`：空闲时追加任务；运行中注入纠偏消息。
- `handle.agent.whenIdle`：等待一轮结束，现有单轮路径已在用。
- `ctx.sessions.flush`：每轮结束显式做持久化检查点。
- `'user-questions/request'`：worker 无人值守时，现有 `src/worker-question.mjs` 通过 `agentCtx.on(...)` 抢答/转交问题；这条 waterfall 事件是兼容点。
- `ctx.get('agentPresets')`：按 flash/pro 预设解析模型与挂载配置；当前 `src/hub/index.mjs` 已使用。
- `ctx.get('workspaceRegistry')`：把 worker session 挂到 cwd 对应 workspace；当前 `src/hub/index.mjs` 已使用。

## 建议的能力探测（C05）

实现时按下面的顺序探测，缺哪项就降级哪项；**不要读 DSH 版本号做 if/else**：

| 探测 | 缺失时的降级 |
| --- | --- |
| `typeof ctx.agents?.resume === 'function'` | 多轮 resume 不可用：退化为 `create` + `followup` 的单轮/重建路径，或明确拒绝多轮请求 |
| `typeof handle.agent?.steer === 'function'` | 运行中不能 steer：把纠偏消息排队到下一次 `followup` |
| `typeof ctx.sessions?.flush === 'function'` | 跳过显式 flush，依赖 session 自身的持久化 |
| `ctx.get('agentPresets') !== undefined` | 不解析 preset，直接使用配置里的 provider/model |
| `ctx.get('workspaceRegistry') !== undefined` | 跳过 workspace 挂载，不影响 worker 执行 |

## 限制与说明

- 这是**静态声明核对**，不是运行时行为测试：脚本没有 import DSH、没有创建 agent、没有发消息。它证明类型声明存在，不能单独证明某个调用在特定 host 组合下一定成功。
- `userQuestions.request` 检查的是 waterfall 事件声明；现有代码用的是 `agentCtx.on('user-questions/request', ...)`，不是直接调用 `ctx.userQuestions.ask()`。
- 未修改 `/usr/lib/node_modules` 下任何文件；探测只读。
- 基线测试见 `docs/baseline-test.log`（46 pass / 0 fail）。T02 完成后的最终测试：`cd /root/dsh-crew && node --test tests/*.test.mjs` -> `# tests 46` / `# pass 46` / `# fail 0`，exit 0。
