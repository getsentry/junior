function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort((a, b) => a[0].localeCompare(b[0]));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(",")}}`;
  }

  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

export function createOperationKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${stableSerialize(input)}`;
}
