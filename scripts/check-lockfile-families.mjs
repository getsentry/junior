import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

/** Return the workspace lockfile document. pnpm 12 writes a package-manager document before it. */
export function parseLockfile(text) {
  const lockfile = parseAllDocuments(text)
    .map((document) => document.toJS())
    .find((document) => document?.catalogs);
  if (!lockfile) {
    throw new Error("pnpm-lock.yaml has no document with a catalogs section.");
  }
  return lockfile;
}

function splitKey(key) {
  const at = key.indexOf("@", 1);
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

// Snapshot keys and versions carry a peer suffix: `name@1.0.0(peer@2.0.0)`.
function baseKey(key) {
  return key.replace(/\(.*$/, "");
}

function scopeOf(name) {
  return name.startsWith("@") ? name.slice(0, name.indexOf("/") + 1) : null;
}

/**
 * Derive lockstep families from the lockfile. Packages in one npm scope that
 * depend on each other at their own exact version are released together, like
 * the Sentry SDK and the Pi packages. Only families with a catalog package
 * count: the catalog is where the workspace pins one version for every
 * importer. Third-party families outside the catalog (`@aws-sdk/*`,
 * `@img/*`) may keep their own copies.
 */
function lockstepFamilies(lockfile) {
  const versionsByName = new Map();
  const links = new Map();
  const link = (from, to) =>
    links.set(from, new Set([...(links.get(from) ?? []), to]));
  for (const [key, snapshot] of Object.entries(lockfile.snapshots)) {
    const { name, version } = splitKey(baseKey(key));
    versionsByName.set(
      name,
      new Set([...(versionsByName.get(name) ?? []), version]),
    );
    for (const [dependency, dependencyVersion] of Object.entries({
      ...snapshot.dependencies,
      ...snapshot.optionalDependencies,
    })) {
      if (
        baseKey(dependencyVersion) === version &&
        scopeOf(dependency) &&
        scopeOf(dependency) === scopeOf(name)
      ) {
        link(name, dependency);
        link(dependency, name);
      }
    }
  }
  const catalogNames = Object.values(lockfile.catalogs).flatMap((catalog) =>
    Object.keys(catalog),
  );
  const families = new Map();
  for (const start of catalogNames) {
    if (!links.has(start)) continue;
    const members = new Set([start]);
    for (const name of members) {
      for (const next of links.get(name)) members.add(next);
    }
    const sorted = [...members].sort();
    families.set(sorted.join(" "), {
      catalogNames: sorted.filter((name) => catalogNames.includes(name)),
      members: sorted.map((name) => ({
        name,
        versions: [...versionsByName.get(name)].sort(),
      })),
    });
  }
  return [...families.values()];
}

function snapshotKey(lockfile, name, version) {
  if (version.startsWith("link:")) return null;
  const direct = `${name}@${version}`;
  if (lockfile.snapshots[direct]) return direct;
  // Aliased dependencies (`npm:other@1.0.0`) record the target key as the version.
  return lockfile.snapshots[version] ? version : null;
}

// Map each `name@version` to the importers that reach it, with one shortest path per importer.
function importerPaths(lockfile) {
  const paths = new Map();
  for (const [importer, entry] of Object.entries(lockfile.importers)) {
    const queue = [];
    const seen = new Set();
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      for (const [name, dependency] of Object.entries(entry[field] ?? {})) {
        const key = snapshotKey(lockfile, name, dependency.version);
        if (key && !seen.has(key)) {
          seen.add(key);
          queue.push({ key, chain: [baseKey(key)] });
        }
      }
    }
    for (const { key, chain } of queue) {
      const target = baseKey(key);
      const reached = paths.get(target) ?? new Map();
      if (!reached.has(importer)) reached.set(importer, chain);
      paths.set(target, reached);
      const snapshot = lockfile.snapshots[key];
      for (const [name, version] of Object.entries({
        ...snapshot.dependencies,
        ...snapshot.optionalDependencies,
      })) {
        const next = snapshotKey(lockfile, name, version);
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push({ key: next, chain: [...chain, baseKey(next)] });
        }
      }
    }
  }
  return paths;
}

/** Report lockstep families that resolve to more than one version, with the importers that pull each one. */
export function checkLockfileFamilies(lockfile) {
  const paths = importerPaths(lockfile);
  return lockstepFamilies(lockfile).flatMap((family) => {
    const versions = [
      ...new Set(family.members.flatMap((member) => member.versions)),
    ].sort();
    if (versions.length < 2) return [];
    return [
      `${scopeOf(family.members[0].name)}* lockstep family resolves to ${versions.join(", ")}. Each copy loads its own module state.`,
      ...versions.flatMap((version) => {
        const names = family.members
          .filter((member) => member.versions.includes(version))
          .map((member) => member.name);
        const shortest = new Map();
        for (const name of names) {
          for (const [importer, chain] of paths.get(`${name}@${version}`) ??
            []) {
            if ((shortest.get(importer)?.length ?? Infinity) > chain.length) {
              shortest.set(importer, chain);
            }
          }
        }
        return [
          `  ${version}: ${names.join(", ")}`,
          ...[...shortest].map(
            ([importer, chain]) => `    ${importer} > ${chain.join(" > ")}`,
          ),
        ];
      }),
      `  Fix: pin one version in the pnpm-workspace.yaml catalog (or add an override for a stray copy), then run \`pnpm update -r ${family.catalogNames.join(" ")}\` or \`pnpm dedupe\`. Plain \`pnpm install\` does not re-resolve injected workspace copies.`,
    ];
  });
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const file = process.argv[2] ?? path.join(root, "pnpm-lock.yaml");
  const errors = checkLockfileFamilies(
    parseLockfile(fs.readFileSync(file, "utf8")),
  );
  if (errors.length === 0) {
    console.log("Lockstep package families resolve to one version each.");
    return;
  }
  console.error(["Lockfile family check failed:", ...errors].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
