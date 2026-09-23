# SillyTavern ↔ Claude cloud bridge

A small local server that looks like an OpenAI-compatible API to SillyTavern.
Each request is answered by a **Claude Code cloud session** (`claude -p --cloud`),
so it runs on your cloud-session usage/credits instead of local Claude Code usage.

It runs next to your existing bridge. It listens on its own port (5055 by default),
so the two don't clash.

## Requirements

- Node.js 18+
- The Claude Code CLI (`claude`), a recent version, logged in to the account that holds
  the cloud credits (`claude` → `/login`)
- Claude Code on the web set up for that account (a cloud environment exists at
  claude.ai/code)

Check that cloud mode works from your terminal first:

```bash
echo "Say hi in five words." | claude -p --cloud
```

If that prints an answer, the bridge will work.

## Run

```bash
cd cloud-bridge
npm start
```

No `npm install` is needed; there are no dependencies.

## Connect SillyTavern

1. **API Connections** → API: **Chat Completion**
2. Chat Completion Source: **Custom (OpenAI-compatible)**
3. Custom Endpoint (Base URL): `http://127.0.0.1:5055/v1`
4. API key: leave empty (or the value of `BRIDGE_API_KEY` if you set one)
5. Click **Connect**, then pick the model `claude-cloud`.

Streaming can be on or off. The full reply arrives at once either way, because a cloud
session only returns its final answer.

## What to expect

- **Slow replies.** Every message starts a cloud container, so expect roughly 30 seconds
  to a few minutes per reply. The bridge sends keep-alives while streaming so SillyTavern
  doesn't give up. If you use non-streaming mode, raise SillyTavern's request timeout.
- **One new cloud session per message.** Each one shows up in your claude.ai/code session
  list, named `SillyTavern`. You can archive them from there.
- **Each message costs more than a plain API call.** The cloud session runs Claude
  Code's own agent, so every turn carries Claude Code's system prompt on top of your chat.
  The bridge tells the agent not to use tools, but the base overhead remains.
- **SillyTavern model settings don't pass through.** The cloud session uses its own
  model and settings. Temperature and similar samplers are ignored. `max_tokens` and
  `stop` are passed along as instructions, and stop strings are also trimmed off the reply.

## Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_PORT` | `5055` | Port to listen on |
| `BRIDGE_HOST` | `127.0.0.1` | Interface to bind (use `0.0.0.0` for LAN access, and set a key) |
| `BRIDGE_API_KEY` | *(none)* | If set, requests must send it as `Authorization: Bearer <key>` |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `CLAUDE_EXTRA_ARGS` | *(none)* | Extra CLI flags, e.g. `--model claude-sonnet-5` |
| `BRIDGE_TIMEOUT_MS` | `900000` | Give up on a cloud turn after this long (15 min) |
| `BRIDGE_MAX_CONCURRENT` | `1` | Cloud sessions allowed to run at the same time; extra requests wait |
| `BRIDGE_SESSION_NAME` | `SillyTavern` | Name given to the cloud sessions |
| `BRIDGE_WORKDIR` | `<tmp>/st-cloud-bridge` | Empty folder the sessions start from (so none of your files get synced) |
| `BRIDGE_MODEL_ID` | `claude-cloud` | Model name shown to SillyTavern |
| `BRIDGE_DEBUG` | *(off)* | `1` logs the CLI's stderr and every reply |

Windows (PowerShell): `$env:BRIDGE_PORT=5056; npm start`

## Troubleshooting

- **`could not start "claude"`**: set `CLAUDE_BIN` to the full path (`where claude` / `which claude`).
- **`claude exited with code 1 … needs a task` / unknown option `--cloud`**: update the CLI (`claude update`).
- **`The cloud session failed to start` / `Unable to create cloud session`**: open
  claude.ai/code and check that you can start a cloud session there, with credits available.
- **The reply includes stray text or goes off-format**: run with `BRIDGE_DEBUG=1` and look
  at what the session returned.

## Tests

`npm test` runs the bridge against a fake `claude` binary. It uses no credits.
