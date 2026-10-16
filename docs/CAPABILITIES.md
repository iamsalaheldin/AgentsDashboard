# cmux capability matrix

Verified against **cmux 0.65.2 (build 111, 9d01f956c)** on macOS (Apple Silicon), 2026-10-16.
Every row marked *Verified* was exercised against the live app from inside a cmux terminal;
response shapes are captured in `test/fixtures/`.

## Access model

| Item | Finding |
| --- | --- |
| Socket path | `~/.local/state/cmux/cmux.sock` (also exported as `CMUX_SOCKET_PATH` inside cmux terminals) |
| Access mode | `cmuxOnly` (default). Processes outside cmux get `ERROR: Access denied - only processes started inside cmux can connect`. |
| Consequence | Mission Control's backend **must be started from a cmux terminal**. It never changes `CMUX_SOCKET_MODE` or the socket setting. |
| Protocol | v2 JSON lines: `{"id","method","params"}` → `{"id","ok","result"|"error"}`. One request per connection works; `events.stream` takes over its connection. |
| Direct Node access | *Verified*: `net.createConnection(CMUX_SOCKET_PATH)` from a process inside cmux succeeds (auth is ancestry-based; no token needed). |
| Password mode | Not exercised. cmux supports `CMUX_SOCKET_PASSWORD`; Mission Control does not implement password auth yet (documented limitation). |

## Feature → data source

| Product need | Source (method / event) | Status |
| --- | --- | --- |
| Windows | `system.tree {all_windows: true}` → `windows[]` (`id`, `ref`, `index`, `key`, `visible`, `selected_workspace_id`). **Without `all_windows` only the focused window is returned.** | Verified (2 windows) |
| Workspaces | `system.tree` → `windows[].workspaces[]`; enriched by `extension.sidebar.snapshot {window_id}` (per window) (cwd, `project_root_path`, `git_branches`, `branch_summary`, `pull_request_urls`, `listening_ports`, `unread_count`, `latest_submitted_message/at`) | Verified |
| Panes | `system.tree` → `workspaces[].panes[]` (`id`, `focused`, `selected_surface_id`, `surface_ids`) | Verified |
| Surfaces / tabs | `system.tree` → `panes[].surfaces[]` (`id`, `type`, `title`, `tty`, `url`, `focused`, `selected_in_pane`, `render_health`) | Verified |
| Git branch / repo | `extension.sidebar.snapshot` → `git_branches`, `branch_summary`, `project_root_path` (null when cwd is not a repo) | Verified (null case); populated case per docs |
| Agent detection + state | `current.list` → `items[].agents[]` (`kind`, `session_id`, `state`, `last_activity_at`, `has_hook_lifecycle_state`) mapped to surfaces via `items[].projections[].panel_id` | Verified: `working`, `needs_input`, `idle`, `ended` |
| Agent "needs attention" | `current.list` → `items[].attention[]` (`kind: needs_input`, `scope: agent`) | Verified |
| Permission requests | `feed.list` → items with `kind: permissionRequest`, `status: pending`, `request_id`, `tool_name`; events `agent.hook.PermissionRequest`, `feed.item.received/completed/resolved` | Verified (pending); resolution via `feed.item.completed` per docs |
| Questions / plan approvals | `feed.list` kinds for AskUserQuestion / ExitPlanMode (Claude Code) | Documented, not exercised |
| Live lifecycle events | `events.stream` — `workspace.*`, `pane.*`, `surface.*`, `window.*` from `*.lifecycle` sources | Verified |
| Agent hook events | `agent.hook.<HookName>` (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Notification`, `Stop`, `SessionEnd`, …) with `phase: received|completed`, `tool_name`, lengths only | Verified (Claude Code hook path) |
| Turn completion | `agent.hook.Stop` + `agent.notification.decision` (`kind: agent.turn.completed`) | Verified |
| Program status | `program_status.changed` (`report`/`clear`/`prompt_start`/`transient_drop`/`dismissed`/`removed`/`adopted`, chunked snapshots, `state` ∈ working/blocked/error/done/idle). **No snapshot query exists**, so state is event-derived only. | Verified (`working`, `error`) |
| Notifications | `notification.list` (title/body/is_read/workspace/surface) + `notification.created/read/removed/cleared` events (text redacted in events) | Verified |
| Sidebar status pills | `sidebar.metadata.updated` events whose `payload.args` carry the v1 `set_status` command line (e.g. `claude_code Running --icon=… --tab=<ws> --panel=<surface>`) | Verified (parsing a v1 arg string — best effort) |
| Replay / resume | `events.stream {after_seq}` → `ack.resume {gap, oldest_seq, latest_seq}`; `boot_id` changes on restart; buffer 4,096 events; heartbeats every 15 s | Verified |
| Navigation | `window.focus {window_id}` → `workspace.select {workspace_id}` → `surface.focus {workspace_id, surface_id}`; confirmed with `cmux identify` | Verified |
| Codex | Hooks are injected per launch by cmux's Codex wrapper (`agent.hook.*`, `source: codex`). Codex approvals stay in Codex's own TUI; cmux records them as **telemetry only**. | Documented; not exercised (no Codex session run) |
| Other agents (OpenCode, Gemini, Amp, …) | Same `agent.hook.*` / `current.list` path once their cmux hooks are installed | Documented; not exercised |

## Current task descriptions — what is and is not available

| Category | What cmux provides | Mission Control behaviour |
| --- | --- | --- |
| A. Confirmed structured facts | Agent kind, state, last hook name, tool **name** (e.g. `Bash`), turn completion, permission pending, program-status state | Shown as facts, labelled with their source |
| B. Human-readable text from integrations | Latest submitted prompt (`latest_submitted_message`, feed `userPrompt` text), notification title/body, program-status `msg` (sidebar only — **stripped from the event stream**) | Prompt previews are **off by default**; opt-in in Settings. Program-status text is not available to us. |
| C. Not available | What an agent is "working on" beyond the above; task success/failure; whether background work continues after a turn | Shown as "Not reported by cmux" — never inferred |

## Unsupported / limited

- No program-status snapshot query: after a reconnect gap, terminal status records are unknown until the program reports again.
- Event payloads redact prompt, tool input and notification text by design.
- `feed.list` items carry no workspace/surface ids; Mission Control correlates them through the `feed.item.*` / `agent.hook.*` events that do (via `request_id` / workstream id).
- `agent.list` does not exist (`method_not_found`); `current.list` is the agent snapshot.
- Task completion (vs. turn completion) is not reported by any interface.

## Behaviour discovered during live validation

These were found by `npm run verify:live` against cmux 0.65.2 and are handled in code
(each has a regression test against the fake cmux):

- `system.tree` returns only the focused window unless called with `all_windows: true`.
- `extension.sidebar.snapshot` is per window; pass `window_id` for the others.
- The replay buffer contains events **restored from earlier cmux processes**, carrying an
  older `boot_id`. They are history, not a sign of a restart; only a *live* event from a
  different boot triggers a resync.
- A large replay burst can be cut off by cmux part-way (the subscription simply ends).
  Mission Control resumes from the last delivered `seq` immediately while progress is made.
  cmux also ended the subscription once when a window closed; the client reconnects.
- A permission request that the agent moves past is marked `expired` in `feed.list`
  without a `feed.item.completed` event; every agent hook triggers a `feed.list` reconcile,
  which clears it.
- Socket-sourced events (e.g. `workspace.renamed` from the CLI) carry their data under
  `payload.params` / `payload.result` rather than at the top level.
- Closing a workspace or window whose shell is alive needs `--force` (`confirmation_required`).
