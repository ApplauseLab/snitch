# Snitch

![Snitch logo](docs/snitch-logo.svg)

Snitch listens for your OpenCode sessions and snitches them to you using Kokoro. It installs an OpenCode plugin, a local narration service, a macOS LaunchAgent, and a CoreAudio playback helper for hands-free sessions.

## Install

```bash
bunx github:ApplauseLab/snitch#main init
```

`snitch init` installs the durable runtime under `~/.snitch`, configures OpenCode, and creates a LaunchAgent named `ai.applauselab.snitch`.

Useful flags:

```bash
snitch init --scope project --backend kokoro
snitch init --scope global --backend say
snitch init --skip-install --skip-model-download
```

Restart OpenCode after init so it reloads plugin and TUI configuration.

## Configuration

Snitch writes OpenCode plugin configuration during `snitch init`. You can edit the generated config afterward if you want a different voice, custom narration tags, a different service URL, or a runtime toggle path.

Global config files live in `~/.config/opencode/`. Project config files live in `opencode.json` and `.opencode/tui.json` in the project.

### Server Plugin

The server plugin watches OpenCode assistant text events, extracts narration blocks, and posts them to the local Snitch service.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "/Users/you/.snitch/opencode-plugin/index.js",
      {
        "backend": "kokoro",
        "serviceUrl": "http://127.0.0.1:4766",
        "voice": "bf_emma",
        "tags": ["narration"],
        "fenceLanguages": ["narration", "narrate", "voiceover", "voice-over"],
        "toggleFile": ".opencode-snitch-off"
      }
    ]
  ]
}
```

Plugin options:

| Option           | Default                                               | Description                                                                                                               |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `enabled`        | `true`                                                | Hard-disables the plugin when set to `false`.                                                                             |
| `instructions`   | `true`                                                | Injects system guidance telling the model to use concise `<narration>` blocks.                                            |
| `voice`          | `""`                                                  | Optional voice passed to the service. For Kokoro, use voices like `bf_emma`; for `say`, use macOS voices like `Samantha`. |
| `rate`           | `0`                                                   | Optional speech rate. Mainly useful with the macOS `say` backend.                                                         |
| `serviceUrl`     | `http://127.0.0.1:4766`                               | Local Snitch service URL.                                                                                                 |
| `tags`           | `["narration"]`                                       | XML-style tags to extract from model output.                                                                              |
| `fenceLanguages` | `["narration", "narrate", "voiceover", "voice-over"]` | Markdown code fence languages to extract.                                                                                 |
| `toggleFile`     | `.opencode-snitch-off`                                | File whose presence disables narration. Relative paths resolve from the worktree/config base.                             |

### TUI Plugin

