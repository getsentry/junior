import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkToolAnnotationSource,
  checkToolDefinitionSource,
  runBuiltToolNames,
} from "./check-tool-annotations.mjs";

describe("checkToolAnnotationSource", () => {
  it("accepts complete behavioral hints", () => {
    const errors = checkToolAnnotationSource(`
      zodTool({
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        },
      });
    `);

    assert.deepEqual(errors, []);
  });

  it("rejects missing and inconsistent hints", () => {
    const errors = checkToolAnnotationSource(`
      definePluginTool({
        annotations: {
          destructiveHint: true,
          readOnlyHint: true,
        },
      });
    `);

    assert.deepEqual(errors, [
      "tool.ts:2: repo tool annotations missing idempotentHint, openWorldHint",
      "tool.ts:2: read-only tools cannot declare destructiveHint: true",
    ]);
  });

  it("rejects omitted annotations", () => {
    const errors = checkToolAnnotationSource(
      `zodTool({ description: "demo" });`,
    );

    assert.deepEqual(errors, [
      "tool.ts:1: repo tool must declare annotations with destructiveHint, idempotentHint, openWorldHint, readOnlyHint",
    ]);
  });

  it("checks static definitions and accepts tools built from them", () => {
    const errors = checkToolAnnotationSource(`
      const pingToolDefinition = zodToolDefinition({ description: "demo" });
      zodTool({ ...pingToolDefinition, execute() {} });
      definePluginTool(vercelToolDefinitions.ping);
      zodTool({ ...options, execute() {} });
    `);

    assert.deepEqual(errors, [
      "tool.ts:2: repo tool must declare annotations with destructiveHint, idempotentHint, openWorldHint, readOnlyHint",
      "tool.ts:5: repo tool must declare annotations with destructiveHint, idempotentHint, openWorldHint, readOnlyHint",
    ]);
  });
});

describe("checkToolDefinitionSource", () => {
  const runBuilt = new Set(["loadSkill"]);

  it("rejects an inline description in zodTool", () => {
    const errors = checkToolDefinitionSource(
      `export function createPingTool() {
        return zodTool({ description: "demo", execute() {} });
      }`,
      "tool.ts",
      runBuilt,
    );

    assert.deepEqual(errors, [
      "tool.ts:2: description must come from the static tool registry; a run-built tool factory needs @runBuilt <tool>",
    ]);
  });

  it("rejects an inline inputSchema in definePluginTool", () => {
    const errors = checkToolDefinitionSource(
      `definePluginTool({ inputSchema: schema, execute() {} });`,
      "tool.ts",
      runBuilt,
    );

    assert.deepEqual(errors, [
      "tool.ts:1: inputSchema must come from the static tool registry; a run-built tool factory needs @runBuilt <tool>",
    ]);
  });

  it("accepts a definition spread from the registry", () => {
    const errors = checkToolDefinitionSource(
      `zodTool({ ...pingToolDefinition, execute() {} });
      definePluginTool(pluginToolDefinitions.ping);`,
      "tool.ts",
      runBuilt,
    );

    assert.deepEqual(errors, []);
  });

  it("accepts inline fields in a factory tagged with a run-built tool", () => {
    const errors = checkToolDefinitionSource(
      `/**
       * Build loadSkill for this run's skills.
       *
       * @runBuilt loadSkill
       */
      export function createLoadSkillTool(skills) {
        return zodTool({ description: render(skills), inputSchema: schema });
      }`,
      "tool.ts",
      runBuilt,
    );

    assert.deepEqual(errors, []);
  });

  it("rejects a tag that names a static tool", () => {
    const errors = checkToolDefinitionSource(
      `/** @runBuilt bash */
      export function createBashTool() {
        return zodTool({ description: "demo", execute() {} });
      }`,
      "tool.ts",
      runBuilt,
    );

    assert.deepEqual(errors, [
      "tool.ts:3: @runBuilt bash is not a run-built tool",
    ]);
  });
});

describe("runBuiltToolNames", () => {
  it("reads the run-built slots of the registry", () => {
    const names = runBuiltToolNames(`
      const CORE_TOOLS = {
        loadSkill: RUN_BUILT,
        bash: always(bashToolDefinition),
        localSendFiles: { runBuilt: true, name: "sendFiles" },
        sendFiles: RUN_BUILT,
      } satisfies Record<string, Entry>;
    `);

    assert.deepEqual([...names], ["loadSkill", "sendFiles"]);
  });
});
