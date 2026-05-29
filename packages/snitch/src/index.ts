#!/usr/bin/env bun

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runInit, type InitScope, type NarrationBackend } from './init.ts';

export const SNITCH_SKILL = `# Snitch Skill

Use Snitch when you need local speech or rendered narration audio from any agent or script, even when OpenCode is not involved.

Snitch runs a local HTTP service at http://127.0.0.1:4766 by default. The service can queue speech for immediate playback, report job status, or render audio bytes. On macOS, rendered audio uses the built-in \`say\` backend and returns AIFF bytes.

## Required Setup

Install and start Snitch first:

\`\`\`bash
bunx github:ApplauseLab/snitch#main init --scope global --backend kokoro
\`\`\`

Check that the service is running:

\`\`\`bash
curl -fsS http://127.0.0.1:4766/health
\`\`\`

Expected response:

\`\`\`json
{"ok":true}
\`\`\`

## Queue Speech For Playback

Use \`POST /v1/narration\` to queue text for playback through the running service. This is asynchronous and returns a job.

\`\`\`bash
curl -fsS -X POST http://127.0.0.1:4766/v1/narration \\
  -H 'content-type: application/json' \\
  --data '{"text":"I finished the task and verification passed."}'
\`\`\`

Poll the job:

\`\`\`bash
curl -fsS http://127.0.0.1:4766/v1/jobs/<job-id>
\`\`\`

Job statuses are \`queued\`, \`running\`, \`completed\`, and \`failed\`.

## Timed Narration Steps

Use \`steps\` when you need pauses or relative timing:

\`\`\`bash
curl -fsS -X POST http://127.0.0.1:4766/v1/narration \\
  -H 'content-type: application/json' \\
  --data '{"steps":[{"text":"Starting."},{"type":"pause","pauseMs":500},{"text":"Done."}]}'
\`\`\`

Step shape:

\`\`\`json
{
  "steps": [
    { "type": "say", "text": "First sentence.", "atMs": 0 },
    { "type": "pause", "pauseMs": 500 },
    { "type": "say", "text": "Second sentence.", "atMs": 1200 }
  ]
}
\`\`\`

## Render Audio Bytes

Use \`POST /v1/narration/render\` when you want audio data instead of immediate playback. If you omit \`outputPath\`, the response body is the binary AIFF audio bytes.

Save returned bytes with curl:

\`\`\`bash
curl -fsS -X POST http://127.0.0.1:4766/v1/narration/render \\
  -H 'content-type: application/json' \\
  --data '{"text":"This audio was rendered by Snitch."}' \\
  --output narration.aiff
\`\`\`

Fetch bytes from JavaScript:

\`\`\`js
const response = await fetch('http://127.0.0.1:4766/v1/narration/render', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'This audio should be returned as bytes.' }),
});

if (!response.ok) throw new Error(await response.text());
const bytes = new Uint8Array(await response.arrayBuffer());
\`\`\`

## Save Audio On The Service Host

Pass \`outputPath\` to ask the Snitch service to write the rendered file on the machine where the service is running. The HTTP response still returns the bytes and includes an \`x-output-path\` header.

\`\`\`bash
curl -fsS -X POST http://127.0.0.1:4766/v1/narration/render \\
  -H 'content-type: application/json' \\
  --data '{"text":"Save this to disk.","outputPath":"/tmp/snitch-output.aiff"}' \\
  --output /tmp/snitch-output-copy.aiff
\`\`\`

Use \`outputPath\` only with trusted local input. It writes a file path visible to the local Snitch service process.

## Voice And Rate

For queued Kokoro playback, use Kokoro voice names such as \`bf_emma\`, \`af_heart\`, \`af_bella\`, or \`am_michael\`:

\`\`\`json
{ "text": "Hello from Kokoro.", "voice": "bf_emma" }
\`\`\`

For rendered AIFF output, Snitch uses macOS \`say\`, so use installed macOS voices and optional \`rate\`:

\`\`\`json
{ "text": "Hello from macOS say.", "voice": "Samantha", "rate": 185 }
\`\`\`

List macOS voices:

\`\`\`bash
say -v '?'
\`\`\`

## Agent Guidance

- Prefer \`/v1/narration\` when the user should hear progress immediately.
- Prefer \`/v1/narration/render\` when the user asked for a file, attachment, reusable audio clip, or raw bytes.
- Keep spoken text concise and conversational.
- Do not speak secrets, raw stack traces, long commands, or large code blocks unless the user explicitly asks.
- Poll \`/v1/jobs/:id\` after queueing if the task depends on speech completion.
`;

function writeLine(message: string): void {
  output.write(`${message}\n`);
}

async function askChoice<T extends string>(
  question: string,
  choices: readonly T[],
  fallback: T
): Promise<T> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${question} (${choices.join('/')}) [${fallback}]: `)).trim();
    if (choices.includes(answer as T)) return answer as T;
    return fallback;
  } finally {
    rl.close();
  }
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function valueFor(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function findSourceRoot(): Promise<string | undefined> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(currentDir, '..', '..', '..'), join(currentDir, '..')];

  for (const candidate of candidates) {
    if (await Bun.file(join(candidate, 'packages', 'snitch-service', 'package.json')).exists()) {
      return candidate;
    }
  }

  return undefined;
}

async function init(args: string[]): Promise<void> {
  const scopeFlag = valueFor(args, '--scope');
  const backendFlag = valueFor(args, '--backend');
  const scopeChoices = ['global', 'project'] as const;
  const backendChoices = ['kokoro', 'say'] as const;
  const scope = scopeChoices.includes(scopeFlag as InitScope)
    ? (scopeFlag as InitScope)
    : await askChoice(
        'Install OpenCode plugin globally or for this project?',
        scopeChoices,
        'project'
      );
  const backend = backendChoices.includes(backendFlag as NarrationBackend)
    ? (backendFlag as NarrationBackend)
    : await askChoice('Speech backend?', backendChoices, 'kokoro');

  writeLine('Installing Snitch runtime and writing OpenCode configuration...');
  const result = await runInit({
    scope,
    backend,
    installPackages: !hasFlag(args, '--skip-install'),
    downloadModel: !hasFlag(args, '--skip-model-download'),
    startService: !hasFlag(args, '--no-start-service'),
    sourceRoot: await findSourceRoot(),
  });

  writeLine(`OpenCode config: ${result.opencodeConfigPath}`);
  writeLine(`TUI config: ${result.tuiConfigPath}`);
  writeLine(`LaunchAgent: ${result.launchAgentPath}`);
  if (result.modelDir) writeLine(`Kokoro cache directory: ${result.modelDir}`);
  writeLine('Snitch is installed as a LaunchAgent and will start at login.');
  writeLine('Restart OpenCode so it picks up the plugin configuration.');
}

function skill(): void {
  writeLine(SNITCH_SKILL);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command === 'init') {
    await init(args);
    return;
  }

  if (command === 'skill') {
    skill();
    return;
  }

  writeLine('Usage: snitch <init|skill> [--scope global|project] [--backend kokoro|say]');
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    writeLine(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
