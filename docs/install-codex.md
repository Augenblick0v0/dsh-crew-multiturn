# Codex 侧安装与验证（T08）

- 安装/验证日期：2026-10-31（Asia/Shanghai）
- Codex CLI：`codex-cli 0.162.1`（`/usr/bin/codex` → `/usr/lib/node_modules/@openai/codex/bin/codex.js`）
- 仓库：`/root/dsh-crew`，分支 `feat/multiturn`
- 接入决策：`DECISION: agent-role`（依据见 [codex-surface.md](./codex-surface.md)）
- 三条路径共用同一个 MCP server：`node /root/dsh-crew/src/server.mjs`（stdio；默认 `core` 5 个 `dsh_*` 工具，`full` 9 个）

本文件给出三条安装路径、每条的实测验证输出、回滚命令，以及 `~/.codex/config.toml` 的备份规则。
路径 A 是默认（DECISION）；路径 B/C 是备选，只在需要 marketplace 分发或无法投放 agent role 时使用。

## 什么时候才派发

**默认自己干，派发是例外。** role 装好不等于每次都要用：普通会话零派发是正常状态。

只有满足任一条才派 DSH worker：

1. 用户明确点名（ds-pro / ds-flash / 子代理 / worker）；
2. 客观重型：改 **≥3 个文件**、预计 **>10 分钟**、有 **≥2 个可并行的独立子任务**，或需要长时间构建/测试循环。

单文件、单命令、几行修改、一次性问答，**永不派发**；不确定就自己做，不问“要不要派”。派发时必须在回复里写一句触发条件，写不出就不该派。完整规则见 `~/.codex/AGENTS.md` 的「任务分派策略」。

## 安装包内容

```text
codex/
├── agents/
│   ├── ds-flash.toml          # agent role，thin dispatcher，多轮协议
│   └── ds-pro.toml
├── prompts/
│   ├── dsh-config.md
│   ├── dsh-playbook.md
│   └── dsh-status.md
└── plugin/                     # 备选路径 B 的本地 marketplace 根
    ├── .codex-plugin/plugin.json
    ├── .mcp.json
    └── .agents/plugins/marketplace.json
```

两个 role 的 `developer_instructions` 都写明了多轮协议：worker 返回 `needs_input` 时必须用
`dsh_worker_message`（同一个 jobId）回答并继续，**不得重派** `dsh_run_worker`；每轮结束必须汇报
`jobId` / `sessionId` / `turn`。role 内嵌的 `[mcp_servers.dsh-crew]` 段固定为：

```toml
[mcp_servers.dsh-crew]
command = "node"
args = ["/Users/fini/workspace/dsh-plugins/dsh-crew/src/server.mjs"]
default_tools_approval_mode = "approve"
tool_timeout_sec = 3600
```

`args` 里的上游路径是占位值：安装器（`src/install/install.mjs`）会在复制时用正则把它重写成**当前仓库**的
`src/server.mjs` 绝对路径（见路径 A 的验证输出）。手工复制 role 文件时要自己改这一行。

## 0. 先决条件与配置文件备份

任何会写 `~/.codex/config.toml` 的操作（路径 B、C，以及手工编辑）之前，先做带日期的备份并记录指纹：

```bash
cp -p /root/.codex/config.toml /root/.codex/config.toml.bak-20261030
sha256sum /root/.codex/config.toml /root/.codex/config.toml.bak-20261030
```

实测（本机）：

```text
9e139a3f17c8b45dd6ec0fb1747bccd1df448b9c933f1cc5c4033983f5d0d6cf  /root/.codex/config.toml
9e139a3f17c8b45dd6ec0fb1747bccd1df448b9c933f1cc5c4033983f5d0d6cf  /root/.codex/config.toml.bak-20261030
```

修改后必须核对 diff **只含新增段**：

```bash
diff -u /root/.codex/config.toml.bak-20261030 /root/.codex/config.toml
```

