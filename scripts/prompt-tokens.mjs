import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Report the always-on prompt: the system prompt and tool definitions that
 * the first model request of every Turn sends. Tokens are estimates from
 * characters, with the rule in `packages/junior/src/chat/services/token-estimate.ts`.
 *
 * It runs one local Turn of the example app with a fake AI Gateway, so it
 * needs the local Postgres (`docker compose up -d postgres`):
 *
 *   pnpm prompt-tokens                         # print the report
 *   pnpm prompt-tokens --out stats.json        # also keep the stats
 *   pnpm prompt-tokens --base main-stats.json  # compare with other stats
 *
 * CI publishes the report as the `prompt tokens` check. See
 * `scripts/prompt-tokens-check.mjs`.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EXAMPLE_ROOT = path.join(REPO_ROOT, "apps", "example");
const JUNIOR_ROOT = path.join(REPO_ROOT, "packages", "junior");
const STATS_VERSION = 1;
// The compose Postgres. CI sets DATABASE_URL to its service.
const LOCAL_DATABASE_URL = "postgresql://junior:junior@127.0.0.1:54322/junior";
// The Turn reads no secret, but config needs a key and a secret.
const MEASURE_ENCRYPTION_KEYS =
  "measure:Wywm9DZHe0QkHOXon30I5fklwG0gdqLAzMViptFlvtI";

const GROUP_LABELS = {
  rules: "Core rules",
  personality: "Personality (`SOUL.md`)",
  world: "World (`WORLD.md`)",
  plugins: "Plugin guidance",
  "available-skills": "Skills list",
  "active-mcp-catalogs": "Active MCP catalogs",
  "tool-guidance": "Tool guidance",
  workspaces: "Workspaces",
  "script-tools": "Code Mode script tools",
};
const MAX_CHANGED_ROWS = 15;

const number = new Intl.NumberFormat("en-US");

function sum(items) {
  return items.reduce((total, item) => total + item.tokens, 0);
}

function signed(value) {
  return value > 0 ? `+${number.format(value)}` : number.format(value);
}

// A table cell for a change. An unchanged row leaves it empty.
function change(value) {
  return value === 0 ? "" : signed(value);
}

function percent(part, whole) {
  return whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;
}

/** Throw unless the value has the shape that `measure-prompt-tokens.ts` writes. */
export function assertPromptTokenStats(stats) {
  const lists = ["sections", "tools", "skills"];
  if (
    stats?.version !== STATS_VERSION ||
    typeof stats.model !== "string" ||
    !lists.every(
      (list) =>
        Array.isArray(stats[list]) &&
        stats[list].every(
          (item) =>
            typeof item.name === "string" && Number.isInteger(item.tokens),
        ),
    )
  ) {
    throw new Error(`Not prompt token stats version ${STATS_VERSION}`);
  }
  return stats;
}

// The top-level parts, in prompt order: one per system prompt group, then
// the tool definitions.
function parts(stats) {
  const groups = new Map();
  for (const section of stats.sections) {
    groups.set(section.group, [...(groups.get(section.group) ?? []), section]);
  }
  return [
    ...[...groups].map(([group, sections]) => ({
      name: GROUP_LABELS[group] ?? group,
      tokens: sum(sections),
    })),
    { name: "Tool definitions", tokens: sum(stats.tools) },
  ];
}

/** The always-on token total of the stats. */
export function promptTokenTotal(stats) {
  return sum(stats.sections) + sum(stats.tools);
}

function byName(items) {
  return new Map(items.map((item) => [item.name, item.tokens]));
}

// Rows of items whose tokens differ from the base, largest change first.
function changedItems(kind, items, baseItems) {
  const current = byName(items);
  const base = byName(baseItems);
  const names = new Set([...current.keys(), ...base.keys()]);
  return [...names].flatMap((name) => {
    const tokens = current.get(name);
    const before = base.get(name);
    const delta = (tokens ?? 0) - (before ?? 0);
    if (delta === 0) return [];
    const note =
      before === undefined
        ? " (new)"
        : tokens === undefined
          ? " (removed)"
          : "";
    return [{ label: `${kind} \`${name}\`${note}`, tokens, delta }];
  });
}

function table(headers, rows) {
  const align = headers.map((_, index) => (index === 0 ? "---" : "---:"));
  return [headers, align, ...rows]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n");
}

function itemTable(heading, items, baseItems, total) {
  const base = baseItems ? byName(baseItems) : undefined;
  const headers = [heading, "Tokens", "Share", ...(base ? ["Change"] : [])];
  const rows = items.map((item) => [
    `\`${item.name}\``,
    number.format(item.tokens),
    percent(item.tokens, total),
    ...(base ? [change(item.tokens - (base.get(item.name) ?? 0))] : []),
  ]);
  return table(headers, rows);
}

