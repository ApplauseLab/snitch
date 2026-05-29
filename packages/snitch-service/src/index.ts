#!/usr/bin/env bun

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SayOptions = {
  voice?: string;
  rate?: number;
  sayPath?: string;
};

export type SayStep = SayOptions & {
  type?: 'say';
  text: string;
  atMs?: number;
  durationMs?: number;
};

export type PauseStep = {
  type: 'pause';
  pauseMs?: number;
  durationMs?: number;
  atMs?: number;
};

export type NarrationStep = SayStep | PauseStep;

export type NarrationRequest = SayOptions & {
  id?: string;
  text?: string;
  steps?: NarrationStep[];
  atMs?: number;
  durationMs?: number;
};

export type RenderNarrationRequest = NarrationRequest & {
  outputPath?: string;
};

export type NarrationJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export type NarrationJob = {
  id: string;
  status: NarrationJobStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

// ESLint's base no-unused-vars checks type-only function parameter names.
// eslint-disable-next-line no-unused-vars
type Speaker = (text: string, options: Required<SayOptions>) => Promise<void>;
// eslint-disable-next-line no-unused-vars
type AudioRenderer = (request: RenderNarrationRequest) => Promise<Uint8Array>;
type Backend = 'say' | 'kokoro';
/* eslint-disable no-unused-vars */
type KokoroAudio = {
  audio: Float32Array;
  sampling_rate: number;
  save: (...args: [string]) => Promise<void> | void;
};
type KokoroStreamChunk = {
  text: string;
  phonemes: string;
  audio: KokoroAudio;
};
type KokoroTts = {
  generate: (...args: [string, { voice: string }]) => Promise<KokoroAudio>;
  stream: (
    ...args: [KokoroTextSplitterStream, { voice: string }]
  ) => AsyncIterable<KokoroStreamChunk>;
};
type KokoroTextSplitterStream = {
  push: (...text: string[]) => void;
  close(): void;
};
type KokoroModule = {
  KokoroTTS: {
    from_pretrained: (...args: [string, { dtype: 'q8'; device: 'cpu' }]) => Promise<KokoroTts>;
  };
  TextSplitterStream: new () => KokoroTextSplitterStream;
};
/* eslint-enable no-unused-vars */

const DEFAULT_SAY_OPTIONS: Required<SayOptions> = {
  voice: '',
  rate: 0,
  sayPath: '/usr/bin/say',
};
const DEFAULT_KOKORO_INITIAL_SILENCE_MS = 120;
const DEFAULT_KOKORO_BOUNDARY_SILENCE_MS = 350;
let kokoroTtsPromise: Promise<KokoroTts> | undefined;

function nowIso(): string {
  return new Date().toISOString();
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return value;
}

function envNumber(name: string, fallback: number): number {
  const value = finiteNumber(Number(Bun.env[name]));
  return value ?? fallback;
}

export function kokoroInitialSilenceMs(): number {
  return envNumber('NARRATION_KOKORO_INITIAL_SILENCE_MS', DEFAULT_KOKORO_INITIAL_SILENCE_MS);
}

export function kokoroBoundarySilenceMs(): number {
  return envNumber('NARRATION_KOKORO_BOUNDARY_SILENCE_MS', DEFAULT_KOKORO_BOUNDARY_SILENCE_MS);
}

function stringOption(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function silenceCommand(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return '';
  return ` [[slnc ${Math.round(ms)}]] `;
}

function normalizeSayOptions(base: SayOptions, override: SayOptions = {}): Required<SayOptions> {
  return {
    voice: stringOption(override.voice) ?? stringOption(base.voice) ?? DEFAULT_SAY_OPTIONS.voice,
    rate: finiteNumber(override.rate) ?? finiteNumber(base.rate) ?? DEFAULT_SAY_OPTIONS.rate,
    sayPath:
      stringOption(override.sayPath) ?? stringOption(base.sayPath) ?? DEFAULT_SAY_OPTIONS.sayPath,
  };
}

export function createSaySpeaker(): Speaker {
  return async (text: string, options: Required<SayOptions>): Promise<void> => {
    const args: string[] = [];
    if (options.voice) args.push('-v', options.voice);
    if (options.rate > 0) args.push('-r', String(options.rate));
    args.push(text);

    const proc = Bun.spawn([options.sayPath, ...args], {
      stdout: 'ignore',
      stderr: 'ignore',
    });

    const code = await proc.exited;
    if (code === 0) return;

    throw new Error(`say exited with code ${code}`);
  };
}

function kokoroVoice(value: string): string {
  if (/^[ab][fm]_[a-z0-9_]+$/i.test(value)) return value;
  return Bun.env.NARRATION_KOKORO_VOICE ?? 'bf_emma';
}

function ffplayPath(): string {
  return Bun.env.NARRATION_FFPLAY_PATH ?? '/opt/homebrew/bin/ffplay';
}

function pcmPlayerPath(): string {
  return (
    Bun.env.NARRATION_PCM_PLAYER_PATH ??
    join(dirname(fileURLToPath(import.meta.url)), 'snitch-pcm-player')
  );
}

function float32Bytes(audio: Float32Array): Uint8Array {
  return new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
}

function silenceBytes(sampleRate: number, durationMs: number): Uint8Array {
  return new Uint8Array(
    Math.round((sampleRate * durationMs) / 1000) * Float32Array.BYTES_PER_ELEMENT
  );
}

function writeAudioChunk(sink: Bun.FileSink, bytes: Uint8Array): Promise<void> | void {
  sink.write(bytes);
  return Promise.resolve(sink.flush()).then(() => undefined);
}

async function loadKokoroTts(): Promise<KokoroTts> {
  if (kokoroTtsPromise) return kokoroTtsPromise;

  kokoroTtsPromise = import('@huggingface/transformers').then(async (transformers) => {
    const { env } = transformers;
    if (Bun.env.NARRATION_KOKORO_CACHE_DIR) env.cacheDir = Bun.env.NARRATION_KOKORO_CACHE_DIR;

    const kokoro = await import('kokoro-js');
    const { KokoroTTS } = kokoro as unknown as KokoroModule;
    return (await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'cpu',
    })) as KokoroTts;
  });
  return kokoroTtsPromise;
}