- 路径 A：不写 `config.toml`，实测 `diff` 为空（exit 0）。
- 路径 B：Codex 自动新增 `[marketplaces.dsh-crew-local]` 与 `[plugins."dsh-crew@dsh-crew-local"]` 两段。
- 路径 C：只新增一个 `[mcp_servers.dsh-crew]` 段。

备份文件保留 `600` 权限（`cp -p` 会保留源文件权限）；不要删除旧备份，回滚依赖它。

## 路径 A（DECISION，推荐）：agent-role

Codex 0.162.1 的 app-server 启动时枚举 `~/.codex/agents/*.toml`，不需要在 `config.toml` 里声明任何东西。
`[mcp_servers.dsh-crew]` 就写在 role 文件内，只在这个 role 被 spawn 时挂载。

### 安装

```bash
node /root/dsh-crew/src/install/cli.mjs codex
```

实测输出：

```text
• role: /root/.codex/agents/ds-flash.toml
• role: /root/.codex/agents/ds-pro.toml
• prompt: /root/.codex/prompts/dsh-config.md
• prompt: /root/.codex/prompts/dsh-playbook.md
• prompt: /root/.codex/prompts/dsh-status.md
done.
```

安装器同时做两件事：把 `codex/agents/*.toml` 复制到 `~/.codex/agents/`（已存在同名文件时先备份为
`<file>.dsh-crew-backup-<epoch-ms>`），并把 `args` 重写成 `/root/dsh-crew/src/server.mjs`；把
`codex/prompts/*.md` 复制到 `~/.codex/prompts/`。

项目级安装（只影响当前项目）：

```bash
cd /path/to/project && node /root/dsh-crew/src/install/cli.mjs codex --project
```

### 验证 1：安装后的 TOML 结构与 args 重写

```bash
python3 - <<'PY'
import tomllib
for f in ["/root/.codex/agents/ds-flash.toml", "/root/.codex/agents/ds-pro.toml"]:
    d = tomllib.load(open(f, "rb"))
    s = d["mcp_servers"]["dsh-crew"]
    print(f, "name=", d["name"], "args=", s["args"],
          "approve=", s.get("default_tools_approval_mode"),
          "timeout=", s.get("tool_timeout_sec"))
    assert "needs_input" in d["developer_instructions"]
    assert "dsh_worker_message" in d["developer_instructions"]
print("toml OK")
PY
```

实测输出：

```text
/root/.codex/agents/ds-flash.toml name= ds-flash args= ['/root/dsh-crew/src/server.mjs'] approve= approve timeout= 3600
/root/.codex/agents/ds-pro.toml name= ds-pro args= ['/root/dsh-crew/src/server.mjs'] approve= approve timeout= 3600
toml OK
```

### 验证 2：app-server role loader（正向加载证据）

```bash
cd /root && CODEX_HOME=/root/.codex codex app-server --listen off
```

实测输出（exit 1 是预期的“没有传输层”，关键是有没有 `agent role` 报错）：

```text
2026-10-30T19:10:21.740463Z ERROR codex_app_server: Codex is ignoring 3 unrecognized configuration settings. Check for typos or deprecated settings.
  user (/root/.codex/config.toml): `disable_response_storage` is ignored.
  user (/root/.codex/config.toml): `network_access` is ignored.
  user (/root/.codex/config.toml): `windows_wsl_setup_acknowledged` is ignored.
Error: no transport configured; use --listen or enable remote control
```

三条警告来自本机 `config.toml` 的历史字段，与 T08 无关；**没有** `failed to parse agent role file` /
`duplicate agent role name`，说明两个 role 都被 loader 正常解析。

### 验证 3：duplicate-name canary（证明 role 名字确实注册了）

“没报错”也可能只是没读到目录。用重名 canary 反向确认：把安装好的两个 role 复制到隔离目录，再放一个同名文件，
loader 必然报 duplicate：

