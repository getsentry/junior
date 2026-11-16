type JsonSchema = Record<string, unknown>;

function asSchema(value: unknown): JsonSchema {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchema)
    : {};
}

function propertyList(schema: JsonSchema): string {
  const properties = asSchema(schema["properties"]);
  const required = new Set(
    Array.isArray(schema["required"]) ? schema["required"] : [],
  );
  return Object.entries(properties)
    .map(
      ([name, property]) =>
        `${name}${required.has(name) ? "" : "?"}: ${schemaType(asSchema(property))}`,
    )
    .join(", ");
}

// Render one JSON Schema node as a short TypeScript-like type. Keywords that
// this does not know, such as `$ref` or `allOf`, render as `unknown`.
function schemaType(schema: JsonSchema): string {
  if ("const" in schema) {
    return JSON.stringify(schema["const"]);
  }
  if (Array.isArray(schema["enum"])) {
    return schema["enum"].map((value) => JSON.stringify(value)).join(" | ");
  }
  const variants = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(variants)) {
    return variants.map((variant) => schemaType(asSchema(variant))).join(" | ");
  }
  const types = Array.isArray(schema["type"])
    ? schema["type"]
    : [schema["type"] ?? (schema["properties"] ? "object" : undefined)];
  return types
    .map((type) => {
      if (type === "array") {
        const item = schemaType(asSchema(schema["items"]));
        return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
      }
      if (type === "object") {
        const properties = propertyList(schema);
        return properties ? `{ ${properties} }` : "object";
      }
      return typeof type === "string" ? type : "unknown";
    })
    .join(" | ");
}

/**
 * Summarize a tool input schema as `name: type` pairs, with `?` on optional
 * params, so a search result can show how to call a tool without its full
 * schema.
 */
export function summarizeInputSchema(schema: Record<string, unknown>): string {
  return propertyList(schema) || "No arguments.";
}
