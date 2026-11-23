/**
 * Import a module by a name held in a variable.
 *
 * Bundlers follow a literal `import("pkg")` and put an optional package into
 * the production server, even when production never uses it. Node resolves
 * this import when the app runs instead.
 */
export function importAtRuntime(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}
