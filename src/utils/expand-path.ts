import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Expand a leading `~` to the agent process's home directory and resolve
 * to an absolute path. Tilde expansion is normally done by the shell, so
 * paths that arrive via JSON (e.g. UI-supplied `privateKeyPath`) keep the
 * literal `~` and fail with `ENOENT` on `Bun.file()` / `fs.open()`.
 */
export function expandPath(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}
