# DSH Crew MCP tools

`dsh-crew` is a stdio MCP server (`node src/server.mjs`). One process lives for
one orchestrator session. It exposes nine tools: seven original tools keep their
existing inputs, and two multi-turn tools were added in T06.

## Tool table

| Tool | Purpose | Inputs | Main return fields |
| --- | --- | --- | --- |
| `dsh_run_worker` | Run one worker task and block until it settles. | `task` (required), `tier`, `effort`, `worker`, `cwd`, `timeout_seconds`, `allow_concurrent_cwd` | job view + `result` / `error` / `stopReason` |
| `dsh_spawn_worker` | Start a worker in the background and return its job id immediately. | `task` (required), `tier`, `effort`, `worker`, `cwd`, `allow_concurrent_cwd` | job view (id, status, turn, …) |
| `dsh_worker_status` | List hub jobs, standalone jobs and cwd locks with live progress. | none | array of job views + `kind: "cwd-lock"` entries |
| `dsh_worker_result` | Fetch a job's current/final state, optionally waiting. | `job_id` (required), `wait_seconds` (default 0) | `{ status, turns, result, pendingQuestions, … }` |
| `dsh_worker_message` | Continue a worker session: follow-up, steer, or answer a parked question. | `id` (required), `message` (required), `mode` = `auto` \| `steer` \| `followup` | `{ action, job, note? }` |
| `dsh_worker_events` | Read the hub event ring buffer after a sequence cursor. | `id` (required), `since` (default 0) | `{ events, next, latest, status }` |
| `dsh_worker_cancel` | Cancel a running job and release its cwd lock. | `job_id` (required) | job view |
| `dsh_worker_config` | Read or update session-level worker settings. | optional patches; `reset` | full session config + bindings/providers |
| `dsh_worker_probe` | Probe one configured provider/model with a no-op tool call. | `tier`, `provider`, `model` | probe observation |

### `dsh_worker_result` shape

Every result normalises to the same four fields:

```json
{
  "status": "idle",
  "turns": [{ "index": 1, "status": "idle" }],
  "result": { "ok": true },
  "pendingQuestions": [{ "questionId": "q-1", "question": "Which colour?" }]
}
```

`turns` is always an array of turn records (`[]` for standalone/CLI jobs, which
are one-shot). `pendingQuestions` is always an array of question details; the
count is repeated as `pendingQuestionCount`. Other job fields (`id`, `turn`,
`error`, `stopReason`, `tokens`, …) are passed through for polling.

### `dsh_worker_status` fields

Job entries always carry:

- `turn` — completed/current turn number (`0` before the first turn)
- `currentTool` — tool currently executing, else `null`
- `pendingQuestions` — number of questions parked in `needs_input`
- `lastEventAt` — ISO timestamp of the latest hub event (or activity fallback)

### `dsh_worker_config` multi-turn fields

- `question_policy` — `ask` (default) parks a worker's user question as
  `needs_input` and keeps the session alive; `handoff` keeps the legacy
  unattended-failure behaviour.
- `idle_ttl_seconds` — how long an idle hub worker is kept before expiry
  (default `1800`).
- `question_timeout_seconds` — how long a parked question waits for
  `dsh_worker_message` before the worker fails with `QUESTION_TIMEOUT`
  (default `900`).

## Copy-paste stdio example

Run this from the repository root. The MCP server reads newline-delimited
JSON-RPC on stdin and writes replies on stdout; this example initialises the
session, lists the tools, and reads the status.

```bash
cd /root/dsh-crew
node src/server.mjs <<'MCP'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dsh_worker_status","arguments":{}}}
MCP
```

Typical multi-turn calls:

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"dsh_worker_message","arguments":{"id":"hub-1-abc","message":"Use the staging config instead."}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"dsh_worker_events","arguments":{"id":"hub-1-abc","since":42}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"dsh_worker_result","arguments":{"job_id":"hub-1-abc","wait_seconds":0}}}
```

`dsh_worker_message` detects a `needs_input` job and routes the text to
`POST /jobs/:id/answer`, so the same turn resumes. For a running job it steers;
for an idle/done/failed job it starts a follow-up turn. Standalone jobs are
one-shot, so `dsh_worker_message` and `dsh_worker_events` return an explanatory
payload instead of pretending to support turns/events.
