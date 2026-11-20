import type { Nitro } from "nitro/types";

/**
 * Override rolldown's treeshake config so that module side effects survive
 * bundling.
 *
 * pi-ai registers API providers via a top-level side-effect in
 * register-builtins.js. Older Nitro builds set a moduleSideEffects allowlist
 * with only unenv polyfills, so rolldown tree-shook the registration call and
 * the apiProviderRegistry Map stayed empty at runtime
 * (https://github.com/nitrojs/nitro/issues/4085).
 *
 * TODO(dcramer): Remove this override when a production build shows that
 * pi-ai providers register without it. nitrojs/nitro#4164 removed the
 * allowlist, and every Nitro version that Junior supports includes that fix.
 */
export function applyRolldownTreeshakeWorkaround(nitro: Nitro): void {
  nitro.options.rolldownConfig = {
    ...nitro.options.rolldownConfig,
    treeshake: {
      ...(nitro.options.rolldownConfig?.treeshake as Record<string, unknown>),
      moduleSideEffects: true,
    },
  };
}
