type ToolInvocationRef = {
  id?: string;
  name?: string;
};

/** Match tool call/result refs without inferring relationships from missing metadata. */
export function sameToolInvocation(
  left: ToolInvocationRef,
  right: ToolInvocationRef,
): boolean {
  if (left.id || right.id) {
    return Boolean(left.id && right.id && left.id === right.id);
  }
  if (left.name && right.name) return left.name === right.name;
  return false;
}