async function playAudioFile(path: string): Promise<void> {
  const proc = Bun.spawn(['/usr/bin/afplay', path], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`afplay exited with code ${code}`);
}

export function createKokoroSpeaker(): Speaker {
  let splitterCtorPromise: Promise<new () => KokoroTextSplitterStream> | undefined;

  async function getTts(): Promise<KokoroTts> {
    return loadKokoroTts();
  }

  async function getTextSplitterStream(): Promise<new () => KokoroTextSplitterStream> {
    if (splitterCtorPromise) return splitterCtorPromise;

    splitterCtorPromise = import('kokoro-js').then((kokoro) => {
      const { TextSplitterStream } = kokoro as unknown as KokoroModule;
      return TextSplitterStream;
    });
    return splitterCtorPromise;
  }

  return async (text: string, options: Required<SayOptions>): Promise<void> => {
    if (Bun.env.NARRATION_KOKORO_STREAM !== '0') {
      const tts = await getTts();
      const TextSplitterStream = await getTextSplitterStream();
      if (Bun.env.NARRATION_KOKORO_PLAYBACK === 'ffplay') {
        await streamKokoroAudio(text, kokoroVoice(options.voice), tts, TextSplitterStream);
        return;
      }

      if (Bun.env.NARRATION_KOKORO_PLAYBACK !== 'afplay') {
        await streamKokoroToCoreAudio(text, kokoroVoice(options.voice), tts, TextSplitterStream);
        return;
      }

      await playKokoroChunks(text, kokoroVoice(options.voice), tts, TextSplitterStream);
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), 'narration-kokoro-'));
    const outputPath = join(dir, 'speech.wav');

    try {
      const tts = await getTts();
      const audio = await tts.generate(text, { voice: kokoroVoice(options.voice) });
      await audio.save(outputPath);

      await playAudioFile(outputPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function playKokoroChunks(
  text: string,
  voice: string,
  tts: KokoroTts,
  TextSplitterStream: new () => KokoroTextSplitterStream
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'narration-kokoro-chunks-'));
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice });

  try {
    splitter.push(text);
    splitter.close();

    let index = 0;
    let playback: Promise<void> = Promise.resolve();
    for await (const chunk of stream) {
      const outputPath = join(dir, `chunk-${index++}.wav`);
      await chunk.audio.save(outputPath);
      playback = playback.then(() => playAudioFile(outputPath));
    }

    await playback;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function streamKokoroToCoreAudio(
  text: string,
  voice: string,
  tts: KokoroTts,
  TextSplitterStream: new () => KokoroTextSplitterStream
): Promise<void> {
  const proc = Bun.spawn([pcmPlayerPath()], {
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'inherit',
    env: {
      ...Bun.env,
      NARRATION_PCM_SAMPLE_RATE: '24000',
    },
  });
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice });

  try {
    splitter.push(text);
    splitter.close();

    let wroteChunk = false;
    for await (const chunk of stream) {
      await writeAudioChunk(
        proc.stdin,
        silenceBytes(
          chunk.audio.sampling_rate,
          wroteChunk ? kokoroBoundarySilenceMs() : kokoroInitialSilenceMs()
        )
      );
      await writeAudioChunk(proc.stdin, float32Bytes(chunk.audio.audio));
      wroteChunk = true;
    }
  } finally {
    proc.stdin.end();
  }

  const code = await proc.exited;
  if (code !== 0) throw new Error(`pcm player exited with code ${code}`);
}

