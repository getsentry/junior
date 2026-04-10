# Plugin Cards Spec

## Metadata

- Created: 2026-04-09
- Last Edited: 2026-04-09

## Changelog

- 2026-04-09: Initial draft. Read-only cards via declarative plugin manifests and a single global `render_card` tool.

## Status

Draft

## Purpose

Define how plugins declare rich card surfaces that the agent can render in Slack. Cards are Block Kit messages with structured fields (title, status, metadata) that provide a richer display than plain text for entities like issues, pull requests, and alerts.

## Scope

- Declarative card schema declarations in `plugin.yaml`
- A single global `render_card` tool the agent calls to post cards
- Template-based rendering from card data to Chat SDK `CardElement`
- Update-in-place when the same entity is rendered twice in a thread
- Read-only cards (display only, no interactive buttons)

## Non-Goals

- Interactive card actions (buttons that trigger MCP tools). Future extension.
- Sidebar panels (Slack right-hand flyout via `link_button`). Future extension.
- Card templates outside `plugin.yaml` (companion files, code-based renderers).
- Unfurl-triggered cards (link previews). Separate surface.
- Cards in non-Slack adapters. Chat SDK abstracts this, but only Slack is specified here.

## Related Specs

- [Plugin Architecture Spec](./plugin-spec.md)
- [Skill Capabilities Spec](./skill-capabilities-spec.md)
- [Chat Architecture Spec](./chat-architecture-spec.md)
- Plugin Types: `packages/junior/src/chat/plugins/types.ts`
- Plugin Manifest Parser: `packages/junior/src/chat/plugins/manifest.ts`
- Plugin Registry: `packages/junior/src/chat/plugins/registry.ts`

## Manifest format

Plugins declare cards as an optional `cards` section in `plugin.yaml`. Each entry defines a card type the agent can render.

```yaml
name: github
description: GitHub integration

cards:
  - name: issue
    description: Display a GitHub issue with status and assignee
    entity-key: "issue:{{number}}"

    schema:
      number:
        type: integer
        required: true
        description: Issue number
      title:
        type: string
        required: true
        description: Issue title
      url:
        type: string
        required: true
        description: Full URL to the issue
      state:
        type: string
        required: true
        enum: [open, closed]
        description: Current issue state
      assignee:
        type: string
        description: Login of the assignee
      labels:
        type: string
        description: Comma-separated label names

    render:
      title: "{{number}}"
      title-url: "{{url}}"
      body: "{{title}}"
      link-label: "View on GitHub"
      status:
        text: "{{state}}"
        style-map:
          open: success
          closed: default
      fields:
        - label: Assignee
          value: "{{assignee}}"
          fallback: Unassigned
        - label: Labels
          value: "{{labels}}"
      fallback-text: "#{{number}}: {{title}} ({{state}})"
```

### Card declaration contract

| Field                       | Type       | Required        | Rules                                                                                                                                    |
| --------------------------- | ---------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                      | `string`   | yes             | Unique within plugin. Must match `^[a-z][a-z0-9-]*$`.                                                                                    |
| `description`               | `string`   | yes             | Non-empty. Included in the `render_card` tool description shown to the agent.                                                            |
| `entity-key`                | `string`   | yes             | Template string resolving to a unique entity identifier for update-in-place tracking. Qualified at runtime to `<plugin>.<resolved-key>`. |
| `schema`                    | `object`   | yes             | Map of field names to type descriptors. At least one field must be `required: true`.                                                     |
| `schema[field].type`        | `string`   | yes             | One of `string`, `integer`, `boolean`.                                                                                                   |
| `schema[field].required`    | `boolean`  | no              | Default `false`.                                                                                                                         |
| `schema[field].description` | `string`   | no              | Included in tool parameter documentation.                                                                                                |
| `schema[field].enum`        | `string[]` | no              | Allowed values. Only valid when `type` is `string`.                                                                                      |
| `render`                    | `object`   | yes             | Display template.                                                                                                                        |
| `render.title`              | `string`   | yes             | Template for the card title.                                                                                                             |
| `render.title-url`          | `string`   | no              | Template for a URL linked from the title.                                                                                                |
| `render.body`               | `string`   | no              | Template for a descriptive body line shown below the title.                                                                              |
| `render.link-label`         | `string`   | no              | Template for the inline link label used with `render.title-url`. Defaults to `Open`.                                                     |
| `render.status`             | `object`   | no              | Status badge.                                                                                                                            |
| `render.status.text`        | `string`   | yes (if status) | Template for status display text.                                                                                                        |
| `render.status.style-map`   | `object`   | no              | Maps resolved status text values to card styles: `success`, `warning`, `danger`, `default`. Unmapped values receive `default`.           |
| `render.fields`             | `array`    | no              | Metadata fields displayed as label-value pairs.                                                                                          |
| `render.fields[].label`     | `string`   | yes             | Static label text.                                                                                                                       |
| `render.fields[].value`     | `string`   | yes             | Template for the field value.                                                                                                            |
| `render.fields[].fallback`  | `string`   | no              | Displayed when the resolved value is null, undefined, or empty string.                                                                   |
| `render.fallback-text`      | `string`   | yes             | Template for plain text representation in non-card contexts (logs, streaming).                                                           |

