import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findSwallowedErrors,
  isCheckedFile,
} from "./check-swallowed-errors.mjs";

const FILE = "packages/junior/src/feature.ts";

function locations(errors) {
  return errors.map((error) => error.slice(0, error.indexOf(": ")));
}

function findIn(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swallowed-errors-"));
  try {
    for (const [filePath, contents] of Object.entries(files)) {
      fs.mkdirSync(path.join(root, path.dirname(filePath)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, filePath), contents);
    }
    return findSwallowedErrors(root, ["packages"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("finds catches that log and continue with the parser", () => {
  const found = findIn({
    [FILE]: [
      // Found: log and continue, through each reporting form.
      'try { run(); } catch (error) { logWarn("a.failed"); }',
      'try { run(); } catch { logger.error("b.failed"); }',
      'try { run(); } catch { ctx.log.warn("c.failed"); }',
      "try { run(); } catch (e) { console.error(e); }",
      "try { run(); } catch (e) { captureException(e); }",
      "try { run(); } catch (e) { Sentry.captureException(e); }",
      // Found: a fallback assignment still continues.
      'try { value = run(); } catch (e) { logException(e, "e.failed"); value = fallback; }',
      // Found: a return that looks like success.
      'try { run(); } catch (e) { logWarn("f.failed"); return; }',
      'try { run(); } catch (e) { logWarn("g.failed"); return undefined; }',
      'try { run(); } catch (e) { logWarn("h.failed"); return []; }',
      'try { run(); } catch (e) { return logWarn("i.failed"); }',
      // Found: only the last statement counts, so a conditional throw swallows.
      'try { run(); } catch (e) { if (fatal(e)) throw e; logWarn("j.failed"); }',
      "try { run(); } catch (e) { logError(e); items.map((item) => { throw item; }); }",
      // Not found: the error leaves the catch.
      'try { run(); } catch (e) { logException(e, "k.failed"); throw e; }',
      'try { run(); } catch (e) { if (!fatal(e)) { logWarn("l.retry"); } throw e; }',
      'try { run(); } catch (e) { logWarn("m.failed"); return { ok: false, error: e }; }',
      'try { run(); } catch (e) { logWarn("n.failed"); return false; }',
      "try { run(); } catch (e) { logError(e); throwApiError(e); }",
      'try { run(); } catch (e) { return failedResponse(logException(e, "p.failed")); }',
      "try { run(); } catch (e) { logError(e); reject(e); }",
      "try { run(); } catch (e) { console.error(e); process.exit(1); }",
      // Not found: no reporting call.
      "try { run(); } catch { value = fallback; }",
      '// catch (e) { logWarn("comment"); }',
    ].join("\n"),
    "packages/junior/src/view.tsx":
      'const a = () => { try { run(); } catch { logWarn("o.failed"); } return <div />; };',
    "packages/junior/src/feature.test.ts":
      'try { run(); } catch { logWarn("test.failed"); }',
  });
  assert.deepEqual(locations(found), [
    ...Array.from({ length: 13 }, (_, index) => `${FILE}:${index + 1}`),
    "packages/junior/src/view.tsx:1",
  ]);
});

test("finds promise handlers that log and continue", () => {
  const found = findIn({
    [FILE]: [
      // Found: a return in a promise handler resolves the promise.
      'task.catch((e) => { logWarn("a.failed"); return []; });',
      'task.catch((e) => logWarn("b.failed"));',
      "task.catch((e) => void logWarn(e));",
      "task.catch((e) => (logWarn(e), undefined));",
      "task.catch(function (e) { logger.warn(e); });",
      'task.then(done, (e) => { logException(e, "c.failed"); });',
      "task.catch(console.error);",
      "task.then(done, logException);",
      // Not found: the handler rethrows, or does not report.
      'task.catch((e) => { logWarn("d.failed"); throw e; });',
      "task.catch((e) => rethrowAsToolError(e));",
      "task.then((value) => logInfo(value));",
      "task.catch(() => undefined);",
    ].join("\n"),
  });
  assert.deepEqual(
    locations(found),
    Array.from({ length: 8 }, (_, index) => `${FILE}:${index + 1}`),
  );
});

test("reports a nested catch on its own", () => {
  const found = findIn({
    [FILE]: [
      "try { run(); } catch (error) {",
      '  try { undo(); } catch (undoError) { logWarn("undo.failed"); }',
      "  throw error;",
      "}",
    ].join("\n"),
  });
  assert.deepEqual(locations(found), [`${FILE}:2`]);
});

test("tells the agent how to fix a swallowed error", () => {
  const [error] = findIn({
    [FILE]: 'try { run(); } catch (error) { logWarn("a.failed"); }',
  });
  assert.match(
    error,
    /^packages\/junior\/src\/feature\.ts:1: .*Rethrow.*policies\/error-handling\.md.*typed failure.*\/\/ best-effort: <why the code cannot rethrow or return>/,
  );
});

test("accepts a best-effort marker with a reason", () => {
  const found = findIn({
    [FILE]: [
      "try { run(); } catch (error) {",
      "  // best-effort: the next heartbeat retries this cleanup.",
      '  logWarn("cleanup.failed");',
      "}",
      "task.catch((error) => {",
      "  // best-effort: no caller awaits this timer callback.",
      '  logWarn("timer.failed");',
      "});",
    ].join("\n"),
  });
  assert.deepEqual(locations(found), []);
});

test("rejects a best-effort marker without a reason or out of place", () => {
  const found = findIn({
    [FILE]: [
      "try { run(); } catch (error) {",
      "  // best-effort:",
      '  logWarn("cleanup.failed");',
      "}",
      "try { run(); } catch (error) {",
      "  // best-effort: -",
      '  logWarn("cleanup.failed");',
      "}",
      "try { run(); } catch (error) {",
      '  logWarn("cleanup.failed");',
      "  // best-effort: the marker must come first.",
      "}",
    ].join("\n"),
  });
  assert.deepEqual(locations(found), [
    `${FILE}:1`,
    `${FILE}:2`,
    `${FILE}:5`,
    `${FILE}:6`,
    `${FILE}:9`,
  ]);
});

test("checks production source only", () => {
  assert.equal(isCheckedFile("packages/junior/src/chat/app.ts"), true);
  assert.equal(isCheckedFile("packages/junior-github/src/index.ts"), true);
  for (const filePath of [
    "packages/junior/src/chat/app.test.ts",
    "packages/junior-dashboard/src/client/view.spec.tsx",
    "packages/junior/src/chat/__tests__/app.ts",
    "packages/junior/src/fixtures/app.ts",
    "packages/junior/tests/integration/app.test.ts",
    "packages/junior-evals/src/fixture/agent.ts",
    "packages/junior-testing/src/postgres.ts",
    "scripts/check-swallowed-errors.mjs",
  ]) {
    assert.equal(isCheckedFile(filePath), false, filePath);
  }
});
