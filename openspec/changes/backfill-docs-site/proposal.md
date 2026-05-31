# Backfill Docs Site Specs

## Why

Junior's public docs live in `packages/docs` and are the supported user-facing source for setup, extension, operations, CLI usage, and API reference guidance. The docs app has a clear structure, Starlight configuration, generated API reference, content schema extensions, navigation rules, and documentation guidelines, but those contracts are not represented as an OpenSpec capability.

The baseline needs to define what the docs site must guarantee without turning every page into a spec.

## What Changes

- Add a `docs-site` spec for:
  - docs app ownership and build commands;
  - content section and page metadata contracts;
  - sidebar and redirect ownership;
  - generated API reference behavior;
  - public docs accuracy and package/plugin list alignment;
  - style/theme customization boundaries;
  - validation expectations and unresolved gaps.

## Out of Scope

- Rewriting docs pages.
- Defining every page's content.
- Defining release package ownership beyond docs references to package lists.
- Replacing Astro/Starlight conventions with custom docs infrastructure.

## Impact

Docs changes will have an explicit baseline for frontmatter, navigation, generated reference pages, public setup accuracy, and validation. Future docs IA changes can be reviewed against a spec rather than relying only on scattered conventions.
