import type { Nitro } from "nitro/types";

/**
 * Override rolldown's treeshake config so that module side effects survive
 * bundling.
 *
 * pi-ai registers API providers via a top-level side-effect in
 * register-builtins.js. Nitro's default moduleSideEffects whitelist only
 * includes unenv polyfills, so rolldown tree-shakes the registration call
 * and the apiProviderRegistry Map stays empty at runtime.
 *
 * TODO(upstream): Track https://github.com/nitrojs/nitro/issues/XXXX for
 * native moduleSideEffects configuration support.
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
