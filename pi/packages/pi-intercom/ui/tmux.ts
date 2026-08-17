export const TMUX_COMMAND_TIMEOUT_MS = 3000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecCommand = (
  command: string,
  args: string[],
  options: { timeout: number },
) => Promise<ExecResult>;

export function parseTmuxTarget(target: string): { session: string; window: string } | null {
  const colon = target.lastIndexOf(":");
  if (colon <= 0) return null;
  const session = target.slice(0, colon);
  const windowPane = target.slice(colon + 1);
  const dot = windowPane.indexOf(".");
  if (!session || dot <= 0 || dot === windowPane.length - 1) return null;
  return { session, window: windowPane.slice(0, dot) };
}

function commandError(command: string, result: ExecResult): Error {
  return new Error(result.stderr.trim() || `${command} failed (${result.code})`);
}

export async function findTmuxTargetForPid(
  exec: ExecCommand,
  pid: number,
  timeout = TMUX_COMMAND_TIMEOUT_MS,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process id: ${pid}`);

  const [panesResult, psResult] = await Promise.all([
    exec("tmux", ["list-panes", "-a", "-F", "#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}"], { timeout }),
    exec("ps", ["-ax", "-o", "pid=,ppid="], { timeout }),
  ]);
  if (panesResult.code !== 0) throw commandError("tmux list-panes", panesResult);
  if (psResult.code !== 0) throw commandError("ps process listing", psResult);

  const paneTargetsByPid = new Map<number, string>();
  for (const line of panesResult.stdout.split("\n")) {
    const [target, panePidText] = line.split("\t");
    const panePid = Number.parseInt(panePidText ?? "", 10);
    if (target && Number.isSafeInteger(panePid) && panePid > 0 && parseTmuxTarget(target)) {
      paneTargetsByPid.set(panePid, target);
    }
  }

  const parentByPid = new Map<number, number>();
  for (const line of psResult.stdout.split("\n")) {
    const [childText, parentText] = line.trim().split(/\s+/);
    const childPid = Number.parseInt(childText ?? "", 10);
    const parentPid = Number.parseInt(parentText ?? "", 10);
    if (Number.isSafeInteger(childPid) && childPid > 0 && Number.isSafeInteger(parentPid) && parentPid >= 0) {
      parentByPid.set(childPid, parentPid);
    }
  }

  const seen = new Set<number>();
  let cursor: number | undefined = pid;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const target = paneTargetsByPid.get(cursor);
    if (target) return target;
    cursor = parentByPid.get(cursor);
  }
  return undefined;
}

export async function switchToTmuxTarget(
  exec: ExecCommand,
  target: string,
  timeout = TMUX_COMMAND_TIMEOUT_MS,
): Promise<void> {
  const parsed = parseTmuxTarget(target);
  if (!parsed) throw new Error(`Invalid tmux target: ${target}`);

  const commands: Array<[string, string[]]> = [
    ["tmux switch-client", ["switch-client", "-t", parsed.session]],
    ["tmux select-window", ["select-window", "-t", `${parsed.session}:${parsed.window}`]],
    ["tmux select-pane", ["select-pane", "-t", target]],
  ];
  for (const [label, args] of commands) {
    const result = await exec("tmux", args, { timeout });
    if (result.code !== 0) throw commandError(label, result);
  }
}
