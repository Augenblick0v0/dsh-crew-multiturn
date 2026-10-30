#!/usr/bin/env node
/**
 * probe-runtime.mjs — static capability probe for the installed DSH runtime.
 *
 * Reads the published type declarations of the DSH packages that the dsh-crew
 * fork depends on and checks, with regular expressions, that the declarations
 * for agent creation/resume, followup/steer/whenIdle, session flush and the
 * user-questions waterfall are present. The result is printed as deterministic
 * JSON (no timestamps, sorted file lists) so repeated runs can be diffed.
 *
 * This probe only observes *declarations* in the installed package. It does not
 * import DSH, start an agent, or touch a live session.
 *
 * Usage: node /root/dsh-crew/scripts/probe-runtime.mjs
 * Exit:  0 = every core declaration found, 1 = at least one core check missing.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DSH_ROOT = '/usr/lib/node_modules/@deepseek-ai/dsh';
const DSH_SCOPE = join(DSH_ROOT, 'node_modules', '@deepseek-ai');

const CORE_PACKAGES = [
  'dsh-agent',
  'dsh-agent-loop',
  'dsh-session',
  'dsh-user-questions',
];

const SUPPLEMENTARY_PACKAGES = [
  'dsh-agent-preset-registry',
  'dsh-workspace',
];

/**
 * Every check names the package whose `lib/types/*.d.ts` files are searched.
 * Patterns are anchored on the declaration shape, not on comments.
 */
const CHECKS = [
  {
    id: 'agents.create',
    kind: 'core',
    pkg: 'dsh-agent',
    description: 'AgentRegistry.create(options): Promise<AgentHandle>',
    pattern: /\bcreate\s*\(\s*options\s*:\s*CreateAgentOptions\s*\)\s*:\s*Promise<\s*AgentHandle\s*>\s*;/,
  },
  {
    id: 'agents.resume',
    kind: 'core',
    pkg: 'dsh-agent',
    description: 'AgentRegistry.resume(options): Promise<AgentHandle>',
    pattern: /\bresume\s*\(\s*options\s*:\s*ResumeAgentOptions\s*\)\s*:\s*Promise<\s*AgentHandle\s*>\s*;/,
  },
  {
    id: 'agent.followup',
    kind: 'core',
    pkg: 'dsh-agent-loop',
    description: 'ReactLoopAgent.followup(input: UserMessage): void',
    pattern: /\bfollowup\s*\(\s*(?:message|input)\s*:\s*UserMessage\s*\)\s*:\s*void\s*;/,
  },
  {
    id: 'agent.steer',
    kind: 'core',
    pkg: 'dsh-agent-loop',
    description: 'ReactLoopAgent.steer(input: UserMessage): void',
    pattern: /\bsteer\s*\(\s*(?:message|input)\s*:\s*UserMessage\s*\)\s*:\s*void\s*;/,
  },
  {
    id: 'agent.whenIdle',
    kind: 'core',
    pkg: 'dsh-agent-loop',
    description: 'ReactLoopAgent.whenIdle(): Promise<void>',
    pattern: /\bwhenIdle\s*\(\s*\)\s*:\s*Promise<\s*void\s*>\s*;/,
  },
  {
    id: 'sessions.flush',
    kind: 'core',
    pkg: 'dsh-session',
    description: 'SessionStore.flush(session: Session): Promise<boolean>',
    pattern: /\bflush\s*\(\s*session\s*:\s*Session\s*\)\s*:\s*Promise<\s*boolean\s*>\s*;/,
  },
  {
    id: 'userQuestions.request',
    kind: 'core',
    pkg: 'dsh-user-questions',
    description: "waterfall event 'user-questions/request'",
    pattern: /['"]user-questions\/request['"]\s*\(\s*this\s*:\s*Scoped<Agent>\s*,/,
  },
  {
    id: 'agentPresets',
    kind: 'supplementary',
    pkg: 'dsh-agent-preset-registry',
    description: 'Context.agentPresets: AgentPresetRegistry',
    pattern: /\bagentPresets\s*:\s*AgentPresetRegistry\s*;/,
  },
  {
    id: 'workspaceRegistry',
    kind: 'supplementary',
    pkg: 'dsh-workspace',
    description: 'Context.workspaceRegistry: WorkspaceRegistry',
    pattern: /\bworkspaceRegistry\s*:\s*WorkspaceRegistry\s*;/,
  },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listTypeFiles(pkg) {
  const dir = join(DSH_SCOPE, pkg, 'lib', 'types');
  if (!existsSync(dir)) return { dir, files: [] };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.d.ts'))
    .sort();
  return { dir, files };
}

function collectMatches(pkg, files, regex) {
  const evidence = [];
  for (const file of files) {
    const abs = join(DSH_SCOPE, pkg, 'lib', 'types', file);
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (regex.test(line)) {
        evidence.push({
          file: `${pkg}/lib/types/${file}`,
          line: index + 1,
          text: line.trim(),
        });
      }
      // Reset lastIndex in case a caller ever passes a /g regex.
      regex.lastIndex = 0;
    });
  }
  return evidence.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function main() {
  const versionFile = join(DSH_ROOT, 'package.json');
  const dshVersion = readJson(versionFile).version;

  const packages = [...CORE_PACKAGES, ...SUPPLEMENTARY_PACKAGES].map((name) => {
    const { dir, files } = listTypeFiles(name);
    return { name, dir, typeFiles: files };
  });

  const checks = CHECKS.map((check) => {
    const pkgInfo = packages.find((p) => p.name === check.pkg);
    const evidence = pkgInfo
      ? collectMatches(check.pkg, pkgInfo.typeFiles, check.pattern)
      : [];
    return {
      id: check.id,
      kind: check.kind,
      package: check.pkg,
      description: check.description,
      pattern: check.pattern.source,
      ok: evidence.length > 0,
      matchCount: evidence.length,
      evidence,
    };
  });

  const core = checks.filter((c) => c.kind === 'core');
  const supplementary = checks.filter((c) => c.kind === 'supplementary');
  const missing = core.filter((c) => !c.ok).map((c) => c.id);

  const result = {
    probe: 'dsh-runtime-types',
    runtime: {
      root: DSH_ROOT,
      packageJson: versionFile,
      version: dshVersion,
    },
    packages,
    checks,
    summary: {
      core: core.length,
      coreOk: core.filter((c) => c.ok).length,
      supplementary: supplementary.length,
      supplementaryOk: supplementary.filter((c) => c.ok).length,
      missing,
    },
  };

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = missing.length === 0 ? 0 : 1;
}

main();