async function streamKokoroAudio(
  text: string,
  voice: string,
  tts: KokoroTts,
  TextSplitterStream: new () => KokoroTextSplitterStream
): Promise<void> {
  const proc = Bun.spawn(
    [
      ffplayPath(),
      '-f',
      'f32le',
      '-ar',
      '24000',
      '-ch_layout',
      'mono',
      '-nodisp',
      '-autoexit',
      '-loglevel',
      'quiet',
      'pipe:0',
    ],
    {
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    }
  );
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice });

  try {
    splitter.push(text);
    splitter.close();

    let wroteChunk = false;
    for await (const chunk of stream) {
      await writeAudioChunk(
        proc.stdin,
        silenceBytes(chunk.audio.sampling_rate, wroteChunk ? kokoroBoundarySilenceMs() : 1500)
      );
      await writeAudioChunk(proc.stdin, float32Bytes(chunk.audio.audio));
      wroteChunk = true;
    }
  } finally {
    proc.stdin.end();
  }

  const code = await proc.exited;
  if (code !== 0) throw new Error(`ffplay exited with code ${code}`);
}

export function normalizeNarrationRequest(input: unknown): NarrationRequest {
  if (!input || typeof input !== 'object') throw new Error('Request body must be an object');

  const raw = input as Record<string, unknown>;
  const steps = Array.isArray(raw.steps) ? raw.steps.map(normalizeStep) : undefined;
  const text = stringOption(raw.text);

  if (!steps && !text) throw new Error('Request body must include text or steps');

  return {
    id: stringOption(raw.id),
    text,
    steps,
    voice: stringOption(raw.voice),
    rate: finiteNumber(raw.rate),
    sayPath: stringOption(raw.sayPath),
    atMs: finiteNumber(raw.atMs),
    durationMs: finiteNumber(raw.durationMs),
  };
}

export function normalizeRenderNarrationRequest(input: unknown): RenderNarrationRequest {
  const request = normalizeNarrationRequest(input);
  const raw = input as Record<string, unknown>;
  return {
    ...request,
    outputPath: stringOption(raw.outputPath),
  };
}

function normalizeStep(input: unknown): NarrationStep {
  if (!input || typeof input !== 'object') throw new Error('Each step must be an object');

  const raw = input as Record<string, unknown>;
  const type = stringOption(raw.type) ?? 'say';
  if (type === 'pause') {
    const pauseMs = finiteNumber(raw.pauseMs) ?? finiteNumber(raw.durationMs);
    if (pauseMs === undefined) throw new Error('Pause steps require pauseMs or durationMs');

    return {
      type: 'pause',
      pauseMs,
      durationMs: pauseMs,
      atMs: finiteNumber(raw.atMs),
    };
  }

  if (type !== 'say') throw new Error(`Unsupported step type: ${type}`);

  const text = stringOption(raw.text);
  if (!text) throw new Error('Say steps require text');

  return {
    type: 'say',
    text,
    voice: stringOption(raw.voice),
    rate: finiteNumber(raw.rate),
    sayPath: stringOption(raw.sayPath),
    atMs: finiteNumber(raw.atMs),
    durationMs: finiteNumber(raw.durationMs),
  };
}

