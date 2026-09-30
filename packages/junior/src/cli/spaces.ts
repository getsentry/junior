/**
 * Space backfill CLI.
 *
 * This module owns arguments, progress output, and the report file. The
 * Space module owns candidate selection, classification, and storage.
 */
import { writeFile } from "node:fs/promises";
import { defaultModelId } from "@/chat/model-profile";
import { CLI_USAGE } from "./run";

type BackfillOptions = {
  apply: boolean;
  limit?: number;
  model?: string;
  out?: string;
  sinceMs?: number;
};

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseBackfillOptions(argv: string[]): BackfillOptions {
  const options: BackfillOptions = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--limit") {
      const limit = Number(optionValue(argv, index, argument));
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = limit;
      index += 1;
    } else if (argument === "--since") {
      const sinceMs = Date.parse(optionValue(argv, index, argument));
      if (!Number.isFinite(sinceMs)) {
        throw new Error("--since must be an ISO-8601 date");
      }
      options.sinceMs = sinceMs;
      index += 1;
    } else if (argument === "--model") {
      options.model = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--out") {
      options.out = optionValue(argv, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}\n${CLI_USAGE}`);
    }
  }
  return options;
}

async function runBackfill(options: BackfillOptions): Promise<void> {
  // `chat/config` and `chat/db` read the environment at import.
  const [{ botConfig }, { closeDb, getDb }, { completeObject }, backfill] =
    await Promise.all([
      import("@/chat/config"),
      import("@/chat/db"),
      import("@/chat/pi/client"),
      import("@/chat/spaces/backfill"),
    ]);
  const modelId = options.model ?? defaultModelId(botConfig);
  try {
    const db = getDb();
    const candidates = await backfill.readSpaceBackfillCandidates(db, {
      ...(options.limit !== undefined ? { limit: options.limit } : undefined),
      ...(options.sinceMs !== undefined
        ? { sinceMs: options.sinceMs }
        : undefined),
    });
    console.error(
      `${options.apply ? "Assigning" : "Dry run over"} ${candidates.length} Conversations with ${modelId}`,
    );
    const result = await backfill.runSpaceBackfill(db, {
      candidates,
      apply: options.apply,
      completeObject: (request) =>
        completeObject({
          ...request,
          modelId,
          promptName: "junior.space_backfill",
        }),
      onProgress(done, total) {
        if (done % 25 === 0 || done === total) {
          console.error(`${done}/${total}`);
        }
      },
    });
    const markdown = backfill.renderSpaceBackfillMarkdown(result, {
      apply: options.apply,
    });
    if (options.out) {
      await writeFile(options.out, markdown);
      console.error(`Wrote ${options.out}`);
    } else {
      process.stdout.write(markdown);
    }
  } finally {
    await closeDb();
  }
}

/** Run `junior spaces` subcommands and return a process exit code. */
export async function runSpaces(argv: string[]): Promise<number> {
  try {
    const [subcommand, ...rest] = argv;
    if (subcommand === "backfill") {
      await runBackfill(parseBackfillOptions(rest));
      return 0;
    }
    throw new Error(CLI_USAGE);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
