---
name: eval-mcp
description: Use for `/eval-mcp` requests that need the eval MCP handbook lookup.
---

# Eval MCP Lookup

1. Always inspect the disclosed MCP tools and call the exact disclosed handbook search tool before answering.

2. Use the exact returned `mcp__eval-mcp__handbook-search` tool and pass the user's lookup request as `query` inside the tool `arguments` object. Never call the tool with only `tool_name`; use `tool_name: "mcp__eval-mcp__handbook-search", arguments: { "query": "<current lookup request>" }`.

3. Answer from the MCP result. Keep the final answer short.
