// The AI emulator server of one test worker. Integration files share a
// worker once isolation is off, and this module then loads once per worker.
// The first file that loads `ai-emulator.ts` starts the server. It serves
// every later file in the worker and stops when the worker exits, so no
// file closes it under another file. `setup.ts` resets it after each test.
import type { Emulator } from "emulate";

let server: Promise<Emulator> | undefined;

/** Start this worker's AI emulator, or return the one that runs. */
export function startAiEmulator(): Promise<Emulator> {
  server ??= import("emulate").then(({ createEmulator }) =>
    createEmulator({ service: "ai", port: 0 }),
  );
  return server;
}

/** Clear the emulator's rules and recorded calls, if the worker started it. */
export async function resetAiEmulator(): Promise<void> {
  if (!server) return;
  const response = await fetch(new URL("/_ai/reset", (await server).url), {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `AI emulator reset failed with ${response.status}: ${await response.text()}`,
    );
  }
}
