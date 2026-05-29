import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  configureLaunchAgent,
  configureOpenCode,
  installRuntimePackages,
  runInit,
} from './init.ts';

describe('configureOpenCode', () => {
  test('writes project OpenCode and TUI plugin config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snitch-init-'));
    try {
      const result = await configureOpenCode({
        scope: 'project',
        backend: 'kokoro',
        cwd: dir,
        homeDir: dir,
      });
      const opencodeConfig = JSON.parse(await readFile(result.opencodeConfigPath, 'utf8'));
      const tuiConfig = JSON.parse(await readFile(result.tuiConfigPath, 'utf8'));

      expect(opencodeConfig.plugin).toEqual([
        [
          join(dir, '.snitch', 'opencode-plugin', 'index.js'),
          { backend: 'kokoro', serviceUrl: 'http://127.0.0.1:4766' },
        ],
      ]);
      expect(tuiConfig.plugin).toEqual([
        [join(dir, '.snitch', 'opencode-plugin', 'tui.js'), { toggleFile: '.opencode-snitch-off' }],
      ]);
      expect(result.modelDir).toContain('kokoro');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('replaces existing narration plugin without dropping unrelated plugins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snitch-init-existing-'));
    try {
      await Bun.write(
        join(dir, 'opencode.json'),
        JSON.stringify({ plugin: ['other-plugin', 'opencode-plugin-snitch'] })
      );

      const result = await configureOpenCode({
        scope: 'project',
        backend: 'say',
        cwd: dir,
        homeDir: dir,
      });
      const opencodeConfig = JSON.parse(await readFile(result.opencodeConfigPath, 'utf8'));

      expect(opencodeConfig.plugin).toEqual([
        'other-plugin',
        [
          join(dir, '.snitch', 'opencode-plugin', 'index.js'),
          { backend: 'say', serviceUrl: 'http://127.0.0.1:4766' },
        ],
      ]);
      expect(result.modelDir).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('configureLaunchAgent', () => {
  test('writes a macOS LaunchAgent with backend environment', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'snitch-launch-agent-'));
    try {
      const plistPath = await configureLaunchAgent({
        scope: 'project',
        backend: 'kokoro',
        homeDir,
        serviceCommand: '/tmp/service',
      });
      const plist = await readFile(plistPath, 'utf8');

      expect(plist).toContain('ai.applauselab.snitch');
      expect(plist).toContain('NARRATION_BACKEND=kokoro');
      expect(plist).toContain('NARRATION_KOKORO_CACHE_DIR=');
      expect(plist).toContain('/tmp/service');
      expect(plist).toContain('<key>RunAtLoad</key>');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe('runInit', () => {
  test('prepares Kokoro cache without direct model downloads', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'snitch-init-cache-'));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('unexpected fetch');
    }) as unknown as typeof fetch;

    try {
      const result = await runInit({
        scope: 'global',
        backend: 'kokoro',
        cwd: homeDir,
        homeDir,
        installPackages: false,
        startService: false,
      });

      if (!result.modelDir) throw new Error('Expected Kokoro cache directory');
      expect(result.modelDir).toBe(join(homeDir, '.snitch', 'models', 'kokoro'));
      expect((await stat(result.modelDir)).isDirectory()).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe('installRuntimePackages', () => {
  test('installs runtime packages globally with bun', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'snitch-runtime-'));
    const commands: string[][] = [];
    try {
      await installRuntimePackages(
        'bun',
        async (command) => {
          commands.push(command);
        },
        homeDir,
        async () => undefined
      );

      expect(commands).toEqual([
        ['bun', 'add', 'opencode-plugin-snitch', 'opencode-plugin-snitch-tui', 'snitch-service'],
      ]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
