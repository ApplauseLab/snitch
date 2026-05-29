import { rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { Event, Part } from '@opencode-ai/sdk';

export type NarrationOptions = {
  enabled?: boolean;
  instructions?: boolean;
  voice?: string;
  rate?: number;
  serviceUrl?: string;
  tags?: string[];
  fenceLanguages?: string[];
  toggleFile?: string;
};

type NarrationRequest = {
  text: string;
  voice?: string;
  rate?: number;
};

type NarrationBlock = {
  index: number;
  text: string;
};

// ESLint's base no-unused-vars checks type-only function parameter names.
// eslint-disable-next-line no-unused-vars
export type QueueNarration = (text: string) => Promise<void>;

const DEFAULT_TAGS = ['narration'];
const DEFAULT_FENCE_LANGUAGES = ['narration', 'narrate', 'voiceover', 'voice-over'];
export const NARRATION_SYSTEM_INSTRUCTION = [
  'Use <narration>...</narration> blocks as the spoken channel for a hands-free OpenCode conversation.',
  'The user may be away from the screen and listening through AirPods, so narrate important progress, decisions, blockers, and questions in plain conversational language.',
  'Use narration proactively between visible turns so the user is not left in silence during long work.',
  'Narrate when starting a non-trivial task, after important discoveries, before substantial edits, before/after verification, when waiting on tools, when a command fails, and when you need user input.',
  'Keep narration concise and useful: one or two short sentences about what you are doing now, what just completed, what failed, or what input you need from the user.',
  'Do not narrate slash commands, exact shell commands, stack traces, file paths, raw code, secrets, or noisy implementation details unless the user explicitly asks to hear them.',
  'Do not mention the narration tag itself. The visible answer can stay technical; the narration block should be optimized for listening.',
].join(' ');

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;

  const items = value.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== ''
  );
  return items.length === 0 ? fallback : items;
}

function numberOption(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function stringOption(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function normalizeOptions(
  options: Record<string, unknown> | undefined,
  baseDir = process.cwd()
): Required<NarrationOptions> {
  const toggleFile = stringOption(options?.toggleFile) ?? '.opencode-snitch-off';

  return {
    enabled: options?.enabled !== false,
    instructions: options?.instructions !== false,
    voice: stringOption(options?.voice) ?? '',
    rate: numberOption(options?.rate) ?? 0,
    serviceUrl: stringOption(options?.serviceUrl) ?? 'http://127.0.0.1:4766',
    tags: stringList(options?.tags, DEFAULT_TAGS),
    fenceLanguages: stringList(options?.fenceLanguages, DEFAULT_FENCE_LANGUAGES),
    toggleFile: isAbsolute(toggleFile) ? toggleFile : resolve(baseDir, toggleFile),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueBlocks(blocks: NarrationBlock[]): NarrationBlock[] {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    const key = `${block.index}\0${block.text}`;
    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

export function extractNarrationBlocks(
  text: string,
  options: Pick<Required<NarrationOptions>, 'tags' | 'fenceLanguages'> = {
    tags: DEFAULT_TAGS,
    fenceLanguages: DEFAULT_FENCE_LANGUAGES,
  }
): NarrationBlock[] {
  const blocks: NarrationBlock[] = [];

  for (const tag of options.tags) {
    const escaped = escapeRegex(tag);
    const pattern = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi');
    for (const match of text.matchAll(pattern)) {
      const content = match[1]?.trim();
      if (!content) continue;

      blocks.push({ index: match.index ?? 0, text: content });
    }
  }

  const languages = options.fenceLanguages.map(escapeRegex).join('|');
  if (languages === '') return uniqueBlocks(blocks).sort((a, b) => a.index - b.index);

  const fencePattern = new RegExp(
    '(^|\\n)```(?:' + languages + ')[^\\n]*\\n([\\s\\S]*?)\\n```',
    'gi'
  );
  for (const match of text.matchAll(fencePattern)) {
    const content = match[2]?.trim();
    if (!content) continue;

    blocks.push({ index: (match.index ?? 0) + match[1].length, text: content });
  }

  return uniqueBlocks(blocks).sort((a, b) => a.index - b.index);
}

export function createServiceQueue(options: Required<NarrationOptions>): QueueNarration {
  return async (text: string): Promise<void> => {
    const request: NarrationRequest = {
      text,
      voice: options.voice || undefined,
      rate: options.rate || undefined,
    };

    await fetch(new URL('/v1/narration', options.serviceUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  };
}

export async function narrationEnabled(options: Required<NarrationOptions>): Promise<boolean> {
  if (!options.enabled) return false;

  return !(await Bun.file(options.toggleFile).exists());
}

export async function setRuntimeNarrationEnabled(
  options: Required<NarrationOptions>,
  enabled: boolean
): Promise<boolean> {
  if (enabled) await rm(options.toggleFile, { force: true });
  else await Bun.write(options.toggleFile, 'off\n');

  return narrationEnabled(options);
}

export async function toggleRuntimeNarration(
  options: Required<NarrationOptions>
): Promise<boolean> {
  return setRuntimeNarrationEnabled(options, !(await narrationEnabled(options)));
}

function textFromEvent(event: Event): { key: string; text: string } | undefined {
  if (event.type !== 'message.part.updated') return undefined;

  const part: Part = event.properties.part;
  if (part.type !== 'text') return undefined;

  return {
    key: `${part.sessionID}:${part.messageID}:${part.id}`,
    text: part.text,
  };
}

export function createNarrationHooks(
  options: Required<NarrationOptions>,
  queueNarration: QueueNarration
) {
  const queued = new Set<string>();

  return {
    'experimental.chat.system.transform': async (_input: unknown, output: { system: string[] }) => {
      if (!options.instructions || !(await narrationEnabled(options))) return;
      output.system.push(NARRATION_SYSTEM_INSTRUCTION);
    },
    event: async ({ event }: { event: Event }): Promise<void> => {
      if (!(await narrationEnabled(options))) return;

      const part = textFromEvent(event);
      if (!part) return;

      const blocks = extractNarrationBlocks(part.text, options);
      for (const block of blocks) {
        const key = `${part.key}:${block.index}:${block.text}`;
        if (queued.has(key)) continue;

        queued.add(key);
        await queueNarration(block.text);
      }
    },
  };
}
