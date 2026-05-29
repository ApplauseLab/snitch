# Snitch

![Snitch logo](docs/snitch-logo.svg)

Snitch listens for your OpenCode sessions and snitches them to you using Kokoro. It installs an OpenCode plugin, a local narration service, a macOS LaunchAgent, and a CoreAudio playback helper for hands-free sessions.

## Install

```bash
bunx snitch init
```

`snitch init` installs the durable runtime under `~/.snitch`, configures OpenCode, and creates a LaunchAgent named `ai.applauselab.snitch`.

Useful flags:

```bash
snitch init --scope project --backend kokoro
snitch init --scope global --backend say
snitch init --skip-install --skip-model-download
```

Restart OpenCode after init so it reloads plugin and TUI configuration.

## Runtime Layout

- `~/.snitch/service/` - stable service entrypoint and CoreAudio helper
- `~/.snitch/opencode-plugin/` - stable OpenCode plugin entrypoints
- `~/.snitch/runtime/` - private package-manager install area
- `~/.snitch/models/kokoro/` - Kokoro model cache used by Hugging Face Transformers
- `~/.snitch/logs/` - LaunchAgent stdout/stderr logs
- `~/Library/LaunchAgents/ai.applauselab.snitch.plist` - macOS service entry

## Development

- `bun run build` - Build all packages and the Swift CoreAudio helper
- `bun test` - Run tests
- `bun run typecheck` - Type-check the workspace
- `bun run lint` - Lint code
- `bun run service` - Start the narration service locally

## License

See `LICENSE` for details.