The TUI plugin adds commands for toggling narration from OpenCode.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "/Users/you/.snitch/opencode-plugin/tui.js",
      {
        "toggleFile": ".opencode-snitch-off"
      }
    ]
  ]
}
```

Commands:

| Command             | Effect                                                                |
| ------------------- | --------------------------------------------------------------------- |
| `Toggle Narration`  | Toggles narration for the current workspace. Bound to `ctrl+shift+n`. |
| `Enable Narration`  | Removes the toggle file.                                              |
| `Disable Narration` | Creates the toggle file.                                              |

### Narration Syntax

The default syntax is an XML-style tag:

```xml
<narration>I am checking the logs and will tell you when I find the failure.</narration>
```

Fenced blocks also work:

````markdown
```narration
The build passed. I am starting the install smoke test now.
```
````

Use custom tags if you prefer a different convention:

```json
{
  "tags": ["voice", "spoken"],
  "fenceLanguages": ["voice", "spoken"]
}
```

## Voices And Backends

Snitch supports two speech backends: Kokoro and macOS `say`.

### Kokoro Voices

Kokoro is the default backend:

```bash
bunx github:ApplauseLab/snitch#main init --scope global --backend kokoro
```

The default Kokoro voice is `bf_emma`. Configure a voice in the server plugin options:

```json
{
  "backend": "kokoro",
  "voice": "bf_emma"
}
```

Common Kokoro voices included by `kokoro-js`:

| Voice        | Accent           | Gender | Notes                                            |
| ------------ | ---------------- | ------ | ------------------------------------------------ |
| `bf_emma`    | British English  | Female | Snitch default.                                  |
| `af_jessica` | American English | Female | Original Snitch default.                         |
| `af_heart`   | American English | Female | Strong general-purpose default from Kokoro docs. |
| `af_bella`   | American English | Female | Higher-quality expressive voice.                 |
| `af_nicole`  | American English | Female | Softer voice.                                    |
| `af_sarah`   | American English | Female | Clear general voice.                             |
| `am_michael` | American English | Male   | Clear male voice.                                |
| `am_fenrir`  | American English | Male   | Alternative male voice.                          |
| `bm_george`  | British English  | Male   | British male voice.                              |

Any Kokoro voice name matching the `bf_emma` style pattern is passed through to Kokoro. If no plugin voice is set, the service uses `NARRATION_KOKORO_VOICE` and then falls back to `bf_emma`.

### macOS `say` Voices

Use the `say` backend if you want built-in macOS voices or a simpler fallback:

```bash
bunx github:ApplauseLab/snitch#main init --scope global --backend say
```

Example plugin options:

```json
{
  "backend": "say",
  "voice": "Samantha",
  "rate": 185
}
```

List installed macOS voices with:

```bash
say -v '?'
```

## Runtime Controls

The LaunchAgent starts the Snitch service at login and keeps it alive. Restart OpenCode after changing plugin config; restart the LaunchAgent after changing service environment variables.

Common commands:

```bash
curl http://127.0.0.1:4766/health
launchctl print gui/$(id -u)/ai.applauselab.snitch
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.applauselab.snitch.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.applauselab.snitch.plist
```

Useful service environment variables:

| Variable                               | Description                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `NARRATION_BACKEND`                    | `kokoro` or `say`. Written by init.                                                                 |
| `NARRATION_PORT`                       | Service port. Defaults to `4766`.                                                                   |
| `NARRATION_HOST`                       | Bind host. Defaults to `127.0.0.1`.                                                                 |
| `NARRATION_KOKORO_CACHE_DIR`           | Hugging Face/Kokoro cache directory. Written by init.                                               |
| `NARRATION_KOKORO_VOICE`               | Default Kokoro voice when the plugin does not provide one.                                          |
| `NARRATION_KOKORO_PLAYBACK`            | Set to `afplay` or `ffplay` for fallback playback modes. Unset uses the CoreAudio helper.           |
| `NARRATION_KOKORO_STREAM`              | Set to `0` to generate full WAV files instead of streaming chunks.                                  |
| `NARRATION_KOKORO_INITIAL_SILENCE_MS`  | Silence inserted before the first streamed Kokoro chunk. Defaults to `120`.                         |
| `NARRATION_KOKORO_BOUNDARY_SILENCE_MS` | Silence inserted between streamed Kokoro sentence chunks to avoid clipped words. Defaults to `350`. |
| `NARRATION_PCM_PLAYER_PATH`            | Override path to the CoreAudio helper.                                                              |
| `NARRATION_FFPLAY_PATH`                | Override path to `ffplay`; default is `/opt/homebrew/bin/ffplay`.                                   |

## Runtime Layout

- `~/.snitch/service/` - stable service entrypoint and CoreAudio helper
- `~/.snitch/opencode-plugin/` - stable OpenCode plugin entrypoints
- `~/.snitch/runtime/` - private package-manager install area
- `~/.snitch/models/kokoro/` - Kokoro model cache used by Hugging Face Transformers
- `~/.snitch/logs/` - LaunchAgent stdout/stderr logs
- `~/Library/LaunchAgents/ai.applauselab.snitch.plist` - macOS service entry

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the plugin flow, runtime layout, installer behavior, service API, and Mermaid diagrams.

## Development

- `bun run build` - Build all packages and the Swift CoreAudio helper
- `bun test` - Run tests
- `bun run typecheck` - Type-check the workspace
- `bun run lint` - Lint code
- `bun run service` - Start the narration service locally

## License

See `LICENSE` for details.
