# DSH Crew MCP tools

`dsh-crew` is a stdio MCP server (`node src/server.mjs`). One process lives for
one orchestrator session. `tools_profile` decides the surface: **core**
(default) exposes six tools — `dsh_run_worker`, `dsh_worker_wait`,
`dsh_worker_message`, `dsh_worker_status`, `dsh_worker_result`,
`dsh_worker_cancel` — and **full** adds `dsh_spawn_worker`,
`dsh_worker_events`, `dsh_worker_config`, `dsh_worker_probe` (ten total). Tool
schemas are re-sent on every model request, so core is the default token
budget; opt into full with `DSHPLUGIN_CREW_TOOLS=full` or
`dsh_worker_config({tools_profile:"full"})` in a fresh process.

## Tool table

| Tool | Purpose | Inputs | Main return fields |
| --- | --- | --- | --- |
| `dsh_run_worker` | Run one worker task and block until it settles. | `task` (required), `tier`, `effort`, `worker`, `cwd` (ignored when `workspace_root` is set), `timeout_seconds`, `allow_concurrent_cwd` | brief result (`id`, `status`, `turn`, `turns`, `result`, …) |
| `dsh_worker_wait` | Block once until a job settles, needs input, or ends a turn. Use instead of polling status/events. | `job_id` (required), `timeout_seconds` (default 600, max 900), `until` = `settled` (default) \| `needs_input` \| `turn_end` | `{ id, status, turn, timed_out, last_event, result_preview, pending_questions }` |
| `dsh_spawn_worker` | Start a worker in the background and return its job id immediately. | `task` (required), `tier`, `effort`, `worker`, `cwd`, `allow_concurrent_cwd` | brief job view (id, status, turn, …) |
| `dsh_worker_status` | Brief status of all jobs, or long-poll one job. | optional `job_id`, `wait_seconds` (≤600), `verbose` | array of brief entries + `kind: "cwd-lock"` entries |
| `dsh_worker_result` | Fetch a job's current/final state, optionally waiting. | `job_id` (required), `wait_seconds` (default 0), `max_chars` (default 2000, 0 = no limit), `verbose` | `{ id, status, turn, turns, result, pendingQuestions, … }` |
| `dsh_worker_message` | Continue a worker session: follow-up, steer, or answer a parked question. | `id` (required), `message` (required), `mode` = `followup` (default) \| `steer` \| `auto` | `{ action, job, note? }` |
| `dsh_worker_events` | Read the hub event ring buffer after a sequence cursor. | `id` (required), `since` (default 0) | `{ events, next, latest, status }` |
| `dsh_worker_cancel` | Cancel a running job and release its cwd lock. | `job_id` (required) | job view |
| `dsh_worker_config` | Read or update session-level worker settings. | optional patches; `reset` | full session config + bindings/providers |
| `dsh_worker_probe` | Probe one configured provider/model with a no-op tool call. | `tier`, `provider`, `model` | probe observation |

### `dsh_worker_result` shape

Every result is **brief by default** — turn records, capabilities and the task
text are omitted because the model re-reads them on every later request:

```json
{
  "id": "hub-1-abc",
  "status": "idle",
  "turn": 2,
  "turns": 2,
  "result": "final answer (clipped at 2000 chars)",
  "pendingQuestions": [{ "questionId": "q-1", "question": "Which colour?" }],
  "pendingQuestionCount": 1
}
```

`verbose: true` returns the full record (`turns[]` as objects, `turnRecords`,
`pendingQuestionDetails`). `result_truncated: true` plus `result_chars` says the
text was clipped; raise `max_chars`, or read the tail with `dsh_worker_events`.

`turns` is always an array of turn records (`[]` for standalone/CLI jobs, which
are one-shot). `pendingQuestions` is always an array of question details; the
count is repeated as `pendingQuestionCount`. Other job fields (`id`, `turn`,
`error`, `stopReason`, `tokens`, …) are passed through for polling.

### `dsh_worker_wait` shape

One blocking call replaces the `status` / `events` / `result` polling loop.
`until` picks the stop condition:

- `settled` (default) — stop on `idle`, `done`, `failed`, `cancelled`,
  `expired`, or a parked question (`needs_input` / any pending question).
- `needs_input` — stop only when the worker parks a question or reaches a
  settled state.
- `turn_end` — stop when `turn` advances past the value observed at call time
  (the job may be `running` again on the next queued turn), or on any stop
  state above.

The return object has exactly these keys:

```json
{
  "id": "hub-1-abc",
  "status": "idle",
  "turn": 2,
  "timed_out": false,
  "last_event": { "seq": 42, "ts": "2026-11-01T02:00:00.000Z", "type": "turn/settled", "summary": "turn 2 settled" },
  "result_preview": "final answer (first RESULT_CHARS chars, else null)",
  "pending_questions": [{ "questionId": "q-1", "question": "Which colour?" }]
}
```

`timeout_seconds` defaults to 600 and is capped at 900. Waiting reuses the
existing `GET /jobs/:id?wait=` route in slices of at most 60 seconds with a
1-second gap between slices; it never polls `/events`. On timeout the current
view is returned with `timed_out: true` and the job is left untouched. Call it
**once on the normal path** after a dispatch returns "still running"; do not loop
`dsh_worker_status` / `dsh_worker_events` / `dsh_worker_result`. When
`needs_input` arrives, answer via `dsh_worker_message`, then wait once more.
`result_preview` is capped at `RESULT_CHARS` (default 2000; 0 = no limit); an
empty result stays `null`. Use `dsh_worker_result` for the full text.

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
