import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  prepareCatalogToolCall,
  resolveCatalogToolCall,
} from "@/chat/tool-support/catalog-tool-call";
import { tool } from "@/chat/tools/definition";

describe("catalog tool calls", () => {
  it("resolves and prepares a catalog tool call", () => {
    const definition = tool({
      description: "Lookup customer health.",
      inputSchema: Type.Object(
        {
          customerId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      prepareArguments: (args) => {
        const input = args as Record<string, unknown>;
        return typeof input.customer_id === "string"
          ? { customerId: input.customer_id }
          : (input as { customerId: string });
      },
    });

    const call = prepareCatalogToolCall(
      resolveCatalogToolCall(
        {
          tool_name: "agentDemo_lookupCustomer",
          arguments: { customer_id: "C123" },
        },
        { agentDemo_lookupCustomer: definition },
      ),
    );

    expect(call).toEqual({
      definition,
      toolName: "agentDemo_lookupCustomer",
      arguments: { customerId: "C123" },
    });
  });

  it("rejects non-catalog names and malformed dispatcher arguments", () => {
    const definition = tool({
      description: "Catalog demo",
      inputSchema: Type.Object({}),
    });

    expect(() =>
      resolveCatalogToolCall(
        {
          tool_name: "hiddenDemo",
          arguments: {},
        },
        { catalogDemo: definition },
      ),
    ).toThrow("executeTool can only call catalog tools");
    expect(() =>
      resolveCatalogToolCall(
        {
          tool_name: "catalogDemo",
          query: "top-level",
          arguments: {},
        },
        { catalogDemo: definition },
      ),
    ).toThrow("executeTool arguments must be nested under arguments");
    expect(() =>
      resolveCatalogToolCall(
        {
          tool_name: "catalogDemo",
          arguments: "bad",
        },
        { catalogDemo: definition },
      ),
    ).toThrow("executeTool arguments must be an object");
  });

  it("validates prepared arguments against the catalog tool schema", () => {
    const definition = tool({
      description: "Lookup customer health.",
      inputSchema: Type.Object(
        {
          customerId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    });

    expect(() =>
      prepareCatalogToolCall(
        resolveCatalogToolCall(
          {
            tool_name: "agentDemo_lookupCustomer",
            arguments: {},
          },
          { agentDemo_lookupCustomer: definition },
        ),
      ),
    ).toThrow("arguments do not match schema");
  });
});
