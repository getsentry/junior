import { createRequire } from "node:module";

// Keep Node's missing-module error, so the runtime builds the system prompts
// from the registered plugins, as it does with no Nitro build.
createRequire(import.meta.url)("#junior/system-prompts");
