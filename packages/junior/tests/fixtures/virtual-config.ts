import { createRequire } from "node:module";

// Keep Node's missing-module error when a test removes the Nitro config mock.
createRequire(import.meta.url)("#junior/config");
