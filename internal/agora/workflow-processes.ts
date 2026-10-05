import { spawnSync } from "node:child_process";

interface ProcessRow { pid: number; parent: number; identity: string }
interface Family { rootIdentity: string; descendants: Map<number, string> }
const families = new Map<number, Family>();
let timer: ReturnType<typeof setInterval> | undefined;

const snapshot = (): Map<number, ProcessRow> => {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,uid=,lstart="], { encoding: "utf8", timeout: 1000, maxBuffer: 2 * 1024 * 1024 });
  const rows = new Map<number, ProcessRow>();
  if (result.status !== 0) return rows;
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match && Number(match[3]) === process.getuid?.()) rows.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), identity: match[4]! });
  }
  return rows;
};
const collect = (): Map<number, ProcessRow> => {
  const rows = snapshot();
  for (const [root, family] of families) {
    const known = family.descendants;
    for (let depth = 0, changed = true; depth < 32 && changed && known.size < 4096; depth++) {
      changed = false;
      for (const row of rows.values()) {
        const parent = rows.get(row.parent);
        const parentMatches = parent && (row.parent === root ? parent.identity === family.rootIdentity : known.get(row.parent) === parent.identity);
        if (row.pid !== root && !known.has(row.pid) && parentMatches) { known.set(row.pid, row.identity); changed = true; }
      }
    }
  }
  return rows;
};

/** Best-effort resource cleanup for ordinary tools which create their own session/process group.
 * PID, owner and start time are rechecked before ancestry expansion and every signal. Rapid double-forked
 * processes can evade polling; the OS filesystem/network boundary does not depend on this. */
export const trackWorkflowProcesses = (root: number): { kill(): void; dispose(): void } => {
  const known = new Map<number, string>();
  const birth = snapshot().get(root)?.identity;
  if (birth) families.set(root, { rootIdentity: birth, descendants: known });
  if (!timer) { timer = setInterval(collect, 100); timer.unref(); }
  return {
    kill() {
      const rows = collect();
      for (const [pid, identity] of known) {
        if (rows.get(pid)?.identity === identity) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
      }
    },
    dispose() {
      families.delete(root);
      if (!families.size && timer) { clearInterval(timer); timer = undefined; }
    },
  };
};
