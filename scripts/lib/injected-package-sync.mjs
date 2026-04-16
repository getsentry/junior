import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the real injected pnpm package directory used by a workspace consumer.
 */
export function resolveInjectedPackageDir(packageName, consumerDir) {
  const packagePath = path.join(
    consumerDir,
    "node_modules",
    ...packageName.split("/"),
  );
  try {
    return fs.realpathSync(packagePath);
  } catch {
    return null;
  }
}

/** Point the injected package directory at the live workspace build output. */
export function linkDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing source directory for injected sync: ${sourceDir}`);
  }

  const targetParentDir = path.dirname(targetDir);
  fs.mkdirSync(targetParentDir, { recursive: true });

  try {
    const currentTarget = fs.realpathSync(targetDir);
    const desiredTarget = fs.realpathSync(sourceDir);
    if (currentTarget === desiredTarget) {
      return;
    }
  } catch {}

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.symlinkSync(sourceDir, targetDir, "dir");
}

export function isLinkedDirectory(sourceDir, targetDir) {
  try {
    return (
      fs.lstatSync(targetDir).isSymbolicLink() &&
      fs.realpathSync(targetDir) === fs.realpathSync(sourceDir)
    );
  } catch {
    return false;
  }
}
