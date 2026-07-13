import { parseArgs } from "node:util";
import { generateTypeScriptMigration } from "./generate";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    name: { type: "string" },
    out: { type: "string", default: "./migrations" },
  },
});

if (positionals[0] !== "generate" || !values.config || !values.name) {
  throw new Error(
    "Usage: junior-migrations generate --config <path> --name <name> [--out <dir>]",
  );
}

const path = await generateTypeScriptMigration({
  configPath: values.config,
  migrationsFolder: values.out,
  name: values.name,
});
console.log(`Created TypeScript migration ${path}`);