## Template syntax

Card templates use Mustache-style interpolation against the `data` object passed to `render_card`.

| Syntax      | Meaning                    | Example                             |
| ----------- | -------------------------- | ----------------------------------- |
| `{{field}}` | Direct field lookup        | `{{title}}` → `"Fix login timeout"` |
| `{{a.b}}`   | Dot-notation nested access | `{{assignee.login}}` → `"alice"`    |

No conditionals, loops, pipes, or expressions. If a plugin needs complex display values, the MCP tool that provides the data should pre-compute them. Templates are intentionally dumb.

When a template resolves to `null`, `undefined`, or empty string:

- For `render.fields[].value`: the `fallback` value is used if declared, otherwise the field is omitted from the card.
- For `render.title`: the card render fails (title is required).
- For `render.body` or `render.link-label`: the element is omitted.
- For `render.fallback-text`: unresolved placeholders render as empty strings.

## The `render_card` tool

The runtime generates a single global tool from all card declarations across registered plugins.

### Tool registration

- The tool is registered when at least one registered plugin declares a `cards` section.
- The tool is available in every agent turn regardless of which skill is active.
- The tool is a core runtime capability and is not gated by per-skill `allowed-tools` filters.
- If no plugins declare cards, the tool is not registered.

### Tool shape

```
Tool: render_card
Description: Render structured data as a rich card in the conversation.

Available card types:
  - github.issue: Display a GitHub issue with status and assignee
  - sentry.issue: Display a Sentry issue with event count and quick actions

Parameters:
  type (string, required):
    Card type. One of: "github.issue", "sentry.issue"
  data (object, required):
    Card data. Fields depend on type:
      github.issue: { number (int, req), title (str, req), url (str, req), state (str, req), assignee (str), labels (str) }
      sentry.issue: { shortId (str, req), title (str, req), permalink (str, req), status (str, req), count (str), lastSeen (str), assignee (str) }
```

The tool description is auto-generated from card declarations. The `type` enum and per-type field documentation update automatically as plugins are added or removed.

Agent usage guidance:

- Prefer cards when returning one concrete entity with stable structured fields.
- Prefer plain text for broad result lists unless a dedicated list card type exists.
- After rendering a card, do not restate the same structured fields in prose. Keep any text to brief context or next steps.

### Tool execution

1. Parse `type` as `<pluginName>.<cardName>`.
2. Look up the card declaration in the plugin's manifest.
3. Validate `data` against the card's `schema`. Reject with an error if required fields are missing or types don't match.
4. Resolve the `render` template against `data`.
5. Build a `CardElement` via Chat SDK JSX components.
6. Post the card to the thread via `thread.post(cardElement)`.
7. Register the card in `ThreadArtifactsState` for update-in-place (see below).
8. Return a confirmation string to the agent: `"Card rendered: <fallback-text>"`.

### Validation

The runtime rejects `render_card` calls that fail validation and returns an error to the agent so it can retry. No partial rendering.

Validation checks:

- `type` must match a registered card declaration.
- All `required: true` schema fields must be present in `data`.
- Field types must match (`integer` fields must be numbers, etc.).
- `enum` fields must contain an allowed value.

