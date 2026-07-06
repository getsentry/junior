---
editUrl: false
next: false
prev: false
title: "definePluginTool"
---

> **definePluginTool**\<`TInputSchema`\>(`definition`): `PluginToolDefinition`\<`output`\<`TInputSchema`\>\>

Defined in: [junior-plugin-api/src/tools.ts:157](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tools.ts#L157)

Define a plugin tool with JSON-Schema-representable Zod input parsing.

## Type Parameters

### TInputSchema

`TInputSchema` _extends_ `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>

## Parameters

### definition

`ZodPluginToolDefinition`\<`TInputSchema`\>

## Returns

`PluginToolDefinition`\<`output`\<`TInputSchema`\>\>
