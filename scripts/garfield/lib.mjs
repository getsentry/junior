import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const NATIVE_LANES = [
  {
    id: "behavior-spec",
    title: "Behavior/spec",
    always: true,
    card: "references/review-lanes.md#behavior-spec",
  },
  {
    id: "repository-instructions",
    title: "Repository instructions",
    always: true,
    card: "references/review-lanes.md#repository-instructions",
  },
  {
    id: "validation-sufficiency",
    title: "Validation sufficiency",
    always: true,
    card: "references/review-lanes.md#validation-sufficiency",
  },
  {
    id: "specs-docs",
    title: "Specs/docs",
    always: false,
    card: "references/review-lanes.md#specsdocs",
    match: (ctx) =>
      matchesAny(ctx.changedFiles, [
        /(^|\/)(README|AGENTS|CONTRIBUTING|TERMINOLOGY|TELEMETRY)\.md$/i,
        /(^|\/)docs\//,
        /(^|\/)packages\/docs\//,
        /\.mdx?$/,
        /SPEC\.md$/i,
        /SOURCES\.md$/i,
      ]) || ctx.touchesBehaviorishCode,
  },
  {
    id: "dead-code",
    title: "Dead code",
    always: false,
    card: "references/review-lanes.md#dead-code",
    match: (ctx) =>
      ctx.statusLetters.some((letter) => /[DTRC]/.test(letter)) ||
      ctx.touchesCode,
  },
  {
    id: "delayering",
    title: "Delayering",
    always: false,
    card: "references/review-lanes.md#delayering",
    match: (ctx) => ctx.touchesCode,
  },
  {
    id: "type-boundaries",
    title: "Type boundaries",
    always: false,
    card: "references/review-lanes.md#type-boundaries",
    match: (ctx) =>
      matchesAny(ctx.changedFiles, [/\.tsx?$/, /\.jsx?$/, /\.mjs$/, /\.cjs$/]),
  },
  {
    id: "generated-dependencies",
    title: "Generated/dependencies",
    always: false,
    card: "references/review-lanes.md#generateddependencies",
    match: (ctx) =>
      matchesAny(ctx.changedFiles, [
        /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json)$/,
        /(^|\/)migrations?\//,
        /\.sql$/,
        /schema/,
        /generated\//,
        /\.craft\.yml$/,
        /vitest-evals\/recordings\//,
      ]),
  },
  {
    id: "code-comments",
    title: "Code comments",
    always: false,
    card: "references/code-comments.md",
    match: (ctx) => ctx.touchesCode,
  },
  {
    id: "implementation-minimalism",
    title: "Implementation minimalism",
    always: false,
    card: "references/implementation-minimalism.md",
    match: (ctx) => ctx.touchesCode,
  },
  {
    id: "interface-design",
    title: "Interface design",
    always: false,
    card: "references/interface-design.md",
    match: (ctx) =>
      matchesAny(ctx.changedFiles, [
        /\.[cm]?[jt]sx?$/,
        /plugin\.yaml$/,
        /SKILL\.md$/,
      ]),
  },
  {
    id: "test-quality",
    title: "Test quality",
    always: false,
    card: "references/test-quality.md",
    match: (ctx) =>
      matchesAny(ctx.changedFiles, [
        /\.test\.[cm]?[jt]sx?$/,
        /\.spec\.[cm]?[jt]sx?$/,
        /(^|\/)tests?\//,
        /(^|\/)__tests__\//,
        /\.eval\.ts$/,
      ]) || ctx.touchesBehaviorishCode,
  },
];

const CODE_RE = /\.(?:[cm]?[jt]sx?|mjs|cjs)$/;
const BEHAVIOR_CODE_RE =
  /\.(?:[cm]?[jt]sx?)$|SKILL\.md$|plugin\.yaml$|\/chat\/|\/runtime\/|\/tools\//;

/** Resolve the monorepo root from this file or an explicit override. */
export function resolveRepoRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  while (true) {
    if (
      fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) &&
      fs.existsSync(path.join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(cwd);
    }
    dir = parent;
  }
}

/** Parse CLI flags of the form --key value and --key=value. Repeated keys become arrays. */
export function parseArgs(argv) {
  const out = { _: [] };
  const assign = (key, value) => {
    if (out[key] === undefined) {
      out[key] = value;
      return;
    }
    if (Array.isArray(out[key])) {
      out[key].push(value);
      return;
    }
    out[key] = [out[key], value];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      assign(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      assign(body, true);
      continue;
    }
    assign(body, next);
    i += 1;
  }
  return out;
}

