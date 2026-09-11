import { z, type ZodType } from "zod";

// OpenAI strict structured outputs accept only these string formats.
const STRICT_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);
const STRICT_UNSUPPORTED_KEYWORDS = [
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
];

function jsonSchemaProblems(node: unknown, path: string): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) =>
      jsonSchemaProblems(item, `${path}[${index}]`),
    );
  }
  if (node === null || typeof node !== "object") return [];
  const schema = node as Record<string, unknown>;
  const problems = STRICT_UNSUPPORTED_KEYWORDS.filter(
    (keyword) => keyword in schema,
  ).map((keyword) => `${path} uses unsupported keyword ${keyword}`);
  if (schema.type === "object") {
    const properties = Object.keys(
      (schema.properties as Record<string, unknown> | undefined) ?? {},
    );
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const property of properties) {
      if (!required.includes(property)) {
        problems.push(`${path}.${property} is optional`);
      }
    }
  }
  if (
    schema.type === "string" &&
    typeof schema.format === "string" &&
    !STRICT_STRING_FORMATS.has(schema.format)
  ) {
    problems.push(`${path} uses unsupported format ${schema.format}`);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "enum" || key === "required") continue;
    problems.push(...jsonSchemaProblems(value, `${path}.${key}`));
  }
  return problems;
}

/**
 * List every part of a structured-output schema that a strict provider
 * rejects. Converts the Zod schema the way the AI SDK does, so the result
 * matches what the gateway sends. Empty means the schema is provider-safe.
 */
export function strictProviderSchemaProblems(schema: ZodType): string[] {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
  return [
    ...(jsonSchema.type === "object" ? [] : ["$ root is not an object"]),
    ...jsonSchemaProblems(jsonSchema, "$"),
  ];
}