```bash
rm -rf /tmp/t08-role-canary && mkdir -p /tmp/t08-role-canary
cp -r /root/.codex/agents /tmp/t08-role-canary/
sed 's/^name = "ds-pro"/name = "ds-flash"/' /root/.codex/agents/ds-pro.toml \
  > /tmp/t08-role-canary/agents/dup-canary.toml
CODEX_HOME=/tmp/t08-role-canary codex app-server --listen off 2>&1 | grep -i "duplicate\|malformed"
```

实测输出：

```text
2026-10-30T19:10:22.067038Z ERROR codex_app_server: Ignoring malformed agent role definition: duplicate agent role name `ds-flash` discovered in /tmp/t08-role-canary/agents
```

对 `ds-pro` 做同样的 canary，输出 `duplicate agent role name `ds-pro` ...`。两条都命中，说明安装出来的
`ds-flash.toml` / `ds-pro.toml` 已按各自的 `name` 注册为 agent role。

### 验证 4：MCP server 本身可用

role 里挂的就是仓库的 stdio server，直接握手确认 9 个工具：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t08","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node /root/dsh-crew/src/server.mjs
```

实测（解析后的摘要）：

```text
initialize: {'name': 'dsh-crew', 'version': '0.1.0-rc.14'}
tools: 9 ['dsh_run_worker', 'dsh_spawn_worker', 'dsh_worker_cancel', 'dsh_worker_config',
          'dsh_worker_events', 'dsh_worker_message', 'dsh_worker_probe',
          'dsh_worker_result', 'dsh_worker_status']
```

### 关于 `codex mcp list` / `codex debug prompt-input`

这两个命令都**看不到 agent role**，这是 0.162.1 的设计，不是安装失败：

- `codex mcp list` 只列 `config.toml` 的 `[mcp_servers]`（以及已安装 plugin 的 MCP），role 内嵌的
  `[mcp_servers.dsh-crew]` 不会出现在这里。本机真实输出（安装 role 前后一致）：

  ```text
  Name       Command                         Args                                       Env  Cwd  Status   Auth
  bili       /usr/bin/python3                /root/.codex/billion-context/bootstrap.py  -    -    enabled  Unsupported
  mempalace  /root/.local/bin/mempalace-mcp  -                                          -    -    enabled  Unsupported
  ```

- `codex debug prompt-input "hi"` 只渲染基础 prompt 消息，不渲染 role。实测输出 16324 字节、5 条 messages，
  `grep -ic 'ds-flash\|dsh-crew'` 为 `0`。

因此路径 A 的验收证据是上面的 **app-server loader + duplicate canary**，不是这两条命令。
（T08 要求的 `codex mcp list` / `codex debug prompt-input` / `codex plugin list` 三条命令都已在本机实际执行，
输出片段见本节与路径 B。）

### 回滚

```bash
node /root/dsh-crew/src/install/cli.mjs uninstall-codex
```

实测输出（在隔离 HOME 下执行；删除前自动备份，备份保留）：

```text
• removed: /tmp/t08-install-home/.codex/agents/ds-flash.toml (backup kept)
• removed: /tmp/t08-install-home/.codex/agents/ds-pro.toml (backup kept)
• removed: .../.codex/prompts/dsh-config.md
• removed: .../.codex/prompts/dsh-status.md
• removed: .../.codex/prompts/dsh-playbook.md
done.
```

回滚后 `~/.codex/agents/` 里会留下 `*.dsh-crew-backup-<epoch-ms>`，确认不再需要后可手工删除。
`config.toml` 从未被路径 A 修改，无需恢复。

## 路径 B：`codex plugin add`（本地 marketplace）

plugin 目录本身就是一个 marketplace 根：`.agents/plugins/marketplace.json` 把 `dsh-crew`
（`source: {source: "local", path: "."}`）指向同目录的 `.codex-plugin/plugin.json`；`.mcp.json`
声明 `mcpServers.dsh-crew = node /root/dsh-crew/src/server.mjs`，Codex 安装 plugin 时会自动读取它。

### 安装

```bash
codex plugin marketplace add /root/dsh-crew/codex/plugin
codex plugin add dsh-crew@dsh-crew-local
```

实测输出（隔离 `CODEX_HOME=/tmp/t08-plugin-home`，下同）：

```text
Added marketplace `dsh-crew-local` from /root/dsh-crew/codex/plugin.
Installed marketplace root: /root/dsh-crew/codex/plugin
```

```json
{
  "pluginId": "dsh-crew@dsh-crew-local",
  "name": "dsh-crew",
  "marketplaceName": "dsh-crew-local",
  "version": "0.1.0-rc.14",
  "installedPath": "/tmp/t08-plugin-home/plugins/cache/dsh-crew-local/dsh-crew/0.1.0-rc.14",
  "authPolicy": "ON_INSTALL"
}
```

`codex plugin marketplace add` 会写 `~/.codex/config.toml`（所以必须先做第 0 节的备份）：

```toml
[marketplaces.dsh-crew-local]
source_type = "local"
source = "/root/dsh-crew/codex/plugin"

