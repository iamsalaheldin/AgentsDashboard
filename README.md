# cmux Mission Control

A local, real-time dashboard for everything running inside [cmux](https://cmux.com) on macOS:
every window, workspace, pane and tab, which AI agents are working or waiting, what needs
your attention, and what changed — with one click back to the right tab in cmux.

It complements cmux rather than replacing it: cmux runs the terminals and agent integrations;
Mission Control adds **cross-workspace visibility, activity aggregation and actionable
summaries**. It only shows data cmux actually reports. When something isn't available, it
says so and does not guess.

- **Overview**: KPIs, workspace cards, agent table, Attention Center, 24 h activity chart, and recent activity with "new since you last looked"
- **Workspaces**: grouped by window and filterable; the detail page shows the real Window → Workspace → Pane → Tab → Agent hierarchy
- **Agents**: every agent session cmux knows about, with its normalized state and the source state alongside
- **Attention**: permission requests, questions, plan approvals, agents waiting for input, failed turns, terminal errors and unread notifications
- **Activity**: a filterable, persistent timeline (by workspace, agent, event type and status)
- **Settings**: connection diagnostics, which cmux interfaces were verified, the privacy toggle and local history

## Requirements

- macOS with cmux installed (verified against **cmux 0.65.2**)
- Node.js **≥ 22.18** (the server runs TypeScript natively and uses the built-in `node:sqlite`; no native modules)

## Quick start

cmux's socket defaults to **"cmux processes only"**, so Mission Control must be started
**from a cmux terminal**. It never changes that setting.

```bash
npm install
```

```bash
npm run build
```

Then, in a cmux terminal, either run the server in place:

```bash
npm start
```

or open it in its own "Mission Control" cmux workspace:

```bash
npm run cmux:launch
```

Open <http://127.0.0.1:4317>.

| Command | What it does |
| --- | --- |
| `npm run dev` | Backend with `--watch` + Vite dev server on <http://127.0.0.1:5173> (run inside cmux) |
| `npm run build` | Type-check server and web, build the UI into `dist/web` |
| `npm start` | Production server on `127.0.0.1:4317` serving the built UI |
| `npm run cmux:launch` | Start the production server in a dedicated cmux workspace |
| `npm test` | Vitest unit + integration tests |
| `npm run test:e2e` | Build the UI and run the Playwright smoke tests |
| `npm run typecheck` | Strict TypeScript for server and web |
| `npm run verify:live` | Check Mission Control against your **real** running cmux (run inside cmux) |

Environment variables: `MC_PORT` (default 4317), `MC_HOST` (loopback only: `127.0.0.1`, `::1`, `localhost`),
`MC_DATA_DIR` (default `~/.cmux-mission-control`), `CMUX_SOCKET_PATH` (set automatically inside cmux),
`MC_LOG_LEVEL` (`debug|info|warn|error`).

## How it works

```
cmux ──Unix socket──▶ EventStream (events.stream, replay, heartbeats)
                     SocketRpc   (system.tree, extension.sidebar.snapshot, current.list,
                                  feed.list, notification.list)
        ▼
StateManager (normalized windows/workspaces/panes/tabs/agents, attention, summaries)
        ├── ActivityStore (node:sqlite, bounded)
        ▼
HTTP on 127.0.0.1 — JSON + Server-Sent Events ──▶ React dashboard
```

Updates are event-driven. The backend subscribes to cmux's event stream with sequence-based
resume. Each event updates the timeline immediately, and triggers a debounced re-read of the
relevant cmux snapshot so cmux's own model stays authoritative. Replay gaps, cmux restarts,
stalled streams and dropped connections all trigger reconnection and a full resync. The UI
marks data as stale whenever it might not reflect cmux. Details are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and the verified cmux interfaces, with the data
source for every feature, are in [docs/CAPABILITIES.md](docs/CAPABILITIES.md).

### What the states mean

| Shown as | Meaning | Source |
| --- | --- | --- |
| Working | cmux reports the agent mid-turn | `current.list`, `UserPromptSubmit`/`PreToolUse` hooks |
| Needs attention | Waiting on you: a permission request, question or input prompt | Feed pending item, `current.list` `needs_input` |
| Idle | The agent stopped generating. **A finished turn is not a finished task**, and background work may continue. | `Stop` hook, `current.list` `idle` |
| Ended | Session ended | `SessionEnd` hook |
| Error | The turn failed | `StopFailure` hook |
| Unknown | cmux reported a state Mission Control doesn't recognize; the raw state is shown | — |

"Turns completed (24 h)" counts `Stop` hooks in local history. It is a count of turns, not tasks.

## Security & privacy

- Binds to `127.0.0.1` only. Requests with a non-loopback `Host` are rejected (DNS-rebinding
  guard). State-changing requests from foreign `Origin`s, or without a JSON content type, are refused.
- The browser never touches the cmux socket. The only action is navigation, allowlisted to
  `window.focus`, `workspace.select` and `surface.focus` for ids currently present in cmux.
  There is no endpoint for terminal input, commands or shell execution.
- No data leaves the machine, there are no LLM calls, and no hooks are installed. Claude Code
  and Codex hooks are injected by cmux's own wrappers, and no cmux or agent configuration is modified.
- Prompt text is hidden by default; there's an opt-in toggle in Settings. Tool inputs and notification
  text in the event stream stay redacted (cmux redacts them, and logs redact sensitive keys).
- Local history keeps event metadata only, for 7 days or 10,000 entries at most. You can clear it in Settings.

## Testing

| Layer | What it covers |
| --- | --- |
| Unit (`test/unit`) | Schemas parsed against **real cmux 0.65.2 captures** (`test/fixtures`), agent mapping, attention dedupe, program-status chunk assembly, status pills, summaries, request validation, log redaction, store retention |
| Integration (`test/integration`) | The real backend stack against a fake cmux socket that implements the verified protocol: initial sync, multiple windows, workspace create/close, tab moves, permission request → resolution, turn completion, program errors, duplicate events, dropped stream + resume, cmux restart, replay gap, stalled stream, interrupted replay, prior-boot history, access denied, not installed, not running, navigation allowlist, HTTP guards, SSE |
| UI smoke (`test/e2e`) | Playwright against the production server + fake cmux: every page, live updates, attention flow, navigation calls, privacy toggle, disconnect banner and recovery |
| Live (`npm run verify:live`) | Against your real cmux: topology matches `cmux tree --all` (multi-window included), workspace create/close, splits and tab moves, agent lifecycle via cmux's real hook pipeline, permission → Attention Center → resolution, OSC 7501 error, navigation confirmed by `cmux identify`, stream reconnect with replay |

The fake cmux is used only by tests. The server shows a "Test mode" banner whenever
`MC_TEST_FAKE_CMUX=1`, which is refused with `NODE_ENV=production`. Passing fake-backed tests
doesn't prove the live integration; that's what `verify:live` is for.

## Known limitations

- **Must run inside cmux.** With the default `cmuxOnly` socket mode, a process started elsewhere
  (Terminal.app, launchd, an IDE) is refused. Password socket mode is not implemented.
- **cmux restarts end the backend.** A server started from a cmux terminal exits when cmux quits.
  After relaunching cmux, start Mission Control again (`npm run cmux:launch`). Restart *handling*
  (new `boot_id`, resync) is implemented and tested against the fake, but on real cmux it only
  applies to stream reconnects within one cmux process.
- **What an agent is working on** is limited to what cmux reports: state, last hook, tool name,
  and optionally the latest prompt. There are no inferred task descriptions, and task success is never reported.
- **Codex** permission checks are telemetry in cmux (Codex approves in its own UI), so they don't
  mark Codex as waiting. Codex was not exercised live (no Codex session was run). The Claude Code
  path was exercised live through cmux's real hook pipeline with a synthetic session; a real
  Claude Code session was not run.
- **Program status (OSC 7501)** can't be re-read: after a replay gap it shows as "Unknown since
  reconnect" until the program reports again. Its message text is stripped by cmux.
- Sidebar status pills are parsed from a v1 command string (best effort) and are event-derived only.

## Next steps

- Opt-in AI summaries behind the existing `Summarizer` interface (local model or explicit consent)
- Answer Feed permission requests from the dashboard via `feed.permission.reply` (needs a deliberate UX and security review)
- Socket password mode, so it can run as a launchd service across cmux restarts
- Live verification with real Claude Code and Codex sessions, and per-agent integration notes from that
- Desktop notifications for new attention items while the dashboard is in the background
