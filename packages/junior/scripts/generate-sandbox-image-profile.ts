import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { createPluginCatalogRuntime } from "../src/chat/plugins/registry";
import { GLOBAL_RUNTIME_DEPENDENCIES } from "../src/chat/sandbox/runtime-dependencies";
import { pluginCatalogConfigFromPluginSet } from "../src/plugins";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const exampleAppDir = path.resolve(packageDir, "../../apps/example");
const profilePath = path.join(packageDir, "sandbox/runtime-profile.json");

interface SandboxImageProfile {
  version: 1;
  runtime: "node22";
  dependencies: ReturnType<
    ReturnType<typeof createPluginCatalogRuntime>["getRuntimeDependencies"]
  >;
  postinstall: ReturnType<
    ReturnType<typeof createPluginCatalogRuntime>["getRuntimePostinstall"]
  >;
}

function renderProfile(profile: SandboxImageProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

async function buildProfile(): Promise<SandboxImageProfile> {
  const previousCwd = process.cwd();
  process.chdir(exampleAppDir);
  try {
    process.env.DATABASE_URL ??=
      "postgres://sandbox-image-profile:unused@localhost/unused";
    const { plugins } = await import("../../../apps/example/plugins");
    const catalog = createPluginCatalogRuntime();
    catalog.setConfig(pluginCatalogConfigFromPluginSet(plugins));
    return {
      version: 1,
      runtime: "node22",
      dependencies: [
        ...GLOBAL_RUNTIME_DEPENDENCIES,
        ...catalog.getRuntimeDependencies(),
      ],
      postinstall: catalog.getRuntimePostinstall(),
    };
  } finally {
    process.chdir(previousCwd);
  }
}

async function main(): Promise<void> {
  const profile = await buildProfile();
  const rendered = renderProfile(profile);
  if (process.argv.includes("--check")) {
    const committed = await fs
      .readFile(profilePath, "utf8")
      .then((raw) => JSON.parse(raw) as unknown)
      .catch(() => undefined);
    if (!isDeepStrictEqual(committed, profile)) {
      throw new Error(
        "Sandbox image profile is stale. Run `pnpm sandbox:image:profile`.",
      );
    }
    console.log("Sandbox image profile is current.");
    return;
  }

  await fs.writeFile(profilePath, rendered);
  console.log(`Wrote ${path.relative(process.cwd(), profilePath)}`);
}

await main();
