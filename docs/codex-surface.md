DECISION: agent-role
# Codex 0.162.1 接入面探测（T02）

- 探测日期：2026-10-31（Asia/Shanghai）
- Codex CLI：`codex-cli 0.162.1`
- 探测对象：`~/.codex/agents/*.toml`（native agent role），以及 plugin / `[mcp_servers]` 两条备选路径
- 探测文件：`/root/.codex/agents/probe-role.toml`（临时，已删除）

## 结论

**选择 native agent-role 接入面。** Codex 0.162.1 的 app-server 会枚举并解析 `~/.codex/agents/*.toml`；不需要在 `~/.codex/config.toml` 里声明 `[agents.*]`，也不依赖 plugin marketplace。现有 `codex/agents/ds-flash.toml`、`codex/agents/ds-pro.toml` 的字段形状（`name` / `description` / `model` / `developer_instructions` / `[mcp_servers.dsh-crew]`）正是这个接入面；其中 `[mcp_servers.dsh-crew]` 段也被 app-server loader 接受。

需要说清楚一个反直觉点：`codex debug prompt-input` 的输出里看不到 `probe-role`，**这不是“没有加载”的证据**。该子命令只渲染基础 prompt 消息列表，不渲染 `spawn_agent` 等工具 schema；因此 agent role 的名称/说明不会出现在这个输出里。真正能判断加载与否的是 app-server 启动时的 role loader。

## 探测 A：`codex debug prompt-input`（负结果，不能单独定案）

创建临时 role 文件：

```toml
name = "probe-role"
description = "Temporary probe role used to test whether Codex 0.162.1 loads agent definitions from ~/.codex/agents."
# model = ""
developer_instructions = "You are probe-role, a temporary agent definition used only for this loading probe."
```

执行：

```bash
cd /root
codex debug prompt-input "hi" > /tmp/codex-prompt.json
echo $?
wc -c < /tmp/codex-prompt.json
grep -in 'probe-role' /tmp/codex-prompt.json
echo "grep_exit=$?"
```

实测：

```text
0
24801
grep_exit=1
```

输出是 5 条消息（3 条 developer、2 条 user），没有 tools/schema 段：

```text
messages= 5
roles= ['developer', 'developer', 'developer', 'user', 'user']
```

把同一个文件临时改成非法 TOML 做对照：

```bash
printf 'name = [unclosed\n' > /root/.codex/agents/probe-role.toml
codex debug prompt-input "hi" > /tmp/codex-invalid.json
echo $?
wc -c < /tmp/codex-invalid.json
```

实测仍然 exit 0、约 24802 字节、没有 TOML 报错。说明 `debug prompt-input` 根本不解析这个目录；它不能用来判断 agent role 是否被 Codex 加载。

补充对照：显式用 `-c` 把 role 的 `config_file` 指向不存在的路径，`debug prompt-input` 仍是 exit 0、无报错。这也符合“该子命令不经过 role loader”的解释。

## 探测 B：app-server 启动时的 role loader（决定性证据）

### B1. 未声明的 `~/.codex/agents` 目录也会被枚举

在隔离的 `CODEX_HOME` 下放一个非法 role 文件，不写任何 `[agents.*]` 配置：

```bash
mkdir -p /tmp/codex-home-doc-invalid/agents
printf 'name = [unclosed\n' > /tmp/codex-home-doc-invalid/agents/probe-role.toml
CODEX_HOME=/tmp/codex-home-doc-invalid codex app-server --listen off
```

关键 stderr（去掉与本次探测无关的临时目录 PATH alias warning）：

```text
ERROR codex_app_server: Ignoring malformed agent role definition: failed to parse agent role file at /tmp/codex-home-doc-invalid/agents/probe-role.toml: TOML parse error at line 1, column 17
  |
1 | name = [unclosed
  |                 ^
unclosed array, expected `]`

Error: no transport configured; use --listen or enable remote control
```

`Error: no transport configured` 是 `--listen off` 的预期结果（exit 1），不是 role 加载失败；**关键在它前面的 `failed to parse agent role file at .../agents/probe-role.toml`**：目录被自动扫描，不需要 config 声明。

