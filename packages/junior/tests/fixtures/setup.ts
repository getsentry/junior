import { afterEach } from "vitest";

// Release shared runtime handles after every test, including failed tests.
afterEach(async () => {
  const [{ closeDb }, { disconnectStateAdapter }] = await Promise.all([
    import("@/chat/db"),
    import("@/chat/state/adapter"),
  ]);
  await disconnectStateAdapter();
  await closeDb();
});
