import { PluginToolInputError } from "@sentry/junior-plugin-api";

/** Throw a model-repairable error for a missing named GoCD resource. */
export function throwGocdReadError(
  message: string,
  status: number,
  options: { missingResourceIsInput: boolean },
): never {
  if (status === 404 && options.missingResourceIsInput) {
    throw new PluginToolInputError(message);
  }
  throw new Error(message);
}
