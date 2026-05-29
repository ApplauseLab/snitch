#!/usr/bin/env bun

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { runInit, type InitScope, type NarrationBackend } from './init.ts';

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
  });

  writeLine(`OpenCode config: ${result.opencodeConfigPath}`);
  writeLine(`TUI config: ${result.tuiConfigPath}`);
  writeLine(`LaunchAgent: ${result.launchAgentPath}`);
  if (result.modelDir) writeLine(`Kokoro cache directory: ${result.modelDir}`);
  writeLine('Snitch is installed as a LaunchAgent and will start at login.');
  writeLine('Restart OpenCode so it picks up the plugin configuration.');
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command === 'init') {
    await init(args);
    return;
  }

  writeLine('Usage: snitch init [--scope global|project] [--backend kokoro|say]');
}

try {
  await main();
} catch (error) {
  writeLine(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
