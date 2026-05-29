import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  createNarrationHooks,
  extractNarrationBlocks,
  narrationEnabled,
  NARRATION_SYSTEM_INSTRUCTION,
  setRuntimeNarrationEnabled,
  toggleRuntimeNarration,
} from './core.ts';
import * as pluginModule from './index.ts';

const options = {
  enabled: true,
  instructions: true,
  voice: '',
  rate: 0,
  serviceUrl: 'http://127.0.0.1:4766',
  tags: ['narration'],
  fenceLanguages: ['narration', 'narrate'],
  toggleFile: '/tmp/opencode-snitch-test-off',
};

function textEvent(text: string) {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text,
      },
    },
  } as const;
}

describe('extractNarrationBlocks', () => {
  test('extracts XML-style narration blocks', () => {
    expect(extractNarrationBlocks('hello <narration>Speak this.</narration> world')).toEqual([
      { index: 6, text: 'Speak this.' },
    ]);
  });

  test('extracts fenced narration blocks', () => {
    expect(extractNarrationBlocks('hello\n```narration\nSpeak this too.\n```\nworld')).toEqual([
      { index: 6, text: 'Speak this too.' },
    ]);
  });

  test('ignores incomplete streaming blocks', () => {
    expect(extractNarrationBlocks('<narration>Not closed yet')).toEqual([]);
    expect(extractNarrationBlocks('```narration\nNot closed yet')).toEqual([]);
  });
});

describe('createNarrationHooks', () => {
  test('adds narration guidance to chat system context', async () => {
    const hooks = createNarrationHooks(options, async () => undefined);
    const output = { system: [] as string[] };

    await hooks['experimental.chat.system.transform']({}, output);

    expect(output.system).toEqual([NARRATION_SYSTEM_INSTRUCTION]);
  });

  test('queues a completed block once across repeated streaming updates', async () => {
    const queued: string[] = [];
    const hooks = createNarrationHooks(options, async (text) => {
      queued.push(text);
    });

    await hooks.event({ event: textEvent('<narration>Hello</narration>') });
    await hooks.event({ event: textEvent('<narration>Hello</narration>') });

    expect(queued).toEqual(['Hello']);
  });

  test('queues only after a streamed block closes', async () => {
    const queued: string[] = [];
    const hooks = createNarrationHooks(options, async (text) => {
      queued.push(text);
    });

    await hooks.event({ event: textEvent('<narration>Hello') });
    await hooks.event({ event: textEvent('<narration>Hello</narration>') });

    expect(queued).toEqual(['Hello']);
  });

  test('skips narration while the runtime toggle file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-snitch-plugin-'));
    const toggleFile = join(dir, 'off');
    const queued: string[] = [];
    const hooks = createNarrationHooks({ ...options, toggleFile }, async (text) => {
      queued.push(text);
    });

    try {
      await writeFile(toggleFile, 'off');
      await hooks.event({ event: textEvent('<narration>Muted</narration>') });

      await rm(toggleFile);
      await hooks.event({ event: textEvent('<narration>Unmuted</narration>') });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(queued).toEqual(['Unmuted']);
  });
});

describe('runtime narration toggle', () => {
  test('sets and toggles narration using the toggle file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-snitch-toggle-'));
    const toggleFile = join(dir, 'off');
    const toggleOptions = { ...options, toggleFile };

    try {
      expect(await narrationEnabled(toggleOptions)).toBe(true);
      expect(await setRuntimeNarrationEnabled(toggleOptions, false)).toBe(false);
      expect(await toggleRuntimeNarration(toggleOptions)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('plugin entrypoint', () => {
  test('default exports the server plugin for the OpenCode server loader', () => {
    expect(typeof pluginModule.default).toBe('function');
    expect(pluginModule.server).toBe(pluginModule.default);
  });
});