function details(summary, body) {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

/** One-line result, such as `27,950 tokens (+120 vs 1a2b3c4)`. */
export function promptTokensTitle(stats, base, baseLabel = "base") {
  const total = promptTokenTotal(stats);
  const title = `${number.format(total)} tokens`;
  if (!base) return title;
  return `${title} (${signed(total - promptTokenTotal(base))} vs ${baseLabel})`;
}

/**
 * Render the Markdown report of the stats. With base stats, it adds the
 * change of each part and the items that changed.
 */
export function renderPromptTokensReport(stats, base, baseLabel = "base") {
  const total = promptTokenTotal(stats);
  const lines = [`## Always-on prompt: ${number.format(total)} tokens`, ""];
  if (base) {
    const delta = total - promptTokenTotal(base);
    lines.push(
      `${signed(delta)} tokens (${percent(delta, promptTokenTotal(base))}) vs ${baseLabel}.`,
      "",
    );
  }
  lines.push(
    `The system prompt and tool definitions of the first model request of a local Turn of the example app (\`${stats.model}\`). Tokens are estimated from characters.`,
    "",
  );

  const baseParts = base ? byName(parts(base)) : undefined;
  const partRows = parts(stats).map((part) => [
    part.name,
    number.format(part.tokens),
    percent(part.tokens, total),
    ...(baseParts
      ? [change(part.tokens - (baseParts.get(part.name) ?? 0))]
      : []),
  ]);
  partRows.push([
    "**Total**",
    `**${number.format(total)}**`,
    "100%",
    ...(base ? [`**${signed(total - promptTokenTotal(base))}**`] : []),
  ]);
  lines.push(
    table(["Part", "Tokens", "Share", ...(base ? ["Change"] : [])], partRows),
    "",
  );

  if (base) {
    const changed = [
      ...changedItems("section", stats.sections, base.sections),
      ...changedItems("tool", stats.tools, base.tools),
      ...changedItems("skill", stats.skills, base.skills),
    ].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    if (changed.length > 0) {
      lines.push(
        "**Changed**",
        "",
        table(
          ["Item", "Tokens", "Change"],
          changed
            .slice(0, MAX_CHANGED_ROWS)
            .map((item) => [
              item.label,
              item.tokens === undefined ? "-" : number.format(item.tokens),
              signed(item.delta),
            ]),
        ),
        "",
      );
      if (changed.length > MAX_CHANGED_ROWS) {
        lines.push(`${changed.length - MAX_CHANGED_ROWS} more changed.`, "");
      }
    }
  }

  lines.push(
    details(
      `System prompt sections (${stats.sections.length})`,
      itemTable("Section", stats.sections, base?.sections, total),
    ),
    "",
    details(
      `Tools (${stats.tools.length})`,
      itemTable("Tool", stats.tools, base?.tools, total),
    ),
    "",
    details(
      `Skills (${stats.skills.length})`,
      itemTable("Skill", stats.skills, base?.skills, total),
    ),
    "",
    `The Turn context adds ${number.format(stats.turnContext.tokens)} tokens to each request. It is not in the total.`,
  );
  return `${lines.join("\n")}\n`;
}

function readStats(file) {
  return assertPromptTokenStats(JSON.parse(fs.readFileSync(file, "utf8")));
}

// Run the measurement Turn in the example app with a fixed env, so local
// runs and CI measure the same prompt.
function measure(outputPath) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(JUNIOR_ROOT, "scripts", "measure-prompt-tokens.ts"),
      outputPath,
    ],
    {
      cwd: EXAMPLE_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AI_GATEWAY_API_KEY: "measure-prompt-tokens",
        DATABASE_URL: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
        JUNIOR_ENCRYPTION_KEYS: MEASURE_ENCRYPTION_KEYS,
        JUNIOR_SECRET: "measure-prompt-tokens",
        JUNIOR_STATE_ADAPTER: "memory",
        NODE_ENV: "development",
        TSX_TSCONFIG_PATH: path.join(JUNIOR_ROOT, "tsconfig.json"),
      },
      encoding: "utf8",
      // The Turn logs errors for the side model calls that the fake fails.
      // Show its output only when the measurement fails.
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`The measurement Turn failed (exit ${result.status})`);
  }
  return readStats(outputPath);
}

function main() {
  const { values } = parseArgs({
    options: { base: { type: "string" }, out: { type: "string" } },
  });
  const outputPath =
    values.out ??
    path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "prompt-tokens-")),
      "stats.json",
    );
  const stats = measure(path.resolve(outputPath));
  const base = values.base ? readStats(values.base) : undefined;
  process.stdout.write(renderPromptTokensReport(stats, base, values.base));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
