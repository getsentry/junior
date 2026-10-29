/**
 * Event identifiers name one resource with one string, such as
 * `getsentry/junior#123`. Watches and event automations store that string, and
 * routing matches it exactly.
 *
 * A resource type declares the string as named, typed parts and a template,
 * such as `{owner}/{repo}#{number}`. Square brackets mark optional text, such
 * as `release-source:{owner}/{repo}[:{tag}]`. Tools, the dashboard, and core
 * use this one module to read and write identifiers, so each can name the part
 * that is wrong.
 *
 * A part value is the exact text between separators. A separator is the first
 * character of the text that follows a part, such as `/` and `#` above, or one
 * of `/`, `:`, and `#`, which every template keeps for separators. Part values
 * cannot contain a separator or a space, so each identifier string has one
 * reading and `build(parse(identifier))` returns the same string. A value that
 * needs these characters, such as a release tag, is percent-encoded.
 */
import { z } from "zod";

const PART_NAME = /^[a-z][a-zA-Z0-9]*$/;
const MAX_VARIANTS = 16;
/** Kept out of every part value, so `{owner}/{repo}` rejects `junior#12`. */
const RESERVED_SEPARATORS = ["/", ":", "#"];

const eventIdentifierPartSchema = z
  .object({
    /**
     * `string` is text without spaces or separators. `number` is a positive
     * whole number, such as an issue number. `hex` is lowercase hexadecimal,
     * such as a full commit SHA.
     */
    kind: z.enum(["string", "number", "hex"]),
    /** Shown to people and the agent, such as "GitHub repository owner". */
    description: z.string().trim().min(1).max(200),
    /** The only values this part can have. */
    enum: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine((part) => !part.enum || part.kind === "string", {
    message: 'Identifier part enum needs kind "string".',
    path: ["enum"],
  });

type EventIdentifierPart = z.output<typeof eventIdentifierPartSchema>;

/** Part values by part name. Number parts are digits, such as "123". */
export type EventIdentifierParts = Record<string, string>;

/** One reason an identifier or a part value does not fit its format. */
export interface EventIdentifierProblem {
  /** The part with the problem. Missing when the whole string is wrong. */
  part?: string;
  /** Plain words for the person or agent who wrote the identifier. */
  message: string;
}

type Token = { literal: string } | { part: string } | { optional: Token[] };
type Step = { literal: string } | { part: string };

function readTokens(template: string): Token[] {
  const stack: Token[][] = [[]];
  let index = 0;
  while (index < template.length) {
    const tokens = stack[stack.length - 1]!;
    const char = template[index]!;
    if (char === "{") {
      const end = template.indexOf("}", index);
      const name = end === -1 ? "" : template.slice(index + 1, end);
      if (!PART_NAME.test(name)) {
        throw new Error(
          `Template part at position ${index} needs a name such as {owner}.`,
        );
      }
      tokens.push({ part: name });
      index = end + 1;
    } else if (char === "[") {
      const group: Token[] = [];
      tokens.push({ optional: group });
      stack.push(group);
      index += 1;
    } else if (char === "]") {
      const group = stack.pop()!;
      if (stack.length === 0) {
        throw new Error(`Template has "]" without "[" at position ${index}.`);
      }
      if (!group.some((token) => !("literal" in token))) {
        throw new Error("Each optional group in a template needs a part.");
      }
      index += 1;
    } else if (char === "}") {
      throw new Error(`Template has "}" without "{" at position ${index}.`);
    } else {
      const last = tokens[tokens.length - 1];
      if (last && "literal" in last) last.literal += char;
      else tokens.push({ literal: char });
      index += 1;
    }
  }
  if (stack.length !== 1) throw new Error('Template has "[" without "]".');
  return stack[0]!;
}

/** Every way to read a template, with each optional group in or out. */
function expand(tokens: readonly Token[]): Step[][] {
  let variants: Step[][] = [[]];
  for (const token of tokens) {
    if ("optional" in token) {
      const inner = expand(token.optional);
      variants = variants.flatMap((variant) => [
        ...inner.map((steps) => [...variant, ...steps]),
        variant,
      ]);
    } else {
      variants = variants.map((variant) => [...variant, token]);
    }
    if (variants.length > MAX_VARIANTS) {
      throw new Error(
        `A template can have at most ${MAX_VARIANTS} optional readings.`,
      );
    }
  }
  // Join literals that meet when an optional group is out.
  return variants.map((variant) =>
    variant.reduce<Step[]>((steps, step) => {
      const last = steps[steps.length - 1];
      if (last && "literal" in last && "literal" in step) {
        return [
          ...steps.slice(0, -1),
          { literal: last.literal + step.literal },
        ];
      }
      return [...steps, step];
    }, []),
  );
}

interface Template {
  separators: Set<string>;
  /** Most complete reading first. */
  variants: Step[][];
}

function readTemplate(template: string): Template {
  const variants = expand(readTokens(template));
  const separators = new Set(RESERVED_SEPARATORS);
  for (const variant of variants) {
    variant.forEach((step, index) => {
      const next = variant[index + 1];
      if (!("part" in step) || !next) return;
      if ("part" in next) {
        throw new Error(
          `Template parts {${step.part}} and {${next.part}} need text between them.`,
        );
      }
      const separator = next.literal[0]!;
      if (/[\p{L}\p{N}\s]/u.test(separator)) {
        throw new Error(
          `Template part {${step.part}} must be followed by punctuation, such as "/" or ":".`,
        );
      }
      separators.add(separator);
    });
  }
  return { separators, variants };
}

function variantParts(variant: readonly Step[]): string[] {
  return variant.flatMap((step) => ("part" in step ? [step.part] : []));
}

/** The identifier format of one resource type. Plain JSON, so API responses can carry it. */
export const eventIdentifierSchema = z
  .object({
    /** Part names in braces and text between them, such as "{owner}/{repo}#{number}". */
    template: z.string().trim().min(1).max(200),
    parts: z
      .record(
        z.string().regex(PART_NAME, {
          message: "Identifier part names are camelCase, such as alertRuleId.",
        }),
        eventIdentifierPartSchema,
      )
      .refine((parts) => Object.keys(parts).length > 0, {
        message: "An identifier needs at least one part.",
      }),
  })
  .strict()
  .superRefine((format, context) => {
    let template: Template;
    try {
      template = readTemplate(format.template);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: (error as Error).message,
        path: ["template"],
      });
      return;
    }
    const used = template.variants[0] ? variantParts(template.variants[0]) : [];
    const seen = new Set<string>();
    for (const name of used) {
      if (seen.has(name)) {
        context.addIssue({
          code: "custom",
          message: `Template uses part {${name}} more than once.`,
          path: ["template"],
        });
      }
      seen.add(name);
      if (!format.parts[name]) {
        context.addIssue({
          code: "custom",
          message: `Template part {${name}} is not in parts.`,
          path: ["template"],
        });
      }
    }
    for (const name of Object.keys(format.parts)) {
      if (!seen.has(name)) {
        context.addIssue({
          code: "custom",
          message: `Part "${name}" is not in the template.`,
          path: ["parts", name],
        });
      }
    }
  });

