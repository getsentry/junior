import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status === 0) {
    return;
  }

  process.exit(result.status ?? 1);
}

run("pnpm", ["exec", "next", "build"]);

if (process.env.JUNIOR_SKIP_SNAPSHOT_CREATE === "1") {
  console.log(
    "Skipping junior snapshot create because JUNIOR_SKIP_SNAPSHOT_CREATE=1",
  );
  process.exit(0);
}

run("pnpm", ["exec", "junior", "snapshot", "create"]);
