#!/usr/bin/env node
// T09 end-to-end acceptance: drive the real dsh-crew MCP stdio server through
// a full multi-turn worker session against an ISOLATED DSH instance.
//
// Usage:
//   T09_HUB_URL=http://127.0.0.1:3099 node /root/dsh-crew/scripts/e2e-followup.mjs
//
// The script never reads or writes the live 3080 instance: it points the MCP
// server at the hub URL given by T09_HUB_URL (default 127.0.0.1:3099) through
// the documented DSHPLUGIN_CREW_HUB override and refuses any other host/port.
//
// Evidence: docs/e2e/mcp-transcript.json (every tool call, raw payload,
// duration) and docs/e2e/mcp-summary.json (assertions). Exit code 0 only when
// every assertion in ASSERTIONS passes.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = join(ROOT, 'docs', 'e2e');
const HUB_URL = (process.env.T09_HUB_URL ?? 'http://127.0.0.1:3099').replace(/\/$/, '');
const WORK_DIR = process.env.T09_WORK_DIR ?? '/tmp/t09-worker-workspace';
const STAMP = new Date().toISOString();
const RUN_ID = `t09-${STAMP.replace(/[:.]/g, '-')}`;

// Hard safety rail: this acceptance script is only allowed to talk to the
// isolated instance. 3080 is the user's live session and must not be touched.
{
  const u = new URL(HUB_URL);
  assert.equal(u.hostname, '127.0.0.1', `refusing non-loopback hub: ${HUB_URL}`);
  assert.notEqual(u.port, '3080', `refusing live 3080 hub: ${HUB_URL}`);
  assert.equal(u.port, '3099', `expected isolated hub on 3099, got ${HUB_URL}`);
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

const transcript = {
  run_id: RUN_ID,
  started_at: STAMP,
  hub_url: HUB_URL,
  work_dir: WORK_DIR,
  mcp_server: join(ROOT, 'src', 'server.mjs'),
  node: process.version,
  calls: [],
  stderr: [],
};
const started = Date.now();

function record(entry) {
  transcript.calls.push({ at: new Date().toISOString(), ...entry });
}

function parseText(result) {
  const text = (result?.content ?? [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('\n');
  try { return { text, json: JSON.parse(text) }; } catch { return { text, json: null }; }
}

const client = new Client({ name: 't09-e2e', version: '1.0.0' }, { capabilities: {} });

async function callTool(name, args = {}, { timeout = 900_000 } = {}) {
  const t0 = Date.now();
  let result;
  let error = null;
  try {
    result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  } catch (err) {
    error = err;
  }
  const ms = Date.now() - t0;
  if (error) {
    record({ tool: name, args, ms, error: String(error?.message ?? error), stack: error?.stack });
    throw error;
  }
  const { text, json } = parseText(result);
  record({ tool: name, args, ms, isError: !!result.isError, text, json });
  if (result.isError) throw new Error(`${name} returned isError: ${text}`);
  return { text, json, ms };
}

function jobFromStatus(payload, id) {
  if (!Array.isArray(payload)) return null;
  return payload.find((j) => j?.id === id) ?? null;
}

async function readStatus(id) {
  const { json } = await callTool('dsh_worker_status');
  return jobFromStatus(json, id);
}

async function waitFor(id, predicate, { label, timeoutMs = 300_000, intervalMs = 2_000 } = {}) {
  const t0 = Date.now();
  let polls = 0;
  let last = null;
  for (;;) {
    last = await readStatus(id);
    polls += 1;
    if (last && predicate(last)) {
      record({ tool: 'wait_for', label, job_id: id, polls, ms: Date.now() - t0, final: last });
      return last;
    }
    if (Date.now() - t0 > timeoutMs) {
      record({ tool: 'wait_for', label, job_id: id, polls, ms: Date.now() - t0, timed_out: true, final: last });
      throw new Error(`timed out waiting for ${label} (last status: ${last?.status ?? 'missing'})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const summary = {
  run_id: RUN_ID,
  started_at: STAMP,
  hub_url: HUB_URL,
  work_dir: WORK_DIR,
  job_id: null,
  session_id: null,
  turns: 0,
  final_status: null,
  final_stop_reason: null,
  pending_questions: null,
  assertions: {},
  failures: [],
  timings: {},
};

function check(name, fn) {
  try {
    fn();
    summary.assertions[name] = 'pass';
  } catch (err) {
    summary.assertions[name] = 'fail';
    summary.failures.push(`${name}: ${err?.message ?? err}`);
    throw err;
  }
}

let transport;
try {
  const t0 = Date.now();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'src', 'server.mjs')],
    cwd: ROOT,
    env: {
      ...process.env,
      DSHPLUGIN_CREW_HUB: HUB_URL,
      // Keep the worker session isolated from any caller-inherited origin.
      DSH_CREW_E2E: 't09',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    const line = chunk.toString();
    transcript.stderr.push({ at: new Date().toISOString(), line });
    process.stderr.write(line);
  });
  await client.connect(transport);
  summary.timings.connect_ms = Date.now() - t0;
  record({ tool: 'mcp_connect', ms: summary.timings.connect_ms, server: join(ROOT, 'src', 'server.mjs'), hub: HUB_URL });

  const tList = Date.now();
  const tools = await client.listTools();
  record({
    tool: 'tools/list',
    ms: Date.now() - tList,
    count: tools.tools.length,
    names: tools.tools.map((x) => x.name),
  });
  check('tools.surface', () => assert.ok(tools.tools.length >= 9, `only ${tools.tools.length} tools`));

  // Session configuration: hub mode (never fall back to standalone), the
  // `standard` preset (minimal has no ask_user_question tool), ask policy.
  const tCfg = Date.now();
  const cfg = await callTool('dsh_worker_config', {
    mode: 'hub',
    preset_flash: 'standard',
    question_policy: 'ask',
    default_timeout_seconds: 600,
    idle_ttl_seconds: 1800,
    question_timeout_seconds: 300,
  });
  summary.timings.config_ms = Date.now() - tCfg;
  check('config.mode_hub', () => assert.equal(cfg.json?.mode, 'hub'));
  check('config.preset_flash_standard', () => assert.equal(cfg.json?.preset_flash, 'standard'));

  // Turn 1 — the dispatch itself. dsh_run_worker blocks until the turn ends.
  const turn1Task = [
    'You are the worker in a DSH multi-turn end-to-end acceptance test.',
    'Do not modify any files. Do not run shell commands. This is a conversation-only test.',
    'Turn 1: reply with exactly T09-TURN1-OK and then stop.',
    'You will receive further follow-up messages in this same session; do not end the session.',
  ].join(' ');
  const t1 = Date.now();
  const run1 = await callTool('dsh_run_worker', {
    task: turn1Task,
    tier: 'flash',
    effort: 'high',
    cwd: WORK_DIR,
    timeout_seconds: 600,
  });
  summary.timings.turn1_ms = Date.now() - t1;
  const job = run1.json;
  check('run.job_id', () => assert.match(job?.id ?? '', /^hub-/));
  check('run.turn1_text', () => assert.match(String(job?.result ?? ''), /T09-TURN1-OK/));
  summary.job_id = job.id;
  summary.session_id = job.sessionId ?? null;
  record({ tool: 'evidence', note: 'turn 1 job snapshot', job });

  // Immediately after the blocking dispatch, take an explicit status sample
  // (the task asks for run → status ordering).
  const st1 = await readStatus(job.id);
  check('status.after_turn1_present', () => assert.equal(st1?.id, job.id));
  check('status.after_turn1_turns_1', () => assert.equal(st1?.turns, 1));

  // Turn 2 — the first of two follow-ups. dsh_worker_message returns when the
  // message is accepted; poll until the turn settles.
  {
    const index = 2;
    const expected = 'T09-TURN2-OK';
    const t = Date.now();
    const sent = await callTool('dsh_worker_message', {
      id: job.id,
      message: `Turn ${index}: reply with exactly ${expected} and then stop. Do not use any tools.`,
      mode: 'followup',
    });
    record({ tool: 'evidence', note: `turn ${index} accepted`, sent: sent.json });
    const settled = await waitFor(job.id, (j) => j.status === 'idle' && j.turns >= index, {
      label: `turn ${index} idle`,
      timeoutMs: 300_000,
    });
    summary.timings[`turn${index}_ms`] = Date.now() - t;
    check(`message.turn${index}_settled`, () => assert.equal(settled.turns, index));
  }

  // Turn 3 — the second follow-up both asks a question and finishes the turn.
  // This is the V09 shape: dispatch + 2 follow-ups, with the worker's question
  // inside the final follow-up, so the whole session has exactly 3 turns.
  const t3 = Date.now();
  await callTool('dsh_worker_message', {
    id: job.id,
    message: [
      'Turn 3: exercise the ask_user_question tool before answering.',
      'Call ask_user_question with exactly one question:',
      '{"questions":[{"id":"codename","header":"T09 codename","question":"Which T09 release codename should this test record?","options":[{"label":"BLUEBIRD"},{"label":"REDFOX"}]}]}',
      'Wait for the answer. After you receive it, reply with exactly T09-ANSWER=<the selected label> and stop.',
      'Do not guess the answer and do not skip the tool call.',
    ].join(' '),
    mode: 'followup',
  });
  const parked = await waitFor(job.id, (j) => j.status === 'needs_input' && j.pendingQuestions >= 1, {
    label: 'ask_user parked',
    timeoutMs: 300_000,
  });
  summary.timings.turn3_to_question_ms = Date.now() - t3;
  check('question.needs_input', () => assert.equal(parked.status, 'needs_input'));
  check('question.pending_count', () => assert.ok(parked.pendingQuestions >= 1));
  record({ tool: 'evidence', note: 'parked question status', job: parked });

  // Answer the parked question. The hub resumes the SAME turn (no new turn).
  const t5 = Date.now();
  const answered = await callTool('dsh_worker_message', {
    id: job.id,
    message: 'BLUEBIRD',
  });
  record({ tool: 'evidence', note: 'answer accepted', answer: answered.json });
  const afterAnswer = await waitFor(job.id, (j) => j.status === 'idle' && j.pendingQuestions === 0, {
    label: 'answered turn idle',
    timeoutMs: 300_000,
  });
  summary.timings.answer_to_idle_ms = Date.now() - t5;

  // Final result, fetched through dsh_worker_result.
  const tRes = Date.now();
  const finalRes = await callTool('dsh_worker_result', { job_id: job.id, wait_seconds: 0 });
  summary.timings.result_ms = Date.now() - tRes;
  const final = finalRes.json;
  record({ tool: 'evidence', note: 'final result', job: final });

  const turns = Array.isArray(final?.turns) ? final.turns : [];
  const pending = Array.isArray(final?.pendingQuestions) ? final.pendingQuestions : [];
  summary.turns = turns.length;
  summary.final_status = final?.status ?? null;
  summary.final_stop_reason = turns.at(-1)?.stopReason ?? null;
  summary.pending_questions = pending.length;

  // ASSERTIONS — V09 core.
  check('turns.length>=3', () => assert.ok(turns.length >= 3, `turns.length=${turns.length}`));
  check('V09.turns.length===3', () => assert.equal(turns.length, 3, `turns.length=${turns.length}`));
  check('turns.last.stopReason=completed', () => assert.equal(turns.at(-1)?.stopReason, 'completed'));
  check('pendingQuestions.empty', () => assert.equal(pending.length, 0));
  // The multiturn state machine reports a successful finished turn as `idle`
  // (session retained for further turns); `done` is the one-shot standalone
  // status. Accept both as success, but record the literal value separately
  // instead of pretending it is `done`.
  check('status.success(idle-or-done)', () => assert.ok(final?.status === 'idle' || final?.status === 'done', `status=${final?.status}`));
  check('final.result.answer', () => assert.match(String(final?.result ?? ''), /T09-ANSWER=BLUEBIRD/));
  check('session_id.present', () => assert.match(String(summary.session_id ?? ''), /^session-/));
  // For the record: V09's literal wording.
  summary.assertions['V09.turns.length===3'] = turns.length === 3 ? 'pass' : 'deviation';
  summary.assertions['V09.literal_status_done'] = final?.status === 'done' ? 'pass' : 'deviation';
  summary.status_note = final?.status === 'done'
    ? 'final status is literally done'
    : `final status is ${final?.status} (success, session retained); the literal V09 word "done" is the one-shot standalone status, not the multiturn idle state`;
  summary.ok = summary.failures.length === 0;
  summary.duration_ms = Date.now() - started;
  summary.finished_at = new Date().toISOString();
  record({ tool: 'summary', summary });
  writeFileSync(join(OUT_DIR, 'mcp-transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
  writeFileSync(join(OUT_DIR, 'mcp-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
} catch (err) {
  summary.ok = false;
  summary.error = String(err?.stack ?? err);
  summary.duration_ms = Date.now() - started;
  summary.finished_at = new Date().toISOString();
  transcript.calls.push({ at: new Date().toISOString(), tool: 'fatal', error: summary.error });
  writeFileSync(join(OUT_DIR, 'mcp-transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
  writeFileSync(join(OUT_DIR, 'mcp-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  try { await client.close(); } catch {}
}