function stepsFromRequest(request: NarrationRequest): NarrationStep[] {
  if (request.steps) return request.steps;
  if (!request.text) return [];

  return [
    {
      type: 'say',
      text: request.text,
      atMs: request.atMs,
      durationMs: request.durationMs,
    },
  ];
}

export function narrationTextForRendering(request: NarrationRequest): string {
  const steps = stepsFromRequest(request);
  const chunks: string[] = [];
  let cursorMs = 0;

  for (const step of steps) {
    const atMs = finiteNumber(step.atMs);
    if (atMs !== undefined && atMs > cursorMs) {
      chunks.push(silenceCommand(atMs - cursorMs));
      cursorMs = atMs;
    }

    if (step.type === 'pause') {
      const pauseMs = step.pauseMs ?? step.durationMs ?? 0;
      chunks.push(silenceCommand(pauseMs));
      cursorMs += pauseMs;
      continue;
    }

    chunks.push(step.text);
    if (step.durationMs !== undefined) {
      chunks.push(silenceCommand(step.durationMs));
      cursorMs += step.durationMs;
    }
  }

  return chunks.join(' ').trim();
}

export function createSayAudioRenderer(): AudioRenderer {
  return async (request: RenderNarrationRequest): Promise<Uint8Array> => {
    const dir = await mkdtemp(join(tmpdir(), 'snitch-service-'));
    const outputPath = request.outputPath ?? join(dir, 'narration.aiff');
    const options = normalizeSayOptions(request);
    const args: string[] = ['-o', outputPath];
    if (options.voice) args.push('-v', options.voice);
    if (options.rate > 0) args.push('-r', String(options.rate));
    args.push(narrationTextForRendering(request));

    try {
      const proc = Bun.spawn([options.sayPath, ...args], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const code = await proc.exited;
      if (code !== 0) throw new Error(`say exited with code ${code}`);

      return new Uint8Array(await readFile(outputPath));
    } finally {
      if (!request.outputPath) await rm(dir, { recursive: true, force: true });
    }
  };
}

function floatSilence(sampleRate: number, durationMs: number): Float32Array {
  return new Float32Array(Math.round((sampleRate * durationMs) / 1000));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function wavBytesForFloat32(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const dataSize = sampleCount * Int16Array.BYTES_PER_ELEMENT;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * Int16Array.BYTES_PER_ELEMENT, true);
  view.setUint16(32, Int16Array.BYTES_PER_ELEMENT, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, Math.round(clamped * 32767), true);
      offset += Int16Array.BYTES_PER_ELEMENT;
    }
  }

  return bytes;
}

export function createKokoroAudioRenderer(): AudioRenderer {
  return async (request: RenderNarrationRequest): Promise<Uint8Array> => {
    const tts = await loadKokoroTts();
    const chunks: Float32Array[] = [];
    let cursorMs = 0;
    let sampleRate = 24000;

    for (const step of stepsFromRequest(request)) {
      const atMs = finiteNumber(step.atMs);
      if (atMs !== undefined && atMs > cursorMs) {
        chunks.push(floatSilence(sampleRate, atMs - cursorMs));
        cursorMs = atMs;
      }

      if (step.type === 'pause') {
        const pauseMs = step.pauseMs ?? step.durationMs ?? 0;
        chunks.push(floatSilence(sampleRate, pauseMs));
        cursorMs += pauseMs;
        continue;
      }

      const audio = await tts.generate(step.text, {
        voice: kokoroVoice(step.voice ?? request.voice ?? ''),
      });
      sampleRate = audio.sampling_rate;
      chunks.push(audio.audio);
      const generatedMs = (audio.audio.length / sampleRate) * 1000;
      const durationMs = finiteNumber(step.durationMs);
      if (durationMs !== undefined && durationMs > generatedMs) {
        chunks.push(floatSilence(sampleRate, durationMs - generatedMs));
      }
      cursorMs += durationMs ?? generatedMs;
    }

    return wavBytesForFloat32(chunks, sampleRate);
  };
}

export class NarrationService {
  private current: Promise<void> = Promise.resolve();
  private readonly jobs = new Map<string, NarrationJob>();
  private readonly speaker: Speaker;
  private readonly audioRenderer: AudioRenderer;
  private readonly renderMimeType: string;
  private readonly renderFilename: string;

