import type { TuiPlugin } from '@opencode-ai/plugin/tui';

import {
  narrationEnabled,
  normalizeOptions,
  setRuntimeNarrationEnabled,
  toggleRuntimeNarration,
} from './core.ts';

export const NarrationTuiPlugin: TuiPlugin = async (api, rawOptions) => {
  const options = normalizeOptions(rawOptions, process.cwd());

  if (!api.command) {
    api.ui.toast({
      variant: 'warning',
      title: 'Narration',
      message: 'This OpenCode version does not expose the TUI command API.',
    });
    return;
  }

  const showStatus = async (): Promise<void> => {
    const enabled = await narrationEnabled(options);
    api.ui.toast({
      variant: enabled ? 'success' : 'warning',
      title: 'Narration',
      message: enabled ? 'Narration is on.' : 'Narration is off.',
    });
  };

  const unregister = api.command.register(() => [
    {
      title: 'Toggle Narration',
      value: 'narration.toggle',
      description: 'Turn narration on or off for this workspace',
      category: 'Narration',
      keybind: 'ctrl+shift+n',
      onSelect: async (dialog) => {
        dialog?.clear();
        const enabled = await toggleRuntimeNarration(options);
        api.ui.toast({
          variant: enabled ? 'success' : 'warning',
          title: 'Narration',
          message: enabled ? 'Narration is on.' : 'Narration is off.',
        });
      },
    },
    {
      title: 'Enable Narration',
      value: 'narration.enable',
      description: 'Remove the narration off switch file',
      category: 'Narration',
      onSelect: async (dialog) => {
        dialog?.clear();
        await setRuntimeNarrationEnabled(options, true);
        await showStatus();
      },
    },
    {
      title: 'Disable Narration',
      value: 'narration.disable',
      description: 'Create the narration off switch file',
      category: 'Narration',
      onSelect: async (dialog) => {
        dialog?.clear();
        await setRuntimeNarrationEnabled(options, false);
        await showStatus();
      },
    },
  ]);

  api.lifecycle.onDispose(unregister);
};

export const tui = NarrationTuiPlugin;

const plugin = {
  id: 'opencode-plugin-snitch-tui',
  tui,
};

export default plugin;
