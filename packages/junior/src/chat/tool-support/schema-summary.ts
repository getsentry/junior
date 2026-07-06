function getSchemaProperties(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return schema.properties && typeof schema.properties === "object"
    ? (schema.properties as Record<string, unknown>)
    : {};
}

function getRequiredFields(schema: Record<string, unknown>): Set<string> {
  return Array.isArray(schema.required)
    ? new Set(
        schema.required.filter(
          (value): value is string => typeof value === "string",
        ),
      )
    : new Set<string>();
}

/** Summarize a tool input schema for quick catalog scanning. */
export function summarizeInputSchema(schema: Record<string, unknown>): string {
  const properties = getSchemaProperties(schema);
  const required = getRequiredFields(schema);
  const propertyNames = Object.keys(properties);
  if (propertyNames.length === 0) {
    return "No arguments.";
  }

  return propertyNames
    .map((name) => `${name}${required.has(name) ? " (required)" : ""}`)
    .join(", ");
}