  constructor(
    speaker: Speaker = createSaySpeaker(),
    audioRenderer: AudioRenderer = createSayAudioRenderer(),
    renderMimeType = 'audio/aiff',
    renderFilename = 'narration.aiff'
  ) {
    this.speaker = speaker;
    this.audioRenderer = audioRenderer;
    this.renderMimeType = renderMimeType;
    this.renderFilename = renderFilename;
  }

  enqueue(request: NarrationRequest): NarrationJob {
    const id = request.id ?? crypto.randomUUID();
    const timestamp = nowIso();
    const job: NarrationJob = {
      id,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.jobs.set(id, job);
    this.current = this.current
      .catch(() => undefined)
      .then(async () => {
        await this.runJob(job, request);
      });

    return job;
  }

  getJob(id: string): NarrationJob | undefined {
    return this.jobs.get(id);
  }

  async render(request: RenderNarrationRequest): Promise<Uint8Array> {
    const audio = await this.audioRenderer(request);
    if (request.outputPath) await writeFile(request.outputPath, audio);
    return audio;
  }

  getRenderHeaders(): Record<string, string> {
    return {
      'content-type': this.renderMimeType,
      'content-disposition': `attachment; filename="${this.renderFilename}"`,
    };
  }

  private async runJob(job: NarrationJob, request: NarrationRequest): Promise<void> {
    this.updateJob(job, 'running');
    const started = Date.now();
    const baseOptions = normalizeSayOptions(request);

    try {
      for (const step of stepsFromRequest(request)) {
        const atMs = finiteNumber(step.atMs) ?? 0;
        await delay(started + atMs - Date.now());
        await this.runStep(step, baseOptions);
      }

      this.updateJob(job, 'completed');
    } catch (error) {
      this.updateJob(job, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  private async runStep(step: NarrationStep, baseOptions: Required<SayOptions>): Promise<void> {
    if (step.type === 'pause') {
      await delay(step.pauseMs ?? step.durationMs ?? 0);
      return;
    }

    const started = Date.now();
    await this.speaker(step.text, normalizeSayOptions(baseOptions, step));

    const durationMs = finiteNumber(step.durationMs);
    if (durationMs === undefined) return;

    await delay(durationMs - (Date.now() - started));
  }

  private updateJob(job: NarrationJob, status: NarrationJobStatus, error?: string): void {
    job.status = status;
    job.error = error;
    job.updatedAt = nowIso();
  }
}

export function createNarrationServiceForBackend(backend: Backend): NarrationService {
  if (backend === 'kokoro') {
    return new NarrationService(
      createKokoroSpeaker(),
      createKokoroAudioRenderer(),
      'audio/wav',
      'narration.wav'
    );
  }
  return new NarrationService(createSaySpeaker());
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function createNarrationServer(service = new NarrationService()) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/v1/narration') {
      try {
        const body = await request.json();
        const job = service.enqueue(normalizeNarrationRequest(body));
        return json(job, 202);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (request.method === 'POST' && url.pathname === '/v1/narration/render') {
      try {
        const body = await request.json();
        const renderRequest = normalizeRenderNarrationRequest(body);
        const audio = await service.render(renderRequest);
        return new Response(audio, {
          status: 200,
          headers: {
            ...service.getRenderHeaders(),
            ...(renderRequest.outputPath ? { 'x-output-path': renderRequest.outputPath } : {}),
          },
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/jobs/')) {
      const id = decodeURIComponent(url.pathname.slice('/v1/jobs/'.length));
      const job = service.getJob(id);
      if (!job) return json({ error: 'Job not found' }, 404);

      return json(job);
    }

    return json({ error: 'Not found' }, 404);
  };
}

export function startNarrationServer(options: { port?: number; hostname?: string } = {}) {
  return Bun.serve({
    port: options.port ?? 4766,
    hostname: options.hostname ?? '127.0.0.1',
    fetch: createNarrationServer(),
  });
}

if (import.meta.main) {
  const port = Number(Bun.env.NARRATION_PORT ?? 4766);
  const hostname = Bun.env.NARRATION_HOST ?? '127.0.0.1';
  const backend = Bun.env.NARRATION_BACKEND === 'kokoro' ? 'kokoro' : 'say';
  const server = Bun.serve({
    port,
    hostname,
    fetch: createNarrationServer(createNarrationServiceForBackend(backend)),
  });
  process.stdout.write(`Narration service listening on http://${server.hostname}:${server.port}\n`);
}
