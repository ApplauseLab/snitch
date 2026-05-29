---
name: snitch
description: Record audio, generate narration, create voiceovers, render speech files, produce audio bytes, or add synchronized audio to UI demos. Use when the user asks to record audio for something, create a narrated demo, generate a voiceover, save speech to a file, return binary audio, or use Snitch directly.
---

# Snitch

Use Snitch when the user wants local speech, a narrated demo, a voiceover track, rendered audio bytes, or an audio file for a recording.

Before using Snitch for anything beyond a trivial health check, run:

```bash
snitch skill
```

If `snitch` is not on PATH, use:

```bash
bunx github:ApplauseLab/snitch#main skill
```

Read the output and follow it. It documents the local HTTP API, including:

- queued playback with `POST /v1/narration`
- job polling with `GET /v1/jobs/:id`
- timed narration steps with `atMs` and pauses
- rendered audio bytes with `POST /v1/narration/render`
- saving rendered audio to a file with `outputPath`
- JavaScript `arrayBuffer()` usage for binary bytes
- voice and rate options

## Common Workflow

For a narrated UI demo:

1. Record the UI video.
2. Build a timed Snitch `steps` payload matching the video timeline.
3. Render the audio with `/v1/narration/render`.
4. Merge the video and audio with `ffmpeg`.

Prefer Kokoro voices such as `bf_emma` when Snitch is running with the Kokoro backend.

Keep narration concise. Do not speak secrets, raw stack traces, long commands, or large code blocks unless the user explicitly asks.
