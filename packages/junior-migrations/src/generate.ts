import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { readMigrationJournal } from "./journal";

/** Drizzle Kit inputs used to create one TypeScript migration entry. */
export interface GenerateTypeScriptMigrationOptions {
  configPath: string;
  cwd?: string;
  migrationsFolder: string;
  name: string;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

function scaffold(): string {
  return `import type { MigrationV1 } from "@sentry/junior-migrations";\n\nconst migration = {\n  apiVersion: 1,\n  async up(context) {\n    void context;\n  },\n} satisfies MigrationV1;\n\nexport default migration;\n`;
}

function isMissingJournal(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
  );
}

async function runDrizzleGenerate(
  options: GenerateTypeScriptMigrationOptions,
  cwd: string,
  folder: string,
): Promise<void> {
  const configDirectory = await mkdtemp(
    resolve(cwd, ".junior-migrations-config-"),
  );
  try {
    const configPath = resolve(cwd, options.configPath);
    const relativeConfigPath = relative(configDirectory, configPath)
      .split(sep)
      .join("/");
    const configSpecifier = relativeConfigPath.startsWith(".")
      ? relativeConfigPath
      : `./${relativeConfigPath}`;
    const relativeOutputPath = relative(cwd, folder).split(sep).join("/");
    const configOutputPath = relativeOutputPath.startsWith(".")
      ? relativeOutputPath
      : `./${relativeOutputPath}`;
    const overrideConfigPath = resolve(configDirectory, "drizzle.config.ts");
    await writeFile(
      overrideConfigPath,
      `import config from ${JSON.stringify(configSpecifier)};\nexport default { ...config, out: ${JSON.stringify(configOutputPath)} };\n`,
      "utf8",
    );
    await run(
      "drizzle-kit",
      [
        "generate",
        "--custom",
        "--config",
        overrideConfigPath,
        "--name",
        options.name,
      ],
      cwd,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
}

/** Create a journaled TypeScript migration through Drizzle Kit's custom generator. */
export async function generateTypeScriptMigration(
  options: GenerateTypeScriptMigrationOptions,
): Promise<string> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const folder = resolve(cwd, options.migrationsFolder);
  let before;
  try {
    before = await readMigrationJournal(folder);
  } catch (error) {
    if (!isMissingJournal(error)) throw error;
    before = [];
  }
  await runDrizzleGenerate(options, cwd, folder);
  const after = await readMigrationJournal(folder);
  if (after.length !== before.length + 1) {
    throw new Error("Drizzle Kit did not create exactly one migration entry");
  }
  const entry = after.at(-1);
  if (!entry) {
    throw new Error("Drizzle Kit did not create a migration entry");
  }
  const sqlPath = resolve(folder, `${entry.tag}.sql`);
  const source = await readFile(sqlPath, "utf8");
  if (!source.includes("Custom SQL migration file")) {
    throw new Error(`Refusing to replace non-custom migration ${entry.tag}`);
  }
  const typescriptPath = resolve(folder, `${entry.tag}.ts`);
  const snapshotPath = resolve(
    folder,
    "meta",
    `${String(entry.index).padStart(4, "0")}_snapshot.json`,
  );
  await rename(sqlPath, typescriptPath);
  await rm(snapshotPath, { force: true });
  await writeFile(typescriptPath, scaffold(), "utf8");
  return typescriptPath;
}
