import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Migration folders of one package's `migrations` directory, in order. */
function migrationFolders(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Return the schema that each package's migrations create, from the Drizzle
 * snapshots. A Drizzle v1 snapshot after the first holds only the changes of
 * its migration, so drizzle-kit rebuilds the schema from all of them. Two PRs
 * that each add a migration on the same parent leave two leaf snapshots on
 * main until the next `db:generate` merges them. `drizzle-kit check` rejects
 * leaves that conflict, so the schema is the union of every leaf. Each
 * schema has the shape `{ tables: { [key]: { name, columns: { [name]:
 * { name, type } } } } }`.
 */
export async function latestSnapshots(root) {
  const snapshots = [];
  for (const packageName of fs
    .readdirSync(path.join(root, "packages"))
    .sort()) {
    const snapshotPath = path.join("packages", packageName, "migrations");
    const directory = path.join(root, snapshotPath);
    if (!fs.existsSync(directory)) continue;
    const files = {};
    for (const folder of migrationFolders(directory)) {
      const file = path.join(directory, folder, "snapshot.json");
      if (fs.existsSync(file)) {
        files[folder] = JSON.parse(fs.readFileSync(file, "utf8"));
      }
    }
    if (Object.keys(files).length === 0) continue;
    // drizzle-kit is a dependency of each package that has migrations.
    const require = createRequire(
      path.resolve(root, "packages", packageName, "package.json"),
    );
    const { reconstruct } = await import(
      require.resolve("drizzle-kit/api-postgres")
    );
    const ddl = [];
    for (const id of leafIds(Object.values(files))) {
      ddl.push(...(await reconstruct(files, id)).ddl);
    }
    snapshots.push({ packageName, snapshotPath, snapshot: tablesOf(ddl) });
  }
  return snapshots;
}

function leafIds(snapshots) {
  const parentIds = new Set(snapshots.flatMap((snapshot) => snapshot.prevIds));
  return snapshots
    .map((snapshot) => snapshot.id)
    .filter((id) => !parentIds.has(id));
}

function tablesOf(ddl) {
  const tables = {};
  for (const entity of ddl) {
    if (entity.entityType !== "tables" && entity.entityType !== "columns") {
      continue;
    }
    const tableName =
      entity.entityType === "tables" ? entity.name : entity.table;
    const key = `${entity.schema}.${tableName}`;
    tables[key] ??= { name: tableName, columns: {} };
    if (entity.entityType === "columns") {
      tables[key].columns[entity.name] = {
        name: entity.name,
        type: entity.type,
      };
    }
  }
  return { tables };
}
