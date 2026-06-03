import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { RegisteredAgentEventDefinition } from "@/chat/plugins/agent-hooks";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const EVENT_BINDING_ID_RE = /^[a-z][a-z0-9-]*$/;

const stringArraySchema = z.array(z.string().min(1));
const recordSchema = z.record(z.string(), z.unknown());

const eventBindingFrontmatterSchema = z
  .object({
    id: z
      .string({
        error: 'Event binding frontmatter field "id" must be a string',
      })
      .regex(EVENT_BINDING_ID_RE, {
        message:
          'Event binding frontmatter field "id" must be a lowercase identifier',
      }),
    event: z.string({
      error: 'Event binding frontmatter field "event" must be a string',
    }),
    enabled: z
      .boolean({
        error:
          'Event binding frontmatter field "enabled" must be a boolean when present',
      })
      .optional(),
    scope: recordSchema.optional(),
    when: recordSchema.optional(),
    context: z
      .object({
        include: stringArraySchema.optional(),
      })
      .strict()
      .optional(),
    delivery: z
      .object({
        target: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface EventBindingFile {
  path: string;
  raw: string;
}

export interface ParsedEventBinding {
  body: string;
  contextInclude: string[];
  delivery?: Record<string, unknown> & { target: string };
  enabled: boolean;
  event: string;
  id: string;
  path: string;
  scope?: Record<string, unknown>;
  when?: Record<string, unknown>;
}

type ParseResult =
  | { binding: ParsedEventBinding; ok: true }
  | { error: string; ok: false };

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === "ENOENT";
}

function stripFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_RE, "").trim();
}

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid event binding frontmatter";
}

/** Parse one install-owned event binding Markdown file. */
export function parseEventBindingFile(file: EventBindingFile): ParseResult {
  const match = FRONTMATTER_RE.exec(file.raw);
  if (!match) {
    return { ok: false, error: `${file.path}: missing YAML frontmatter` };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (error) {
    return {
      ok: false,
      error: `${file.path}: invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `${file.path}: frontmatter must be a YAML object`,
    };
  }

  const result = eventBindingFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `${file.path}: ${firstIssueMessage(result.error)}`,
    };
  }

  const body = stripFrontmatter(file.raw);
  if (!body) {
    return {
      ok: false,
      error: `${file.path}: event binding prompt body must be non-empty`,
    };
  }

  return {
    ok: true,
    binding: {
      path: file.path,
      id: result.data.id,
      event: result.data.event,
      enabled: result.data.enabled ?? true,
      body,
      contextInclude: result.data.context?.include ?? [],
      ...(result.data.scope ? { scope: result.data.scope } : {}),
      ...(result.data.when ? { when: result.data.when } : {}),
      ...(result.data.delivery ? { delivery: result.data.delivery } : {}),
    },
  };
}

function validateBindingAgainstDefinition(args: {
  binding: ParsedEventBinding;
  definition: RegisteredAgentEventDefinition;
}): string | undefined {
  const contextBlocks = args.definition.definition.contextBlocks ?? {};
  const seenContextNames = new Set<string>();
  for (const contextName of args.binding.contextInclude) {
    if (seenContextNames.has(contextName)) {
      return `${args.binding.path}: event binding "${args.binding.id}" includes duplicate context block "${contextName}"`;
    }
    seenContextNames.add(contextName);
    if (!contextBlocks[contextName]) {
      return `${args.binding.path}: event binding "${args.binding.id}" references unsupported context block "${contextName}" for event "${args.binding.event}"`;
    }
  }

  if (args.binding.delivery) {
    const deliveryTargets = new Set(
      args.definition.definition.deliveryTargets.map((target) => target.target),
    );
    if (!deliveryTargets.has(args.binding.delivery.target)) {
      return `${args.binding.path}: event binding "${args.binding.id}" references unsupported delivery target "${args.binding.delivery.target}" for event "${args.binding.event}"`;
    }
  }

  if (args.binding.scope) {
    const allowedScopeKeys = args.definition.definition.scopeKeys ?? [];
    if (allowedScopeKeys.length === 0) {
      return `${args.binding.path}: event binding "${args.binding.id}" uses scope fields but event "${args.binding.event}" does not support scope selectors`;
    }
    const allowed = new Set(allowedScopeKeys);
    const invalid = Object.keys(args.binding.scope).find(
      (key) => !allowed.has(key),
    );
    if (invalid) {
      return `${args.binding.path}: event binding "${args.binding.id}" uses unsupported scope field "${invalid}" for event "${args.binding.event}"`;
    }
  }

  if (args.binding.when) {
    const allowedFilterKeys = args.definition.definition.filterKeys ?? [];
    if (allowedFilterKeys.length === 0) {
      return `${args.binding.path}: event binding "${args.binding.id}" uses when fields but event "${args.binding.event}" does not support filters`;
    }
    const allowed = new Set(allowedFilterKeys);
    const invalid = Object.keys(args.binding.when).find(
      (key) => !allowed.has(key),
    );
    if (invalid) {
      return `${args.binding.path}: event binding "${args.binding.id}" uses unsupported when field "${invalid}" for event "${args.binding.event}"`;
    }
  }

  return undefined;
}

export interface EventBindingValidationResult {
  bindings: ParsedEventBinding[];
  errors: string[];
}

/** Validate parsed event bindings against trusted plugin event definitions. */
export function validateEventBindings(
  bindings: ParsedEventBinding[],
  definitions: RegisteredAgentEventDefinition[],
): EventBindingValidationResult {
  const errors: string[] = [];
  const seenBindings = new Map<string, string>();
  const events = new Map(
    definitions.map((definition) => [definition.event, definition]),
  );

  for (const binding of bindings) {
    const existingPath = seenBindings.get(binding.id);
    if (existingPath) {
      errors.push(
        `${binding.path}: duplicate event binding id "${binding.id}" already declared in ${existingPath}`,
      );
      continue;
    }
    seenBindings.set(binding.id, binding.path);

    const definition = events.get(binding.event);
    if (!definition) {
      errors.push(
        `${binding.path}: event binding "${binding.id}" references unknown event "${binding.event}"`,
      );
      continue;
    }

    const error = validateBindingAgainstDefinition({ binding, definition });
    if (error) {
      errors.push(error);
    }
  }

  return { bindings, errors };
}

async function collectMarkdownFiles(dir: string): Promise<EventBindingFile[]> {
  let entries: Array<{
    isDirectory(): boolean;
    isFile(): boolean;
    name: string;
  }>;
  try {
    entries = await fs.readdir(dir, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const files: EventBindingFile[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(entryPath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    files.push({
      path: entryPath,
      raw: await fs.readFile(entryPath, "utf8"),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Discover install-owned event binding Markdown files below app/events. */
export async function discoverEventBindingFiles(
  installRoot: string,
): Promise<EventBindingFile[]> {
  return await collectMarkdownFiles(path.join(installRoot, "app", "events"));
}

/** Parse and validate install event binding files in one deterministic pass. */
export function parseAndValidateEventBindingFiles(
  files: EventBindingFile[],
  definitions: RegisteredAgentEventDefinition[],
): EventBindingValidationResult {
  const bindings: ParsedEventBinding[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const parsed = parseEventBindingFile(file);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    bindings.push(parsed.binding);
  }

  const validated = validateEventBindings(bindings, definitions);
  return {
    bindings: validated.bindings,
    errors: [...errors, ...validated.errors],
  };
}