export type EventIdentifierFormat = z.output<typeof eventIdentifierSchema>;

function quoted(values: Iterable<string>): string {
  return [...values].map((value) => `"${value}"`).join(", ");
}

function valueProblem(
  name: string,
  part: EventIdentifierPart,
  value: string,
  separators: ReadonlySet<string>,
): EventIdentifierProblem | undefined {
  const problem = (message: string) => ({ part: name, message });
  if (value === "") return problem(`Give a value for "${name}".`);
  if (/\s/.test(value)) return problem(`"${name}" cannot contain spaces.`);
  const separator = [...separators].find((char) => value.includes(char));
  if (separator) {
    return problem(`"${name}" cannot contain "${separator}".`);
  }
  if (part.kind === "number" && !/^[1-9][0-9]*$/.test(value)) {
    return problem(`"${name}" must be a positive whole number, such as 123.`);
  }
  if (part.kind === "hex" && !/^[0-9a-f]+$/.test(value)) {
    return problem(
      `"${name}" must be lowercase hexadecimal, such as a full commit SHA.`,
    );
  }
  if (part.enum && !part.enum.includes(value)) {
    return problem(
      `"${name}" cannot be "${value}". Use one of: ${quoted(part.enum)}.`,
    );
  }
  return undefined;
}

function valueProblems(
  format: EventIdentifierFormat,
  parts: EventIdentifierParts,
  separators: ReadonlySet<string>,
): EventIdentifierProblem[] {
  return Object.entries(parts).flatMap(([name, value]) => {
    const part = format.parts[name];
    const problem = part && valueProblem(name, part, value, separators);
    return problem ? [problem] : [];
  });
}

