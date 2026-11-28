import { afterAll, afterEach, beforeEach } from "vitest";
import type { AppContext } from "@/app/context";
import { importAppContextModules } from "./app-context-modules";

// Each test gets its own context unless its file installed one, such as with
// createApp in `beforeAll`. It builds on its first read, after the env that a
// test sets, like the suite config. A test that resets modules installs its
// own with `useFreshAppContext()`.
let testContext: AppContext | undefined;
let built: AppContext | undefined;
let fileContext: AppContext | undefined;
// Set when this file's modules can build a context, so the hooks below skip
// a file that mocks `@/app/context`.
let installable = false;

beforeEach(async () => {
  testContext = undefined;
  built = undefined;
  // A file whose mocks leave out a module of the context gets no context, and
  // `getAppContext()` then fails in its tests.
  const modules = await importAppContextModules().catch(() => undefined);
  installable = modules !== undefined;
  if (!modules) return;
  fileContext = modules.install(undefined);
  if (fileContext) {
    modules.install(fileContext);
    return;
  }
  testContext = new Proxy({} as AppContext, {
    get: (_target, key) => (built ??= modules.build())[key as keyof AppContext],
  });
  modules.install(testContext);
});

// Close the context of the test and any context that the test installed,
// such as with createApp, and put back the file's context. Title work runs
// in the background and writes its Conversation, so it ends in the test that
// started it.
afterEach(async () => {
  if (!installable) return;
  const { installAppContext } = await import("@/app/context");
  const current = installAppContext(fileContext);
  const contexts = new Set([
    current === testContext || current === fileContext ? undefined : current,
    built,
  ]);
  testContext = undefined;
  built = undefined;
  for (const context of contexts) {
    if (!context) continue;
    await Promise.allSettled(context.conversationTitles.values());
    await context.close();
  }
});

// Release the file's context. Files in a worker can share modules, so the
// next file then starts with no context.
afterAll(async () => {
  if (!installable) return;
  installable = false;
  const { installAppContext } = await import("@/app/context");
  const current = installAppContext(undefined);
  fileContext = undefined;
  await current?.close();
});
