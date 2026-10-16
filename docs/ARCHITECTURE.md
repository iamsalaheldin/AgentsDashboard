# Architecture

```
cmux.app ──(Unix socket, v2 JSON lines)──┐
                                         │  started from a cmux terminal (cmuxOnly access)
┌────────────────────────────────────────▼───────────────────────────────────┐
│ server/  (Node ≥ 22.18, TypeScript run natively, no native deps)           │
│                                                                            │
│  cmux/            SocketRpc ─ one request per connection, timeouts,        │
│                   classified errors (not_running / access_denied / …)      │
│                   EventStream ─ events.stream, ack/gap/heartbeat watchdog, │
│                   backoff reconnect, boot_id + seq cursor, dedupe          │
│                   CmuxAdapter ─ snapshot() / stream() / navigate()         │
│  domain/          normalize.ts ─ raw cmux → typed snapshot pieces          │
│                   agents/ ─ agent-specific hook → state mapping            │
│                   programStatus.ts ─ chunked OSC 7501 record assembly      │
│                   StateManager ─ single source of truth, pure reducers     │
│                   attention.ts / kpis.ts / summarize.ts                    │
│  store/           ActivityStore (node:sqlite) ─ bounded timeline + cursor  │
│  http/            127.0.0.1 only, Host/Origin checks, JSON + SSE           │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ GET /api/state, GET /api/activity, SSE /api/stream,
                                │ POST /api/navigate (allowlisted), GET/PUT /api/settings
┌───────────────────────────────▼────────────────────────────────────────────┐
│ web/  React 19 + Vite + Tailwind 4. Pages: Overview, Workspaces (+detail), │
│ Agents, Attention, Activity, Settings. Store = SSE-fed external store.     │
└────────────────────────────────────────────────────────────────────────────┘
```

## Data flow

1. **Bootstrap.** Connect `events.stream` first (with the persisted cursor if its `boot_id`
   matches, otherwise `after_seq: 0` to replay cmux's retained tail), then take a full snapshot:
   `system.tree {all_windows: true}`, per-window `extension.sidebar.snapshot`, `current.list`, `feed.list`, `notification.list`.
   Taking the snapshot *after* the stream is open means no event can fall between the two.
2. **Live events.** Each event is deduped by `id`, normalized, appended to the activity store
   when it is "important", and applied to state:
   - structural (`workspace.*`, `pane.*`, `surface.*`, `window.*`) → debounced `system.tree` +
     sidebar refresh (cmux's own model is authoritative; we never hand-patch topology);
   - agent / feed / notification / sidebar → immediate optimistic agent update from the hook,
     then a debounced `current.list` / `feed.list` / `notification.list` reconcile;
   - `program_status.changed` → event-only record store (cmux has no snapshot query).
3. **Recovery.** `ack.resume.gap`, a changed `boot_id`, `slow_consumer`, or a missed heartbeat
   (no frame for 2.5× the advertised interval) trigger a reconnect and a full re-snapshot.
   Program-status records are dropped on a gap (they cannot be recovered) and the UI says so.
   A slow 60 s safety reconcile runs only while connected.
4. **Fan-out.** The server pushes the whole normalized state over SSE (coalesced, ≤ 4/s) plus
   individual `activity` frames. State is small (tens of workspaces), so full-state frames are
   simpler and more robust than patches.

## Agent state model

Normalized states: `working`, `needs_attention`, `idle`, `ended`, `error`, `unknown`.
The source state (`needs_input`, hook name, …) is preserved alongside it.

| cmux signal | Normalized |
| --- | --- |
| `current.list` `working` / hook `UserPromptSubmit`, `PreToolUse`, `SessionStart`→`idle` | working / idle |
| `current.list` `needs_input` / hook `PermissionRequest`, `Notification` | needs_attention |
| hook `Stop` / `current.list` `idle` | idle (a **turn** ended — not a task) |
| hook `StopFailure` | error |
| hook `SessionEnd` / `current.list` `ended` | ended |
| anything else | unknown |

`current.list` wins whenever it disagrees with an optimistic hook update, because it is cmux's
registry of record. Agent-specific knowledge (Claude vs Codex semantics, display names) lives in
`server/src/domain/agents/` and nowhere else.

## Attention model

Sources, deduplicated per surface:
- pending `feed.list` permission / question / plan items (resolved when the item leaves `pending`);
- `current.list` `attention[]` entries (`needs_input`);
- program-status `blocked` / `error` records (resolved on `dismissed`/`removed`/`transient_drop`);
- agent `error` state;
- unread cmux notifications (lowest urgency; resolved when cmux marks them read/removed).

Opening the dashboard never resolves anything. Ordering: urgency (permission > input > error >
blocked > notification), then recency.

## Persistence

`~/.cmux-mission-control/activity.sqlite` (override: `MC_DATA_DIR`):
- `activity` — important events only, keyed by cmux event id (dedupe), with workspace/surface
  titles captured at the time so closed workspaces still read well. Retention: 7 days and
  10,000 rows, pruned on startup and hourly.
- `cursor` — last processed `boot_id`/`seq`.
- `settings.json` — `showPromptPreviews` (default `false`).

## Security boundaries

- Binds `127.0.0.1` only; rejects requests whose `Host` is not `127.0.0.1|localhost:<port>`
  (DNS-rebinding guard) and state-changing requests whose `Origin` is foreign.
- The browser never sees the socket. The only write path is `POST /api/navigate`, which maps a
  validated `{kind, ids}` body onto exactly `workspace.select`, `surface.focus`, `window.focus`
  for ids present in current state. No input, send-key, or shell execution exists.
- Logs are structured JSON with redaction of prompt/tool/body/password-like fields.
- No hooks or cmux settings are installed or modified. Claude Code and Codex hooks are already
  injected by cmux's own wrappers.

## Testing

- **Unit** (Vitest): normalizers, agent mapping, program-status assembly, attention, KPIs,
  reducers, request validation, log redaction.
- **Integration** (Vitest): a fake cmux Unix-socket server speaking the verified protocol drives
  the real `SocketRpc`/`EventStream`/`StateManager`/HTTP stack through restarts, gaps, duplicate
  events, slow consumers, access denial and socket loss.
- **UI smoke** (Playwright): the production server against the fake cmux server
  (`MC_TEST_FAKE_CMUX=1`, test-only), including the disconnected banner.
- **Live**: `npm run verify:live` (run inside cmux) checks a real cmux instance.
