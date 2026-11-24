import fs from "node:fs";
import path from "node:path";

/**
 * Return the latest Drizzle snapshot of each package that has migrations.
 * It is the schema that the package's migrations create.
 */
export function latestSnapshots(root) {
  const snapshots = [];
  for (const packageName of fs
    .readdirSync(path.join(root, "packages"))
    .sort()) {
    const meta = path.join("packages", packageName, "migrations", "meta");
    const journalPath = path.join(root, meta, "_journal.json");
    if (!fs.existsSync(journalPath)) continue;
    const last = JSON.parse(fs.readFileSync(journalPath, "utf8")).entries.at(
      -1,
    );
    if (!last) continue;
    const snapshotPath = path.join(
      meta,
      `${String(last.idx).padStart(4, "0")}_snapshot.json`,
    );
    snapshots.push({
      packageName,
      snapshotPath,
      snapshot: JSON.parse(
        fs.readFileSync(path.join(root, snapshotPath), "utf8"),
      ),
    });
  }
  return snapshots;
}
