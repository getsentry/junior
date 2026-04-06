import path from "node:path";
import type { Nitro } from "nitro/types";
import { applyRolldownTreeshakeWorkaround } from "@/build/rolldown-workarounds";
import {
  copyAppAndPluginContent,
  copyIncludedFiles,
} from "@/build/copy-build-content";
import { injectVirtualConfig } from "@/build/virtual-config";

export interface JuniorNitroOptions {
  cwd?: string;
  maxDuration?: number;
  pluginPackages?: string[];
  /**
   * Extra file patterns to copy into the server output for files that the
   * bundler cannot trace (e.g. dynamically imported providers).
   * Each entry is `"<package-name>/<subpath-glob>"`, resolved via Node
   * module resolution. Example: `"@mariozechner/pi-ai/dist/providers/*.js"`
   */
  includeFiles?: string[];
}

/** Nitro module that copies app and plugin content into the Vercel build output. */
export function juniorNitro(options: JuniorNitroOptions = {}): {
  nitro: { setup(nitro: unknown): void };
} {
  return {
    nitro: {
      setup(nitro: Nitro) {
        const cwd = path.resolve(
          options.cwd ?? nitro.options.rootDir ?? process.cwd(),
        );

        nitro.options.vercel ??= {};
        nitro.options.vercel.functions ??= {};
        nitro.options.vercel.functions.maxDuration ??=
          options.maxDuration ?? 800;

        applyRolldownTreeshakeWorkaround(nitro);
        injectVirtualConfig(nitro, options.pluginPackages ?? []);

        nitro.hooks.hook("compiled", () => {
          copyAppAndPluginContent(
            cwd,
            nitro.options.output.serverDir,
            options.pluginPackages,
          );
          copyIncludedFiles(
            nitro.options.output.serverDir,
            options.includeFiles,
          );
        });
      },
    },
  };
}
