import type { Plugin } from '@opencode-ai/plugin';

import { createNarrationHooks, createServiceQueue, normalizeOptions } from './core.ts';

export const NarrationPlugin: Plugin = async (_input, rawOptions) => {
  const options = normalizeOptions(rawOptions, _input.worktree ?? _input.directory);
  return createNarrationHooks(options, createServiceQueue(options));
};

export const server = NarrationPlugin;
export default NarrationPlugin;