### B2. `name` 字段参与注册，重名会被拒绝

在另一个隔离 home 放两个文件名不同、`name` 相同的 role：

```bash
mkdir -p /tmp/codex-home-doc-dupe/agents
printf 'name = "same-role"\ndescription = "a"\ndeveloper_instructions = "a"\n' > /tmp/codex-home-doc-dupe/agents/a.toml
printf 'name = "same-role"\ndescription = "b"\ndeveloper_instructions = "b"\n' > /tmp/codex-home-doc-dupe/agents/b.toml
CODEX_HOME=/tmp/codex-home-doc-dupe codex app-server --listen off
```

关键 stderr：

```text
ERROR codex_app_server: Ignoring malformed agent role definition: duplicate agent role name `same-role` discovered in /tmp/codex-home-doc-dupe/agents
```

说明 loader 不是“只读文件不注册”，而是按 `name` 建立 role 表。

### B3. 真实 `~/.codex/agents` 同样被解析

把临时文件改成非法 TOML 后，用真实 `CODEX_HOME` 启动：

```bash
CODEX_HOME=/root/.codex codex app-server --listen off
```

关键 stderr：

```text
ERROR codex_app_server: Ignoring malformed agent role definition: failed to parse agent role file at /root/.codex/agents/probe-role.toml: TOML parse error at line 1, column 17
  |
1 | name = [unclosed
  |                 ^
unclosed array, expected `]`
```

恢复合法文件后重跑，stderr 里不再出现 `probe-role` / `agent role` / `malformed`，只剩：

```text
ERROR codex_app_server: Codex is ignoring 3 unrecognized configuration settings. Check for typos or deprecated settings.
  user (/root/.codex/config.toml): `disable_response_storage` is ignored.
  user (/root/.codex/config.toml): `network_access` is ignored.
  user (/root/.codex/config.toml): `windows_wsl_setup_acknowledged` is ignored.
Error: no transport configured; use --listen or enable remote control
```

这三条是既有 `~/.codex/config.toml` 的旧字段警告，与 agent role 无关；`--strict-config` 因此不可用（会报 `unknown configuration field 'disable_response_storage'`）。

### B4. 带 `[mcp_servers.dsh-crew]` 的 role 文件也被接受

用与 `codex/agents/ds-flash.toml` 相同的字段形状（含内嵌 MCP server）测试：

```toml
name = "probe-role"
description = "Temporary probe role with MCP server."
model = "gpt-5.4-mini"
developer_instructions = "You are probe-role."

[mcp_servers.dsh-crew]
command = "node"
args = ["/root/dsh-crew/src/server.mjs"]
default_tools_approval_mode = "approve"
tool_timeout_sec = 3600
```

```bash
CODEX_HOME=/tmp/codex-home-doc-mcp codex app-server --listen off
```

stderr 没有 `agent role` / TOML 错误，只有预期的 `Error: no transport configured`。这说明 app-server loader 接受 role 文件里的 `[mcp_servers.dsh-crew]` 段，现有 `codex/agents/*.toml` 不用改成 plugin 形态；本次没有实际启动该 MCP server。

## 二进制与 feature 辅助证据

Codex 0.162.1 的二进制里包含 native agent-role 代码路径：

```bash
BIN=/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
strings "$BIN" | grep -E 'agent-roles/src/loader|core/src/agent/role|unknown agent_type|failed to apply role' | head
```

包含：

```text
agent-roles/src/loader.rs
core/src/agent/role.rs
failed to apply role to config:
unknown agent_type '
agent type is currently not available
```

同时 `spawn_agent` 的工具描述里明确有 agent type 参数：

```text
Agent type override for the new agent. Omit to inherit the parent agent type with a full-history fork; otherwise, `default` is used.
```

feature 状态也支持子代理：

```bash
codex features list | grep -E '^(multi_agent|plugins|plugin_sharing) '
```

```text
multi_agent                              stable             true
plugin_sharing                           stable             true
plugins                                  stable             true
```

