// Pure conversions from raw cmux snapshot payloads into the normalized topology.
import type { CmuxWindow, GitInfo, Pane, Surface, SurfaceType, Workspace } from '../../../shared/types.ts';
import type { RawSidebar, RawTree } from '../cmux/schemas.ts';

export interface Topology {
  windows: Record<string, CmuxWindow>;
  windowOrder: string[];
  workspaces: Record<string, Workspace>;
  panes: Record<string, Pane>;
  surfaces: Record<string, Surface>;
}

export function surfaceType(raw: string): SurfaceType {
  switch (raw) {
    case 'terminal':
      return 'terminal';
    case 'browser':
      return 'browser';
    case 'markdown':
      return 'markdown';
    case 'agent-session':
    case 'agent_session':
    case 'agentSession':
      return 'agent-session';
    default:
      return 'other';
  }
}

type SidebarWs = RawSidebar['workspaces'][number];

export function gitInfo(ws: SidebarWs | undefined): GitInfo | null {
  if (!ws) return null;
  const first = ws.git_branches?.[0];
  if (typeof first === 'string' && first) return { branch: first, dirty: null };
  if (first && typeof first === 'object') {
    const branch = first.branch ?? first.name ?? null;
    if (branch) return { branch, dirty: first.is_dirty ?? first.dirty ?? null };
  }
  const summary = ws.branch_summary;
  if (typeof summary === 'string' && summary) return { branch: summary, dirty: null };
  if (summary && typeof summary === 'object') {
    const s = summary as { branch?: unknown; name?: unknown; is_dirty?: unknown };
    const branch = typeof s.branch === 'string' ? s.branch : typeof s.name === 'string' ? s.name : null;
    if (branch) return { branch, dirty: typeof s.is_dirty === 'boolean' ? s.is_dirty : null };
  }
  return null;
}

function ports(ws: SidebarWs | undefined): number[] {
  return (ws?.listening_ports ?? [])
    .map((p) => (typeof p === 'number' ? p : p.port))
    .filter((p): p is number => Number.isInteger(p));
}

export interface NormalizeOptions {
  showPromptPreviews: boolean;
  selfSurfaceId: string | null;
}

export function normalizeTopology(tree: RawTree, sidebar: SidebarWs[] | null, opts: NormalizeOptions): Topology {
  const side = new Map((sidebar ?? []).map((w) => [w.id, w]));
  const topo: Topology = { windows: {}, windowOrder: [], workspaces: {}, panes: {}, surfaces: {} };

  for (const win of [...tree.windows].sort((a, b) => a.index - b.index)) {
    topo.windowOrder.push(win.id);
    topo.windows[win.id] = {
      id: win.id,
      ref: win.ref ?? null,
      index: win.index,
      isKey: win.key === true,
      visible: win.visible !== false,
      selectedWorkspaceId: win.selected_workspace_id ?? null,
      workspaceIds: win.workspaces.map((w) => w.id),
    };
    for (const ws of win.workspaces) {
      const sb = side.get(ws.id);
      const prompt = sb?.latest_submitted_message ?? null;
      topo.workspaces[ws.id] = {
        id: ws.id,
        ref: ws.ref ?? null,
        windowId: win.id,
        index: ws.index,
        title: ws.title || sb?.title || 'Untitled workspace',
        description: ws.description ?? null,
        pinned: ws.pinned === true,
        selected: ws.selected === true,
        cwd: sb?.current_directory ?? sb?.root_path ?? null,
        projectRoot: sb?.project_root_path ?? null,
        git: gitInfo(sb),
        pullRequestUrls: sb?.pull_request_urls ?? [],
        listeningPorts: ports(sb),
        unreadCount: sb?.unread_count ?? 0,
        latestPrompt: opts.showPromptPreviews && prompt ? { text: prompt.slice(0, 280), at: sb?.latest_submitted_at ?? null } : null,
        hasSubmittedPrompt: Boolean(prompt),
        paneIds: ws.panes.map((p) => p.id),
        statusPills: [],
      };
      for (const pane of ws.panes) {
        topo.panes[pane.id] = {
          id: pane.id,
          ref: pane.ref ?? null,
          workspaceId: ws.id,
          index: pane.index,
          focused: pane.focused === true,
          selectedSurfaceId: pane.selected_surface_id ?? null,
          surfaceIds: pane.surfaces.length ? pane.surfaces.map((s) => s.id) : pane.surface_ids,
        };
        for (const s of pane.surfaces) {
          topo.surfaces[s.id] = {
            id: s.id,
            ref: s.ref ?? null,
            paneId: pane.id,
            workspaceId: ws.id,
            index: s.index_in_pane ?? s.index,
            title: s.title || (s.type === 'browser' ? s.url ?? 'Browser' : 'Terminal'),
            type: surfaceType(s.type),
            rawType: s.type,
            url: s.url ?? null,
            tty: s.tty ?? null,
            focused: s.focused === true,
            selectedInPane: s.selected_in_pane === true || s.selected === true,
            renderHealth: s.render_health ?? null,
            programStatus: [],
            lastActivityAt: null,
            isMissionControl: s.id === opts.selfSurfaceId,
          };
        }
      }
    }
  }
  return topo;
}
