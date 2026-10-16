// Sidebar status pills arrive as `sidebar.metadata.updated|cleared` events whose payload
// carries the v1 command line, e.g.
//   {"command":"set_status","args":"claude_code Running --icon=bolt.fill --color=#4C8DFF --tab=<ws> --panel=<sf>"}
// This is best-effort parsing of a text protocol; unknown shapes are ignored.

export interface PillChange {
  op: 'set' | 'clear';
  workspaceId: string;
  surfaceId: string | null;
  key: string;
  value: string;
  color: string | null;
}

export function tokenize(args: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

export function parseStatusCommand(payload: Record<string, unknown>): PillChange | null {
  const command = payload.command;
  const args = payload.args;
  if (typeof args !== 'string' || (command !== 'set_status' && command !== 'clear_status')) return null;
  const flags: Record<string, string> = {};
  const words: string[] = [];
  for (const tok of tokenize(args)) {
    const f = /^--([a-z_-]+)=(.*)$/i.exec(tok);
    if (f) flags[f[1]!.toLowerCase()] = f[2]!;
    else if (tok === '--') continue;
    else words.push(tok);
  }
  const key = words.shift();
  const workspaceId = flags.tab ?? flags.workspace;
  if (!key || !workspaceId) return null;
  return {
    op: command === 'set_status' ? 'set' : 'clear',
    workspaceId,
    surfaceId: flags.panel ?? flags.surface ?? null,
    key,
    value: words.join(' '),
    color: flags.color ?? null,
  };
}