> 说明：二进制字符串只作辅助证据。真正定案的是 B1/B2/B3 的 app-server 行为；`strings` 里也包含 external-agent-migration 对 `.codex/agents` 的检测字符串，但上面的 parse error 来自 native `agent-roles` loader，不是迁移检测。

## 三条接入面的比较

| 接入面 | 0.162.1 证据 | 代价 | 结论 |
| --- | --- | --- | --- |
| **agent-role** | app-server 自动枚举并解析 `~/.codex/agents/*.toml`；loader 接受 role 文件内的 `[mcp_servers.dsh-crew]` 段 | 需要把 TOML 放到 `~/.codex/agents/`；role 只在子代理 spawn 时使用 | **采用** |
| plugin | `plugins stable true`；`codex plugin marketplace add` 支持本地路径；`.codex-plugin/plugin.json` + `.mcp.json` 路径存在 | 需要维护 plugin 包/marketplace 安装；仍要提供 MCP server | 备选 |
| config `[mcp_servers.dsh-crew]` | `~/.codex/config.toml` 已有 `[mcp_servers.mempalace]`、`[mcp_servers.bili]`，同形状可加 | 全局生效，没有 ds-flash/ds-pro 角色隔离 | 最后备选 |

plugin 命令实测：

```bash
codex plugin list
```

输出包含：

```text
Marketplace `openai-bundled`
visualize@openai-bundled  installed, enabled  1.0.50

Marketplace `openai-api-curated`
game-studio@openai-api-curated  not installed
```

```bash
codex plugin marketplace add --help
```

输出包含：

```text
Add a local or Git marketplace to the configured marketplace sources
Usage: codex plugin marketplace add [OPTIONS] <SOURCE>
  Marketplace source: a local path, owner/repo[@ref], HTTPS Git URL, or SSH Git URL
```

因此 plugin 是可行的备选路径（CLI 声明支持本地 marketplace 安装；本次未实际安装 plugin），但它不是首选：本仓库已经有 `codex/agents/*.toml` 和 `installCodex` 的安装逻辑，agent-role 路径改动最小。

## 对 dsh-crew 的落地含义

`codex/agents/ds-flash.toml` 和 `ds-pro.toml` 已经包含：

- `name = "ds-flash"` / `"ds-pro"`
- `description`
- `model = "gpt-5.4-mini"`
- `developer_instructions`（thin dispatcher：把任务原文交给 `dsh_run_worker`，只回传结果和 footer）
- `[mcp_servers.dsh-crew]`（`command = "node"`、`args = [<repo>/src/server.mjs]`、`default_tools_approval_mode = "approve"`、`tool_timeout_sec = 3600`）

`src/install/install.mjs` 的 `installCodex` 会把它们写到 `~/.codex/agents`（或项目 `.codex/agents`），并把 `args` 重写成当前 repo 的 `src/server.mjs`。`tests/install-toml.test.mjs` 已断言两个角色 TOML 可解析且 `mcp_servers['dsh-crew'].args[0]` 指向 `server.mjs`。T08 直接沿用这个形状即可。

## 清理与可复现性

探测文件在完成后已删除，避免影响用户真实 Codex：

```bash
rm -f /root/.codex/agents/probe-role.toml
rmdir /root/.codex/agents   # 目录是探测时新建的，删除后为空
```

验证：

```bash
ls -ld /root/.codex/agents
```

```text
ls: cannot access '/root/.codex/agents': No such file or directory
```

`/root/.codex/agents` 已回到探测前不存在的状态。隔离测试目录都在 `/tmp/codex-home-doc-*`，不属于用户配置。

## 限制

- 本次只观察到 **app-server 启动时的 role 解析/注册**，没有实际调用模型 `spawn_agent` 让子代理执行任务；因此“能加载”是实测，“端到端 spawn 成功”未验证。不要把它写成后者。
- `debug prompt-input` 的负结果不是反证；它只渲染基础 prompt 消息，不渲染工具 schema。
- `codex app-server --listen off` 的 exit 1 是“没有 transport”的预期错误；带 role 的合法/非法判断只看它前面有没有 `agent role` 错误。
- 现有 `~/.codex/config.toml` 有 3 个被忽略的旧字段，`--strict-config` 不可用；这与接入面选择无关。
