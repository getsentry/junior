import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve a package to its root directory using import.meta.resolve. */
export function resolvePackageDir(pkgName: string): string | undefined {
  try {
    const resolved = import.meta.resolve(pkgName);
    const entry = resolved.startsWith("file://")
      ? fileURLToPath(resolved)
      : resolved;
    // Walk up from the resolved entry to find the package root (contains package.json).
    let dir = path.dirname(entry);
    while (dir !== path.dirname(dir)) {
      if (existsSync(path.join(dir, "package.json"))) return dir;
      dir = path.dirname(dir);
    }
  } catch {
    // Package not resolvable from this module
  }
  return undefined;
}
