import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Resolve a package to its root directory from the app project root. */
export function resolvePackageDir(
  cwd: string,
  pkgName: string,
): string | undefined {
  try {
    const requireFromCwd = createRequire(path.join(cwd, "package.json"));
    const resolved = requireFromCwd.resolve(pkgName);
    // Walk up from the resolved entry to find the package root (contains package.json).
    let dir = path.dirname(resolved);
    while (dir !== path.dirname(dir)) {
      if (existsSync(path.join(dir, "package.json"))) return dir;
      dir = path.dirname(dir);
    }
  } catch {
    // Package not resolvable from this module
  }
  return undefined;
}