type Reading =
  | { parts: EventIdentifierParts }
  | { failedAt: number; message: string };

function read(
  variant: readonly Step[],
  identifier: string,
  separators: ReadonlySet<string>,
): Reading {
  const parts: EventIdentifierParts = {};
  let position = 0;
  let previous: string | undefined;
  for (const step of variant) {
    if ("literal" in step) {
      if (!identifier.startsWith(step.literal, position)) {
        return {
          failedAt: position,
          message: previous
            ? `Expected "${step.literal}" after "${previous}".`
            : `It must start with "${step.literal}".`,
        };
      }
      position += step.literal.length;
      continue;
    }
    let end = position;
    while (end < identifier.length && !separators.has(identifier[end]!)) {
      end += 1;
    }
    parts[step.part] = identifier.slice(position, end);
    position = end;
    previous = step.part;
  }
  if (position < identifier.length) {
    return {
      failedAt: position,
      message: `Unexpected text "${identifier.slice(position)}"${previous ? ` after "${previous}"` : ""}.`,
    };
  }
  return { parts };
}

/**
 * Split an identifier into its part values.
 *
 * Fails with problems that name the wrong part, or describe the wrong text
 * when the string does not fit the template.
 */
export function parseEventIdentifier(
  format: EventIdentifierFormat,
  identifier: string,
):
  | { ok: true; parts: EventIdentifierParts }
  | { ok: false; problems: EventIdentifierProblem[] } {
  const template = readTemplate(format.template);
  let partProblems: EventIdentifierProblem[] | undefined;
  let furthest: { failedAt: number; message: string } | undefined;
  for (const variant of template.variants) {
    const reading = read(variant, identifier, template.separators);
    if ("parts" in reading) {
      const problems = valueProblems(
        format,
        reading.parts,
        template.separators,
      );
      if (problems.length === 0) return { ok: true, parts: reading.parts };
      partProblems ??= problems;
    } else if (!furthest || reading.failedAt > furthest.failedAt) {
      furthest = reading;
    }
  }
  return {
    ok: false,
    problems: partProblems ?? [{ message: furthest!.message }],
  };
}

/**
 * Join part values into an identifier.
 *
 * Leave an optional part empty or out to omit it. Fails with one problem for
 * each wrong, missing, or unknown part.
 */
export function buildEventIdentifier(
  format: EventIdentifierFormat,
  parts: EventIdentifierParts,
):
  | { ok: true; identifier: string }
  | { ok: false; problems: EventIdentifierProblem[] } {
  const template = readTemplate(format.template);
  const given = Object.fromEntries(
    Object.entries(parts).filter(([, value]) => value !== ""),
  );
  const unknown = Object.keys(given).filter((name) => !format.parts[name]);
  if (unknown.length > 0) {
    return {
      ok: false,
      problems: unknown.map((name) => ({
        part: name,
        message: `"${name}" is not a part of this identifier. Use: ${quoted(Object.keys(format.parts))}.`,
      })),
    };
  }
  const problems = valueProblems(format, given, template.separators);
  // The last reading leaves every optional group out, so it has the required
  // parts. Readings go from most to fewest parts, so the last reading with
  // every given part needs the fewest more parts.
  const required = variantParts(template.variants.at(-1)!);
  const optionalGiven = Object.keys(given).filter(
    (name) => !required.includes(name),
  );
  const variant = template.variants
    .filter((candidate) =>
      Object.keys(given).every((name) =>
        variantParts(candidate).includes(name),
      ),
    )
    .at(-1)!;
  for (const name of variantParts(variant)) {
    if (given[name] !== undefined) continue;
    problems.push({
      part: name,
      message: required.includes(name)
        ? `Give a value for "${name}".`
        : `Give a value for "${name}" too, or leave ${quoted(optionalGiven)} empty.`,
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    identifier: variant
      .map((step) => ("literal" in step ? step.literal : given[step.part]))
      .join(""),
  };
}
