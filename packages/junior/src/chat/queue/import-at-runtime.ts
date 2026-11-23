/**
 * Import a module by a name held in a variable.
 *
 * Bundlers follow a literal `import("bullmq")` and put a dev-only queue
 * package into the production server, even though production never selects
 * its provider. Node resolves this import when the app runs instead.
 */
export function importAtRuntime(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}