/** Ensure a directory exists. */
export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/** Read JSON or throw a short error. */
export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** Write JSON with a trailing newline. */
export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Stable sha256 of text. */
export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Run a git command and return stdout, or throw. */
export function git(repoRoot, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${stderr || "no output"}`,
    );
  }
  return (result.stdout || "").replace(/\n$/, "");
}

/** Resolve the merge-base style review base for a dirty or clean worktree. */
export function resolveBaseRef(repoRoot, explicitBase) {
  if (explicitBase) {
    return explicitBase;
  }
  if (process.env.GARFIELD_BASE) {
    return process.env.GARFIELD_BASE;
  }
  try {
    return git(repoRoot, ["merge-base", "HEAD", "origin/main"]);
  } catch {
    try {
      return git(repoRoot, ["merge-base", "HEAD", "main"]);
    } catch {
      return git(repoRoot, ["rev-parse", "HEAD^"]);
    }
  }
}

/** Collect changed files between base and the current worktree, including unstaged. */
export function collectChangedFiles(repoRoot, baseRef) {
  const names = new Map();

  const addLines = (text, defaultStatus = "M") => {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      // --name-status can be "M\tpath" or "R100\told\tnew"
      const parts = line.split("\t");
      if (parts.length === 1) {
        names.set(parts[0], defaultStatus);
        continue;
      }
      const status = parts[0];
      const filePath = parts[parts.length - 1];
      names.set(filePath, status);
    }
  };

  addLines(git(repoRoot, ["diff", "--name-status", `${baseRef}...HEAD`]));
  addLines(git(repoRoot, ["diff", "--name-status", "HEAD"]));
  addLines(git(repoRoot, ["ls-files", "--others", "--exclude-standard"]), "A");

  return [...names.entries()]
    .map(([filePath, status]) => ({ path: filePath, status }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** List policy files under policies/, excluding README and templates. */
export function listPolicies(repoRoot) {
  const policiesDir = path.join(repoRoot, "policies");
  if (!fs.existsSync(policiesDir)) {
    return [];
  }
  return fs
    .readdirSync(policiesDir)
    .filter(
      (name) =>
        name.endsWith(".md") &&
        name !== "README.md" &&
        name !== "policy-template.md",
    )
    .sort()
    .map((name) => `policies/${name}`);
}

/** Map changed paths onto pnpm package filters. */
export function packagesForFiles(repoRoot, files) {
  const packages = new Set();
  for (const file of files) {
    const match = file.path.match(/^packages\/([^/]+)\//);
    if (!match) continue;
    const dir = match[1];
    const packageJsonPath = path.join(
      repoRoot,
      "packages",
      dir,
      "package.json",
    );
    if (!fs.existsSync(packageJsonPath)) continue;
    const pkg = readJson(packageJsonPath);
    if (pkg.name) packages.add(pkg.name);
  }
  return [...packages].sort();
}

/** Build deterministic validation commands for the slice. */
export function buildValidationCommands(packages) {
  const commands = [
    {
      id: "file-length",
      command: "pnpm file-length:check",
      required: true,
    },
    {
      id: "test-architecture",
      command: "pnpm test-architecture:check",
      required: true,
    },
  ];

  if (packages.length > 0) {
    for (const pkg of packages) {
      commands.push({
        id: `typecheck:${pkg}`,
        command: `pnpm --filter ${pkg} run typecheck`,
        required: false,
      });
      if (pkg === "@sentry/junior") {
        commands.push({
          id: `skills-check`,
          command: "pnpm skills:check",
          required: false,
        });
      }
    }
  } else {
    commands.push({
      id: "typecheck",
      command: "pnpm typecheck",
      required: false,
    });
  }

  return commands;
}

function matchesAny(files, patterns) {
  return files.some((file) => patterns.some((re) => re.test(file)));
}

/** Build the slice context used by lane classification. */
export function buildSliceContext(changedFiles) {
  const paths = changedFiles.map((file) => file.path);
  const statusLetters = changedFiles.map((file) => file.status[0] || "M");
  return {
    changedFiles: paths,
    statusLetters,
    touchesCode: paths.some((filePath) => CODE_RE.test(filePath)),
    touchesBehaviorishCode: paths.some((filePath) =>
      BEHAVIOR_CODE_RE.test(filePath),
    ),
  };
}

/** Classify native lanes plus one lane per source policy. */
export function classifyLanes(changedFiles, policies) {
  const ctx = buildSliceContext(changedFiles);
  const lanes = [];

  for (const lane of NATIVE_LANES) {
    if (lane.always || lane.match?.(ctx)) {
      lanes.push({
        id: lane.id,
        title: lane.title,
        kind: "native",
        status: "applicable",
        reason: lane.always
          ? "always applicable"
          : "matched current diff signals",
        card: lane.card,
        modelHint: modelHintForLane(lane.id),
      });
    } else {
      lanes.push({
        id: lane.id,
        title: lane.title,
        kind: "native",
        status: "skipped",
        reason: "no diff signal for this lane",
        card: lane.card,
        modelHint: modelHintForLane(lane.id),
      });
    }
  }

  for (const policyPath of policies) {
    const id = `policy:${policyPath}`;
    const title = path.basename(policyPath, ".md");
    // Source-app policies are always considered; cheap/narrow reviewers still
    // only receive the one policy file.
    lanes.push({
      id,
      title: `Policy: ${title}`,
      kind: "policy",
      status: "applicable",
      reason: "source-app policy is always reviewed against the slice",
      card: policyPath,
      modelHint: "cheap",
    });
  }

  return lanes;
}

function modelHintForLane(id) {
  if (
    id === "behavior-spec" ||
    id === "validation-sufficiency" ||
    id === "interface-design" ||
    id === "test-quality"
  ) {
    return "strong";
  }
  return "cheap";
}

/** Default run directory under .swamp/garfield/<id>. */
export function defaultRunDir(repoRoot, runId) {
  return path.join(repoRoot, ".swamp", "garfield", runId);
}

/** Create a short run id. */
export function createRunId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `run-${stamp}-${sha256(String(Math.random())).slice(0, 8)}`;
}

/** Build the review bundle artifact. */
export function buildBundle({
  repoRoot,
  goal,
  nonGoals = [],
  baseRef,
  headRef = "WORKTREE",
  runId,
}) {
  const resolvedBase = resolveBaseRef(repoRoot, baseRef);
  const changedFiles = collectChangedFiles(repoRoot, resolvedBase);
  const policies = listPolicies(repoRoot);
  const packages = packagesForFiles(repoRoot, changedFiles);
  const validationCommands = buildValidationCommands(packages);
  const status = git(repoRoot, ["status", "--short"]);
  const headSha = git(repoRoot, ["rev-parse", "HEAD"]);

  const bundle = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    goal,
    nonGoals,
    repoRoot,
    baseRef: resolvedBase,
    headRef,
    headSha,
    statusShort: status,
    changedFiles,
    packages,
    policies,
    validationCommands,
    contentHash: "",
  };

  bundle.contentHash = sha256(
    JSON.stringify({
      goal: bundle.goal,
      nonGoals: bundle.nonGoals,
      baseRef: bundle.baseRef,
      headSha: bundle.headSha,
      changedFiles: bundle.changedFiles,
      policies: bundle.policies,
    }),
  );

  return bundle;
}

/** Parse Garfield finding lines and freeform none. */
export function parseFindings(text, laneId) {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "none" || /^none\b/i.test(trimmed)) {
    return [];
  }

  const findings = [];
  const lineRe =
    /^\[(?<severity>blocker|high|medium|low)\]\[evidence:(?<evidence>[^\]]+)\]\s+(?<locator>\S+)\s+-\s+(?<concern>.*?)\s+impact:\s+(?<impact>.*?)\s+fix:\s+(?<fix>.*?)\s*$/i;

  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (!candidate) continue;
    const match = candidate.match(lineRe);
    if (!match?.groups) {
      findings.push({
        laneId,
        severity: "low",
        evidence: ["inferred"],
        locator: "unparsed",
        concern: candidate,
        impact: "parser could not read structured finding line",
        fix: "rewrite using the Garfield finding format",
        raw: candidate,
        valid: false,
      });
      continue;
    }
    const causeMatch = match.groups.evidence.match(/;cause:([a-z-]+)/i);
    const evidencePart = match.groups.evidence.split(";")[0];
    const evidenceBits = evidencePart.split(/\s+/);
    const labels = evidenceBits[0].split(",").map((part) => part.trim());
    findings.push({
      laneId,
      severity: match.groups.severity.toLowerCase(),
      evidence: labels,
      evidenceLocator: evidenceBits.slice(1).join(" ") || undefined,
      cause: causeMatch?.[1]?.toLowerCase(),
      locator: match.groups.locator,
      concern: match.groups.concern.trim(),
      impact: match.groups.impact.trim(),
      fix: match.groups.fix.trim(),
      raw: candidate,
      valid: true,
    });
  }
  return findings;
}

/** Cluster findings by locator + normalized concern. */
export function mergeFindings(findings) {
  const clusters = new Map();
  for (const finding of findings) {
    const key = `${finding.locator}::${normalizeConcern(finding.concern)}`;
    const existing = clusters.get(key);
    if (!existing) {
      clusters.set(key, {
        key,
        locator: finding.locator,
        concern: finding.concern,
        severity: finding.severity,
        impact: finding.impact,
        fix: finding.fix,
        lanes: [finding.laneId],
        evidence: [...finding.evidence],
        findings: [finding],
      });
      continue;
    }
    existing.lanes.push(finding.laneId);
    existing.evidence.push(...finding.evidence);
    existing.findings.push(finding);
    existing.severity = worseSeverity(existing.severity, finding.severity);
  }
  return [...clusters.values()].sort((a, b) => {
    const rank = severityRank(b.severity) - severityRank(a.severity);
    if (rank !== 0) return rank;
    return a.locator.localeCompare(b.locator);
  });
}

function normalizeConcern(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function severityRank(severity) {
  switch (severity) {
    case "blocker":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function worseSeverity(a, b) {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/** Render a no-edit reviewer prompt for one lane. */
export function renderLanePrompt({ bundle, lane, runDir }) {
  const files = bundle.changedFiles
    .map((file) => `- ${file.status} ${file.path}`)
    .join("\n");
  const nonGoals =
    bundle.nonGoals.length > 0
      ? bundle.nonGoals.map((item) => `- ${item}`).join("\n")
      : "- (none provided)";

  return `# Garfield lane: ${lane.title}

You are a no-edit reviewer. Do not modify files. Return findings only.

## Goal
${bundle.goal}

## Non-goals
${nonGoals}

## Slice
- base: ${bundle.baseRef}
- head: ${bundle.headRef} (${bundle.headSha})
- run: ${bundle.runId}
- bundle: ${path.join(runDir, "bundle.json")}

## Changed files
${files || "- (none)"}

## Your ownership
- kind: ${lane.kind}
- card/policy: ${lane.card}
- model hint: ${lane.modelHint}

Read only your card/policy plus the slice context above. Do not review unrelated concerns.

## Output contract
If no current-diff-caused findings exist, return exactly:
none

Otherwise return one finding per line:
[severity][evidence:<label[,label]> <locator>;cause:introduced|worsened|stale|missing-required] path:line - concern. impact: <impact>. fix: <smallest change>.

Rules:
- severity is blocker|high|medium|low
- never accept inferred alone as a blocker
- only report defects caused or made material by the current diff
- no speculative hardening, API expansion, or unrelated cleanup
`;
}

/** Build the final markdown/json report. */
export function buildReport({
  bundle,
  lanes,
  clusters,
  validationResults,
  status,
}) {
  const applicable = lanes.filter((lane) => lane.status === "applicable");
  const skipped = lanes.filter((lane) => lane.status === "skipped");
  const open = clusters.filter((cluster) =>
    ["blocker", "high"].includes(cluster.severity),
  );

  const lines = [
    `# garfield: ${status}`,
    "",
    `run: ${bundle.runId}`,
    `goal: ${bundle.goal}`,
    `base: ${bundle.baseRef}`,
    `head: ${bundle.headSha}`,
    `changed files: ${bundle.changedFiles.length}`,
    `applicable lanes: ${applicable.length}`,
    `skipped lanes: ${skipped.length}`,
    `clusters: ${clusters.length}`,
    "",
    "## Validation",
  ];

  if (validationResults.length === 0) {
    lines.push("- (none run)");
  } else {
    for (const result of validationResults) {
      lines.push(
        `- ${result.id}: ${result.ok ? "pass" : "fail"} (\`${result.command}\`)`,
      );
    }
  }

  lines.push("", "## Findings");
  if (clusters.length === 0) {
    lines.push("- none");
  } else {
    for (const cluster of clusters) {
      lines.push(
        `- [${cluster.severity}] ${cluster.locator} — ${cluster.concern} (lanes: ${cluster.lanes.join(", ")})`,
      );
    }
  }

  if (open.length > 0) {
    lines.push("", "## Residual blocker/high");
    for (const cluster of open) {
      lines.push(`- ${cluster.locator}: ${cluster.concern}`);
    }
  }

  lines.push("");
  return {
    markdown: lines.join("\n"),
    json: {
      status,
      runId: bundle.runId,
      goal: bundle.goal,
      baseRef: bundle.baseRef,
      headSha: bundle.headSha,
      applicableLanes: applicable.map((lane) => lane.id),
      skippedLanes: skipped.map((lane) => lane.id),
      clusters,
      validationResults,
      openBlockerHigh: open,
    },
  };
}

/** Convenience for scripts that live beside this module. */
export function scriptsDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}