## Rendering

The runtime converts resolved template output to a Chat SDK `CardElement`.

```typescript
function renderCard(
  pluginName: string,
  cardDef: CardDefinition,
  data: Record<string, unknown>,
): CardElement {
  const r = resolveTemplate(cardDef.render, data);

  return toCardElement(
    <Card title={r.title}>
      {r.body && (
        <Section>
          <Text>{r.body}</Text>
        </Section>
      )}
      {r.status && (
        <Section>
          <Text style={resolveStatusStyle(r.status.text, r.status.styleMap)}>
            {r.status.text}
          </Text>
        </Section>
      )}
      {r.fields && (
        <Fields>
          {r.fields.map(f => (
            <Field label={f.label}>{f.value}</Field>
          ))}
        </Fields>
      )}
      {r.titleUrl && (
        <CardLink url={r.titleUrl} label={r.linkLabel ?? "Open"} />
      )}
    </Card>
  );
}
```

The Chat SDK's Slack adapter converts `CardElement` to Block Kit blocks. The runtime does not produce Block Kit directly.

### Posting behavior

- Cards post as separate messages, distinct from the agent's text response.
- When the agent is streaming a text response, the card posts **after** the stream completes.
- When the agent produces no text (card-only response), the card posts immediately.
- Multiple `render_card` calls in a single turn each produce a separate card message.

## Update-in-place

### Entity key resolution

The `entity-key` template resolves against `data` and is qualified with the plugin name: `<pluginName>.<resolvedKey>`. For example, `entity-key: "issue:{{number}}"` with `data.number = 42` in the `github` plugin resolves to `github.issue:42`.

### Thread-scoped tracking

Card messages are tracked per-thread in `ThreadArtifactsState`:

```typescript
export interface ThreadArtifactsState {
  // ... existing fields
  cardMessages?: Array<{
    entityKey: string;
    messageId: string;
    pluginName: string;
    postedAt: string;
  }>;
}
```

### Update logic

When `render_card` is called:

1. Resolve the entity key from the card declaration and `data`.
2. Search `cardMessages` for an existing entry with the same `entityKey` in this thread.
3. If found: call `thread.editMessage(existingMessageId, cardElement)` to update in-place.
4. If not found: call `thread.post(cardElement)` and append a new entry to `cardMessages`.

Same entity in different threads produces separate cards. Entity keys are scoped per-thread.

## Failure model

| Failure                                         | Handling                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `render_card` called with unknown `type`        | Return error to agent: `"Unknown card type: {type}. Available types: ..."`         |
| Required field missing in `data`                | Return error to agent: `"Missing required field '{field}' for card type '{type}'"` |
| Field type mismatch                             | Return error to agent: `"Field '{field}' expected {expected}, got {actual}"`       |
| Template resolution produces empty title        | Return error to agent: `"Card title resolved to empty string"`                     |
| `thread.post()` fails                           | Log error, return error to agent: `"Failed to post card"`                          |
| `thread.editMessage()` fails on update-in-place | Fall back to posting a new card. Log warning.                                      |
| Plugin declares card with duplicate name        | Manifest validation fails at startup.                                              |

## Observability

- `card_rendered` log event on successful card post. Attributes: `app.card.type`, `app.card.entity_key`, `app.card.plugin`, `app.card.updated` (boolean).
- `card_render_failed` log event on validation or posting failure. Attributes: `app.card.type`, `app.card.error`.

## Verification

- Manifest parsing tests: validate card declarations are correctly parsed from `plugin.yaml`, including schema fields, render templates, and entity keys.
- Template resolution tests: verify `{{field}}` and `{{a.b}}` interpolation, fallback behavior, and empty value handling.
- Tool generation tests: verify `render_card` tool description is auto-generated from registered card declarations and updates when plugins change.
- Validation tests: verify rejection of missing required fields, type mismatches, unknown card types, and enum violations.
- Update-in-place tests: verify entity key resolution, thread-scoped tracking, edit-on-duplicate behavior, and fallback-to-new-post on edit failure.
- Integration test: end-to-end flow from `render_card` tool call through template resolution, `CardElement` construction, and `thread.post()` invocation.