[plugins."dsh-crew@dsh-crew-local"]
enabled = true
```

### 验证

```bash
codex plugin list
codex mcp list
```

实测输出：

```text
Marketplace `dsh-crew-local`
/root/dsh-crew/codex/plugin/.agents/plugins/marketplace.json

PLUGIN                   STATUS              VERSION      SOURCE
dsh-crew@dsh-crew-local  installed, enabled  0.1.0-rc.14  /root/dsh-crew/codex/plugin
```

```text
Name      Command  Args                           Env  Cwd  Status   Auth
dsh-crew  node     /root/dsh-crew/src/server.mjs  -    -    enabled  Unsupported
```

`codex mcp list` 出现 `dsh-crew` 行，即 Codex 已从 plugin 的 `.mcp.json` 读到 MCP server。进一步确认：

```text
$ codex mcp get dsh-crew
dsh-crew
  enabled: true
  transport: stdio
  command: node
  args: /root/dsh-crew/src/server.mjs
  cwd: -
  env: -
  remove: codex mcp remove dsh-crew
```

### 回滚

```bash
codex plugin remove dsh-crew@dsh-crew-local
codex plugin marketplace remove dsh-crew-local
```

实测输出：

```text
Removed plugin `dsh-crew` from marketplace `dsh-crew-local`.
Removed marketplace `dsh-crew-local`.
```

两步之后 `codex plugin list` 里该 plugin 回到 `not installed`，`codex plugin marketplace list` 输出
`No plugin marketplaces in scope.`；`config.toml` 中对应两段被移除。缓存目录
`~/.codex/plugins/cache/dsh-crew-local/` 可手工删除。

## 路径 C：手写 `~/.codex/config.toml`

最直接、兼容性最好的兜底路径；缺点是所有 Codex 会话都会启动这个 MCP server（包括不需要 worker 的会话）。

### 安装

先按第 0 节备份，然后在 `~/.codex/config.toml` 末尾追加：

```toml
[mcp_servers.dsh-crew]
command = "node"
args = ["/root/dsh-crew/src/server.mjs"]
default_tools_approval_mode = "approve"
tool_timeout_sec = 3600
```

（`codex mcp add dsh-crew -- node /root/dsh-crew/src/server.mjs` 也能写入等价条目，但它不支持
`default_tools_approval_mode` / `tool_timeout_sec`，仍要手工补两行，因此推荐直接编辑。）

### 验证

```bash
codex mcp list
```

隔离 `CODEX_HOME=/tmp/t08-config-home` 实测：

```text
Name      Command  Args                           Env  Cwd  Status   Auth
dsh-crew  node     /root/dsh-crew/src/server.mjs  -    -    enabled  Unsupported
```

再做第 0 节的 `diff -u`：应只看到新增的 `[mcp_servers.dsh-crew]` 段。

### 回滚

```bash
cp -p /root/.codex/config.toml.bak-20261030 /root/.codex/config.toml
diff -u /root/.codex/config.toml.bak-20261030 /root/.codex/config.toml   # 应为空
codex mcp list                                                          # 应无 dsh-crew 行
```

只想删这一段时，手工删除 `[mcp_servers.dsh-crew]` 及其后到下一个表头之前的 4 行即可；改完同样用
`diff` 核对只剩预期差异。

## 三条路径对照

| | 路径 A agent-role | 路径 B plugin | 路径 C config |
| --- | --- | --- | --- |
| 写入位置 | `~/.codex/agents/*.toml`、`~/.codex/prompts/` | `~/.codex/config.toml` + plugin cache | `~/.codex/config.toml` |
| 改 `config.toml` | 否 | 是（两段，Codex 自动写） | 是（一段，手写） |
| `codex mcp list` 可见 | 否（设计如此） | 是 | 是 |
| 生效范围 | 仅 spawn 该 role 时 | 所有会话 | 所有会话 |
| 回滚 | `uninstall-codex` | `plugin remove` + `marketplace remove` | 恢复备份 |
| 适用 | 本机默认（DECISION） | marketplace 分发/试用 | 兜底、无 role 支持时 |

## 验收记录（本机真实执行）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `codex --version` | `codex-cli 0.162.1` |
| 2 | `codex mcp list` | 仅 `bili`、`mempalace`；role 内嵌 server 不出现在此列表（符合预期） |
| 3 | `codex debug prompt-input "hi"` | 16324 字节 / 5 条消息 / `dsh-crew` 命中 0（该命令不解析 role） |
| 4 | `node /root/dsh-crew/src/install/cli.mjs codex` | 两个 role + 三个 prompt 安装成功，`args` 重写为 `/root/dsh-crew/src/server.mjs` |
| 5 | `CODEX_HOME=/root/.codex codex app-server --listen off` | 无 role 解析错误；仅历史字段警告 + 预期的 `no transport configured` |
| 6 | duplicate canary（`ds-flash` / `ds-pro`） | 均报 `duplicate agent role name ...`，证明 role 已注册 |
| 7 | MCP 握手 `tools/list` | `dsh-crew 0.1.0-rc.14`，9 个 `dsh_*` 工具 |
| 8 | `codex plugin list`（真实环境） | 仅 `openai-bundled` / `openai-api-curated`；路径 B 在隔离 `CODEX_HOME` 完整验证（见上） |
| 9 | `diff -u config.toml.bak-20261030 config.toml` | 空 diff（路径 A 不修改配置） |

真实环境 `codex plugin list` 头部（路径 B 安装前，dsh-crew 不在其中）：

```text
Marketplace `openai-bundled`
/root/.codex/.tmp/bundled-marketplaces/openai-bundled/.agents/plugins/marketplace.json

PLUGIN                    STATUS              VERSION  SOURCE
visualize@openai-bundled  installed, enabled  1.0.50   /root/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/visualize
```

真实环境 `codex debug prompt-input` 计数：

```text
$ codex debug prompt-input "hi" | wc -c
16324
$ codex debug prompt-input "hi" | grep -ic 'ds-flash\|dsh-crew'
0
```

## 边界与注意事项

- 不修改 `/usr/lib/node_modules/**` 下的 Codex 安装文件；本文件中所有命令均为只读调用或写入 `~/.codex` / `/tmp`。
- 不要重启或 kill 监听 `127.0.0.1:3080` 的进程（用户当前会话）；本流程不需要动它。
- role 文件里的 `model = "gpt-5.4-mini"` 是 Codex 侧执行 dispatcher 的模型，与 DSH worker 的
  `tier`（flash/pro）无关。
- 安装器只重写含 `server.mjs"` 的 `args` 行；改动 role TOML 的 `[mcp_servers]` 段时保持单行
  `args = [...]` 形状，否则安装后需要手工修正。
