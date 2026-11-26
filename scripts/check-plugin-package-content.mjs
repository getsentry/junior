import fs from "node:fs";
import path from "node:path";

// Core's package discovery accepts a plugin package only when it ships one of
// these. See `discoverDeclaredPackages` in package-discovery.ts.
const CONTENT_ENTRIES = ["plugin.yaml", "migrations", "plugins", "skills"];

/**
 * Report plugin factories that declare their own package as `packageName`
 * when that package publishes no plugin content. Core then fails
 * `junior check` and app startup for every app that registers the factory.
 * `packages` lists `{ dir, name, files, sources }`: the package directory,
 * its package.json `name` and `files`, and its source files with their text.
 */
export function checkPluginPackageContent(packages) {
  const errors = [];
  for (const pkg of packages) {
    const declaration = `packageName: ${JSON.stringify(pkg.name)}`;
    const declaring = pkg.sources.find((source) =>
      source.text.includes(declaration),
    );
    if (!declaring) continue;
    const published = (pkg.files ?? []).map((entry) =>
      entry.replace(/\/+$/, ""),
    );
    if (CONTENT_ENTRIES.some((entry) => published.includes(entry))) continue;
    errors.push(
      `${declaring.file}: declares packageName ${JSON.stringify(pkg.name)}, but ${pkg.dir}/package.json publishes none of ${CONTENT_ENTRIES.join(", ")}. Core rejects that package when it discovers plugins. Remove packageName, or publish the plugin content.`,
    );
  }
  return errors;
}

/** Check every workspace package under `packages/`. */
export function run({ root, files }) {
  const manifests = files.filter((file) =>
    /^packages\/[^/]+\/package\.json$/.test(file),
  );
  const packages = manifests.map((manifest) => {
    const dir = path.posix.dirname(manifest);
    const { name, files: published } = JSON.parse(
      fs.readFileSync(path.join(root, manifest), "utf8"),
    );
    const sources = files
      .filter((file) => file.startsWith(`${dir}/src/`) && file.endsWith(".ts"))
      .map((file) => ({
        file,
        text: fs.readFileSync(path.join(root, file), "utf8"),
      }));
    return { dir, name, files: published, sources };
  });
  return checkPluginPackageContent(packages);
}
