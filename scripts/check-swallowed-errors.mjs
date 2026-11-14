import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Swallowed error check for production source. A `catch` that logs and then
 * continues makes a failure look recovered, so the owning boundary never sees
 * it. Each such catch must say why the code cannot rethrow or return.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const AST_GREP = path.join(REPO_ROOT, "node_modules/.bin/ast-grep");
// Test harness packages. They are not production source.
const EXCLUDED_PACKAGES = new Set(["junior-evals", "junior-testing"]);
const TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$|\/(?:__tests__|fixtures?)\//;
const SWALLOWED = "swallowed-error";
const MARKER_WITHOUT_REASON = "best-effort-marker-without-reason";
const MESSAGES = {
  [SWALLOWED]:
    "catch logs the error and continues. Rethrow it, or remove the catch so the error reaches the owning boundary (policies/error-handling.md). If the caller can handle the failure, return a typed failure result. Only when no caller can act on the error, such as at the top of a background task, make `// best-effort: <why the code cannot rethrow or return>` the first line of the block. A promise handler needs a block body for the marker, and a log function passed by reference, such as `.catch(console.error)`, needs a handler.",
  [MARKER_WITHOUT_REASON]:
    "best-effort marker has no reason. Write `// best-effort: <why the code cannot rethrow or return>`, or handle the error.",
};

// A handler is a `catch` clause, a function passed to `.catch()`, or the
// second function passed to `.then()`. It swallows when it reports the error
// (`log*` except `logContext*`, `capture*`, or a `log`, `logger`, or
// `console` method) and its last statement does not leave: a `throw`, a
// `throw*`, `rethrow*`, `reject`, or `fail` call, `process.exit`, or, in a
// catch clause only, a `return` of a real value. A `return` in a promise
// handler resolves the promise, so it swallows too. `return;` and a return of
// `undefined`, `[]`, `{}`, or a log call do not leave: they look like success.
// `null` and `false` leave, because the return type must declare them.
// A log function passed by reference, such as `.catch(console.error)`,
// always swallows.
const SWALLOWED_RULE = `utils:
  log-fn:
    any:
      - all:
          - kind: identifier
          - regex: '^(?:log|capture)[A-Z]'
          - not: { regex: '^logContext' }
      - kind: member_expression
        has:
          field: object
          regex: '(?:^|\\.)(?:log|logger|console)$'
      - kind: member_expression
        has:
          field: property
          regex: '^capture[A-Z]'
  log-call:
    kind: call_expression
    has: { field: function, matches: log-fn }
  # A nested catch clause is its own site.
  logs:
    has: { stopBy: { kind: catch_clause }, matches: log-call }
  hands-off:
    has:
      stopBy: end
      kind: call_expression
      has:
        field: function
        any:
          - kind: identifier
            regex: '^(?:(?:re)?[tT]hrow|reject$|fail$)'
          - pattern: process.exit
  empty-return:
    kind: return_statement
    any:
      - regex: '^return\\s*(?:undefined|\\[\\s*\\]|\\{\\s*\\})?\\s*;?$'
      - has: { matches: log-call }
  last-statement:
    nthChild:
      position: 1
      reverse: true
      ofRule: { not: { kind: comment } }
  rethrows:
    has:
      field: body
      has:
        matches: last-statement
        any:
          - kind: throw_statement
          - all:
              - kind: expression_statement
              - matches: hands-off
  returns:
    has:
      field: body
      has:
        matches: last-statement
        kind: return_statement
        not: { matches: empty-return }
  marked:
    has:
      field: body
      has:
        kind: comment
        nthChild: 1
        regex: '^//\\s*best-effort:.*\\w{3,}'
  promise-handler:
    any:
      - inside:
          kind: arguments
          inside:
            kind: call_expression
            has:
              field: function
              kind: member_expression
              has: { field: property, regex: '^catch$' }
      - all:
          - nthChild: 2
          - inside:
              kind: arguments
              inside:
                kind: call_expression
                has:
                  field: function
                  kind: member_expression
                  has: { field: property, regex: '^then$' }
rule:
  any:
    - all:
        - kind: catch_clause
        - matches: logs
        - not: { matches: rethrows }
        - not: { matches: returns }
        - not: { matches: marked }
    - all:
        - any:
            - kind: arrow_function
            - kind: function_expression
        - matches: promise-handler
        - matches: logs
        - any:
            - all:
                - has: { field: body, kind: statement_block }
                - not: { matches: rethrows }
                - not: { matches: marked }
            - all:
                - not: { has: { field: body, kind: statement_block } }
                - not: { has: { field: body, matches: hands-off } }
    - all:
        - matches: log-fn
        - matches: promise-handler`;
const MARKER_RULE = `rule:
  kind: comment
  regex: '^//\\s*best-effort\\b'
  not: { regex: '^//\\s*best-effort:.*\\w{3,}' }`;
const RULES = ["TypeScript", "Tsx"]
  .flatMap((language) => [
    `id: ${SWALLOWED}\nlanguage: ${language}\n${SWALLOWED_RULE}`,
    `id: ${MARKER_WITHOUT_REASON}\nlanguage: ${language}\n${MARKER_RULE}`,
  ])
  .join("\n---\n");

/** Say whether a repository path is production source that this check covers. */
export function isCheckedFile(filePath) {
  const [group, packageName, sourceDirectory] = filePath.split("/");
  return (
    group === "packages" &&
    sourceDirectory === "src" &&
    !EXCLUDED_PACKAGES.has(packageName) &&
    !TEST_FILE.test(filePath)
  );
}

/**
 * Find catches that log and continue without a `best-effort` reason, and
 * `best-effort` markers with no reason, with the ast-grep TypeScript parser.
 * Each error starts with `file:line`, relative to `root`. Only files that
 * `isCheckedFile` accepts are reported.
 */
export function findSwallowedErrors(root, targets) {
  const output = execFileSync(
    AST_GREP,
    ["scan", "--inline-rules", RULES, "--json=stream", ...targets],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const errors = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const match = JSON.parse(line);
    const file = match.file.split(path.sep).join("/");
    if (!isCheckedFile(file)) continue;
    errors.push(
      `${file}:${match.range.start.line + 1}: ${MESSAGES[match.ruleId]}`,
    );
  }
  return errors.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

function sourceDirectories(root) {
  return fs
    .readdirSync(path.join(root, "packages"))
    .filter((name) => !EXCLUDED_PACKAGES.has(name))
    .map((name) => `packages/${name}/src`)
    .filter((directory) => fs.existsSync(path.join(root, directory)));
}

function main() {
  const errors = findSwallowedErrors(REPO_ROOT, sourceDirectories(REPO_ROOT));
  if (errors.length === 0) {
    console.log("Production source has no swallowed errors.");
    return;
  }
  console.error(
    [
      "Swallowed error check failed:",
      ...errors,
      "Fix the code. Do not move the log into a helper to pass.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
