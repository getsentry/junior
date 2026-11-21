/**
 * The default `createApp()` options of the memory suite. Each test in the
 * suite runs on an agent with these options. Memory is a core feature, so
 * the suite needs no plugin.
 */
import type { JuniorAppOptions } from "@sentry/junior";

export default {} satisfies JuniorAppOptions;
