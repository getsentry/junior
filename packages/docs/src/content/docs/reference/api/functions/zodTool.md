---
editUrl: false
next: false
prev: false
title: "zodTool"
---

> **zodTool**\<`TInputSchema`, `TOutputSchema`\>(`definition`): `PluginToolDefinition`\<`output`\<`TInputSchema`\>, `output`\<`TOutputSchema`\>\>

Defined in: [junior-plugin-api/src/tools.ts:251](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tools.ts#L251)

Define a plugin tool with Zod input parsing and validated structured results.

## Type Parameters

### TInputSchema

`TInputSchema` _extends_ `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>

### TOutputSchema

`TOutputSchema` _extends_ `ZodType`\<\{\[`key`: `string`\]: `unknown`; `continuation?`: \{ `arguments`: `Record`\<`string`, `unknown`\>; `reason?`: `string`; \}; `data?`: `unknown`; `error?`: `string` \| \{ `kind`: `string`; `message`: `string`; `retryable?`: `boolean`; \}; `ok`: `boolean`; `status`: `"error"` \| `"success"`; `target?`: `string`; `truncated?`: `boolean`; \}, `unknown`, `$ZodTypeInternals`\<\{\[`key`: `string`\]: `unknown`; `continuation?`: \{ `arguments`: `Record`\<`string`, `unknown`\>; `reason?`: `string`; \}; `data?`: `unknown`; `error?`: `string` \| \{ `kind`: `string`; `message`: `string`; `retryable?`: `boolean`; \}; `ok`: `boolean`; `status`: `"error"` \| `"success"`; `target?`: `string`; `truncated?`: `boolean`; \}, `unknown`\>\>

## Parameters

### definition

`ZodPluginToolDefinition`\<`TInputSchema`, `TOutputSchema`\>

## Returns

`PluginToolDefinition`\<`output`\<`TInputSchema`\>, `output`\<`TOutputSchema`\>\>
