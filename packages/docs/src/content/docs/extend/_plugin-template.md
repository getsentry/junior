---
title: Plugin Page Template
description: Required structure for plugin setup pages.
type: tutorial
prerequisites:
  - /extend/
related:
  - /extend/
  - /concepts/resource-subscriptions/
  - /reference/config-and-env/
---

Use this template for plugin setup pages. Follow the writing rules in [Documentation Guidelines](/contribute/documentation-guidelines/). Give every plugin guide the same reader path.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-example
```

## Runtime setup

Plugins that ship only a `plugin.yaml` manifest are registered as bare package-name strings:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-example"]);
```

Some plugins need runtime hooks. These hooks can register tools, process sessions, or run Git actions. Such plugins use a JavaScript factory that returns a `defineJuniorPlugin(...)` registration. Register them with an explicit factory call:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { examplePlugin } from "@sentry/junior-example";

export const plugins = defineJuniorPlugins([examplePlugin()]);
```

Name a runtime plugin factory `<domain>Plugin`, export it as a function, and
call it even when it has no options. Do not document a `create<Domain>Plugin`
alias or a prebuilt plugin registration.

Do not register a factory-based plugin as a bare package-name string. A bare string does not run runtime hooks. Check the plugin README or setup page to find the required registration style.

## Config

Use this section for every configurable plugin. Put all conversation config,
plugin factory options, and deployment environment variables here instead of
splitting them across setup sections.

Start with the ways readers can define values:

- Conversation config: `jr-rpc config set <plugin>.<key> <value>`
- Install-wide conversation defaults: `createApp({ configDefaults: { "<plugin>.<key>": "<value>" } })`
- Plugin options: pass values to `<plugin>Plugin({ ... })` in `plugins.ts`
- Environment variables: set them in the deployment environment, then redeploy

Only list definition methods the plugin supports. Organize options under these
subheadings, omitting groups that do not apply:

- **Conversation defaults** for registered `<plugin>.<key>` values
- **Plugin options** passed to a plugin factory in `plugins.ts`
- **Environment variables** read from the deployment environment

Within each group, use one collapsed disclosure per option so the section stays
easy to scan on desktop and mobile:

### Conversation defaults

<details class="plugin-config">
<summary><code>example.project</code></summary>

Default project when a request does not name one.

- **Define:** `jr-rpc config set example.project <project>`
- **Install-wide default:** `configDefaults["example.project"]`
- **Required:** No
- **Environment override:** None

</details>

### Plugin options

<details class="plugin-config">
<summary><code>apiTokenEnv</code></summary>

Names the deployment environment variable that contains the provider API token.

- **Define:** `examplePlugin({ apiTokenEnv: "EXAMPLE_API_TOKEN" })` in `plugins.ts`
- **Default:** `EXAMPLE_API_TOKEN`
- **Required:** Yes
- **Environment variable:** The variable named by this option

</details>

Use exact registered config keys, public plugin option names, and manifest
environment variable names. Describe what each option controls, how to define
it, whether it is required, its default when one exists, and the environment
override or variable when applicable. Say `None` when there is no environment
override. If the plugin has no configuration, keep the heading and say:

`No plugin config is required.`

## Plugin-specific setup

Explain provider-specific setup after install and config. Keep this section concrete and action-oriented.

## Resource subscriptions

If the plugin publishes resource events, list every resource type the agent can
subscribe to. Link to [Resource Subscriptions](/concepts/resource-subscriptions/)
for the core distinction between temporary resource subscriptions and durable
event tasks; do not redefine those behaviors on every plugin page.

Use one subsection per resource type, then one collapsed disclosure per event.
Show the exact event name in the summary and its plain-language description
inside. Do not add a separate subscription-details row.

### `issue`

<details class="resource-event">
<summary><code>issue.closed</code></summary>

The issue was closed.

</details>

<details class="resource-event">
<summary><code>issue.reopened</code></summary>

The issue was reopened.

</details>

Use the exact `resourceTypes[].type` and `supportedEvents` values registered by
the plugin. Do not omit registered events. Keep descriptions to one sentence.
Explain provider setup and identifier formats in normal prose after the resource
subsections only when users need that information.

If the plugin does not publish resource events, use this sentence instead:

`This plugin does not support resource subscriptions.`

## Verify

Describe one real user workflow that confirms the plugin works end to end.

## Failure modes

List concrete error -> cause -> fix entries so readers can recover quickly.

## Next step

Link to the next page the reader should open after setup succeeds.
