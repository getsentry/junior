import {
  mention,
  reply,
  type HistoryItem,
  type HistoryToolCall,
} from "@junior-evals/fixture/inputs";

const workObjectPath =
  "skills/coding-workspace-fixture/project/src/work-object.ts";

// The file as the live continuation finds it: stable IDs are done, and the
// class and factory are still there.
const workObjectSource = `type WorkObject = { provider: string; key: string };

class WorkObjectIdentityManager {
  constructor(private readonly object: WorkObject) {}

  getIdentity(): string {
    return JSON.stringify([this.object.provider, this.object.key]);
  }
}

function createWorkObjectIdentityManager(object: WorkObject) {
  return new WorkObjectIdentityManager(object);
}

export function workObjectId(object: WorkObject): string {
  return createWorkObjectIdentityManager(object).getIdentity();
}
`;

const stableIdEdits = [
  {
    oldText:
      "constructor(private readonly object: WorkObject, private readonly threadId: string) {}",
    newText: "constructor(private readonly object: WorkObject) {}",
  },
  {
    oldText:
      "JSON.stringify([this.threadId, this.object.provider, this.object.key])",
    newText: "JSON.stringify([this.object.provider, this.object.key])",
  },
  {
    oldText:
      "function createWorkObjectIdentityManager(object: WorkObject, threadId: string) {\n  return new WorkObjectIdentityManager(object, threadId);",
    newText:
      "function createWorkObjectIdentityManager(object: WorkObject) {\n  return new WorkObjectIdentityManager(object);",
  },
  {
    oldText:
      "export function workObjectId(object: WorkObject, threadId: string): string {\n  return createWorkObjectIdentityManager(object, threadId).getIdentity();",
    newText:
      "export function workObjectId(object: WorkObject): string {\n  return createWorkObjectIdentityManager(object).getIdentity();",
  },
];

const stableIdDiff = [
  "  1 type WorkObject = { provider: string; key: string };",
  "  2 ",
  "  3 class WorkObjectIdentityManager {",
  "- 4   constructor(private readonly object: WorkObject, private readonly threadId: string) {}",
  "+ 4   constructor(private readonly object: WorkObject) {}",
  "  5 ",
  "  6   getIdentity(): string {",
  "- 7     return JSON.stringify([this.threadId, this.object.provider, this.object.key]);",
  "+ 7     return JSON.stringify([this.object.provider, this.object.key]);",
  "  8   }",
  "  9 }",
  " 10 ",
  "-11 function createWorkObjectIdentityManager(object: WorkObject, threadId: string) {",
  "-12   return new WorkObjectIdentityManager(object, threadId);",
  "+11 function createWorkObjectIdentityManager(object: WorkObject) {",
  "+12   return new WorkObjectIdentityManager(object);",
  " 13 }",
  " 14 ",
  "-15 export function workObjectId(object: WorkObject, threadId: string): string {",
  "-16   return createWorkObjectIdentityManager(object, threadId).getIdentity();",
  "+15 export function workObjectId(object: WorkObject): string {",
  "+16   return createWorkObjectIdentityManager(object).getIdentity();",
  " 17 }",
].join("\n");

const stableIdCheck = `node --experimental-transform-types --disable-warning=ExperimentalWarning --input-type=module -e 'import { workObjectId } from "./${workObjectPath}"; const object = {provider:"github",key:"example/widgets#42"}; if (workObjectId(object) !== JSON.stringify([object.provider, object.key])) throw new Error("unstable ID"); console.log("stable ID check passed")'`;

// Prior work must match the file the live continuation will find. Without the
// tool output, the summaries treated that work as an unverified assistant claim.
const completedImplementation: HistoryToolCall[] = [
  {
    name: "editFile",
    arguments: { path: workObjectPath, edits: stableIdEdits },
    result: {
      path: workObjectPath,
      target: workObjectPath,
      replacements: stableIdEdits.length,
      first_changed_line: 4,
      truncated: false,
      diff: stableIdDiff,
    },
  },
  {
    name: "bash",
    arguments: { command: `cat ${workObjectPath} && ${stableIdCheck}` },
    result: {
      exit_code: 0,
      stdout: `${workObjectSource}\nstable ID check passed\n`,
      stderr: "",
      timed_out: false,
    },
  },
];

const eventAuthor = { userId: "UJRNEVENT", fullName: "Junior event" };

const maintenance = [
  "[task]",
  "This is a task, not a message from a person.",
  "About: GitHub PR example/widgets#42",
  "Instructions: Maintain pull requests Junior creates. For actionable review feedback or failed checks, inspect the evidence, make scoped fixes, verify them, and push. After fixing review feedback, resolve the corresponding review threads without asking for confirmation.",
  "Report completed work or blockers in the originating thread. Report when the pull request merges or closes unmerged. Otherwise stay silent.",
  "Treat a comment as review feedback only when it identifies a problem or requests a code change.",
].join("\n");

/** Completed coding work, then old maintenance instructions. */
export function handoffHistory(): HistoryItem[] {
  return [
    mention(
      "Make Work Object IDs stable across threads in skills/coding-workspace-fixture/project/src/work-object.ts. Keep this local; do not push or edit GitHub. Use editFile for source changes so I can review the diff.",
    ),
    reply(
      "Implemented stable IDs in work-object.ts using WorkObjectIdentityManager and createWorkObjectIdentityManager. workObjectId returns JSON.stringify([object.provider, object.key]). The Node check passed. Changes remain local. Old references stop working; live Slack rendering is unverified.",
      { toolHistory: completedImplementation },
    ),
    // Junior stayed silent on both maintenance tasks.
    mention(`${maintenance}\nA deployment bot posted a preview URL.`, {
      author: eventAuthor,
    }),
    mention(
      `${maintenance}\nA CI bot posted a screenshot report. No code change requested.`,
      { author: eventAuthor },
    ),
    mention("idk what that caveat"),
    reply(
      "Old cards return not_found. New cards use the new lookup. Live rendering is not verified.",
    ),
    mention("that's fine I just need it to work going forward"),
    reply(
      "Keeping the clean cutover, no compatibility layer. New cards use stable IDs.",
    ),
  ];
}
