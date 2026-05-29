import { TextDecoder } from 'node:util';

import { describe, expect, test } from 'bun:test';

import {
  createNarrationServer,
  createNarrationServiceForBackend,
  kokoroBoundarySilenceMs,
  kokoroInitialSilenceMs,
  NarrationService,
  narrationTextForRendering,
  normalizeNarrationRequest,
  wavBytesForFloat32,
  type SayOptions,
} from './index.ts';

describe('normalizeNarrationRequest', () => {
  test('accepts one text narration', () => {
    expect(normalizeNarrationRequest({ text: 'hello', durationMs: 1000 })).toMatchObject({
      text: 'hello',
      durationMs: 1000,
    });
  });

  test('accepts say and pause steps', () => {
    expect(
      normalizeNarrationRequest({
        steps: [{ text: 'first' }, { type: 'pause', pauseMs: 250 }, { text: 'second', atMs: 1000 }],
      })
    ).toMatchObject({
      steps: [{ text: 'first' }, { type: 'pause', pauseMs: 250 }, { text: 'second', atMs: 1000 }],
    });
  });

  test('rejects empty bodies', () => {
    expect(() => normalizeNarrationRequest({})).toThrow('text or steps');
  });
});

describe('NarrationService', () => {
  test('queues narration steps through the speaker', async () => {
    const spoken: Array<{ text: string; options: Required<SayOptions> }> = [];
    const service = new NarrationService(async (text, options) => {
      spoken.push({ text, options });
    });

    const job = service.enqueue({
      voice: 'Samantha',
      steps: [{ text: 'first' }, { text: 'second' }],
    });
    await waitFor(() => service.getJob(job.id)?.status === 'completed');

    expect(spoken.map((item) => item.text)).toEqual(['first', 'second']);
    expect(spoken[0]?.options.voice).toBe('Samantha');
  });
});

describe('narrationTextForRendering', () => {
  test('turns pauses and cue offsets into renderable speech text', () => {
    expect(
      narrationTextForRendering({
        steps: [
          { text: 'first' },
          { type: 'pause', pauseMs: 250 },
          { text: 'second', atMs: 1000, durationMs: 500 },
        ],
      })
    ).toContain('[[slnc 250]]');
  });
});

describe('createNarrationServer', () => {
  test('accepts narration jobs over HTTP', async () => {
    const spoken: string[] = [];
    const service = new NarrationService(async (text) => {
      spoken.push(text);
    });
    const server = createNarrationServer(service);

    const response = await server(
      new Request('http://localhost/v1/narration', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      })
    );

    expect(response.status).toBe(202);
    await waitFor(() => spoken.length === 1);
    expect(spoken).toEqual(['hello']);
  });

  test('returns rendered narration audio bytes', async () => {
    const service = new NarrationService(
      async () => undefined,
      async () => new Uint8Array([1, 2, 3])
    );
    const server = createNarrationServer(service);

    const response = await server(
      new Request('http://localhost/v1/narration/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/aiff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('uses WAV headers for Kokoro render responses', () => {
    expect(createNarrationServiceForBackend('kokoro').getRenderHeaders()).toMatchObject({
      'content-type': 'audio/wav',
      'content-disposition': 'attachment; filename="narration.wav"',
    });
  });
});

describe('wavBytesForFloat32', () => {
  test('writes a mono PCM WAV file', () => {
    const bytes = wavBytesForFloat32([new Float32Array([0, 0.5, -0.5])], 24000);
    const header = new TextDecoder().decode(bytes.slice(0, 4));
    const wave = new TextDecoder().decode(bytes.slice(8, 12));
    const view = new DataView(bytes.buffer);

    expect(header).toBe('RIFF');
    expect(wave).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint16(34, true)).toBe(16);
  });
});

describe('Kokoro playback padding', () => {
  test('uses conservative chunk boundary silence by default', () => {
    expect(kokoroInitialSilenceMs()).toBe(120);
    expect(kokoroBoundarySilenceMs()).toBe(350);
  });

  test('allows playback padding overrides from environment', () => {
    const previousInitial = Bun.env.NARRATION_KOKORO_INITIAL_SILENCE_MS;
    const previousBoundary = Bun.env.NARRATION_KOKORO_BOUNDARY_SILENCE_MS;
    Bun.env.NARRATION_KOKORO_INITIAL_SILENCE_MS = '250';
    Bun.env.NARRATION_KOKORO_BOUNDARY_SILENCE_MS = '500';

    try {
      expect(kokoroInitialSilenceMs()).toBe(250);
      expect(kokoroBoundarySilenceMs()).toBe(500);
    } finally {
      Bun.env.NARRATION_KOKORO_INITIAL_SILENCE_MS = previousInitial;
      Bun.env.NARRATION_KOKORO_BOUNDARY_SILENCE_MS = previousBoundary;
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error('Timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
