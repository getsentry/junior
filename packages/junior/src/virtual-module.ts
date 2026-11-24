/**
 * Tell whether `error` says that the virtual module `id` does not exist. Only
 * a `juniorNitro()` build has its virtual modules, so the CLI and tests get
 * this error.
 */
export function isMissingVirtualModule(error: unknown, id: string): boolean {
  if (!(error instanceof Error) || !error.message.includes(id)) {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  return (
    code === "ERR_PACKAGE_IMPORT_NOT_DEFINED" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND"
  );
}
