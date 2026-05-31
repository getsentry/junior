## ADDED Requirements

### Requirement: Docs App Ownership

Junior SHALL maintain public user-facing docs in the `packages/docs` Astro/Starlight application.

#### Scenario: Docs commands are run from the repository root

- **WHEN** contributors run docs commands from the root package
- **THEN** `pnpm docs:dev` SHALL start the docs development server
- **AND** `pnpm docs:build` SHALL run the docs production build
- **AND** `pnpm docs:check` SHALL run docs validation and a production build through the docs package

#### Scenario: Docs CI validates changes

- **WHEN** repository CI runs docs checks
- **THEN** it SHALL run `pnpm docs:check` or an equivalent command that includes content/schema validation and a production docs build

### Requirement: Docs Content Model

Authored docs pages SHALL follow the repository documentation page contract.

#### Scenario: New or substantially edited authored page

- **WHEN** an authored Markdown or MDX docs page is added or substantially changed
- **THEN** it SHOULD include frontmatter `type`, `summary`, `prerequisites`, and `related`
- **AND** `type` SHALL be one of `conceptual`, `tutorial`, `reference`, or `troubleshooting`
- **AND** `summary` SHALL describe the reader outcome
- **AND** `prerequisites` and `related` SHALL use internal docs paths when populated

#### Scenario: Page is generated API reference

- **WHEN** a page is generated under the configured API reference output
- **THEN** it MAY omit the authored page metadata fields
- **AND** generated content SHALL be treated as derived from public TypeScript entry points

#### Scenario: Page is the docs home page

- **WHEN** the splash home page uses Starlight home-page frontmatter or custom MDX
- **THEN** it MAY follow the Starlight splash page model instead of the normal authored page model
- **AND** it SHALL link readers to the supported start path

### Requirement: Information Architecture

Junior docs SHALL use a curated navigation structure for public reader paths.

#### Scenario: Discoverable page is added

- **WHEN** a page should be discoverable from docs navigation
- **THEN** it SHALL be added to the Starlight sidebar in `astro.config.mjs`
- **AND** its section placement SHALL match its primary user job

#### Scenario: Public route moves

- **WHEN** an existing public docs route is moved, renamed, or replaced
- **THEN** `astro.config.mjs` SHALL include a redirect from the old route to the new supported route
- **AND** related pages SHOULD be updated to point at the new route

#### Scenario: Section ownership is unclear

- **WHEN** a page mixes setup, concept, reference, and troubleshooting material
- **THEN** the page SHALL choose one primary page type
- **AND** secondary material SHOULD be moved or linked to the section that owns that job

### Requirement: Generated API Reference

Junior docs SHALL generate API reference pages from public package entry points.

#### Scenario: Public API reference is built

- **WHEN** docs are built
- **THEN** TypeDoc/Starlight integration SHALL use the configured public API entry points
- **AND** generated output SHALL be written under the configured API reference section
- **AND** private and protected API members SHALL be excluded

#### Scenario: Public API surface changes

- **WHEN** exported public API entry points change
- **THEN** the generated API reference configuration SHALL be reviewed
- **AND** narrative reference pages SHALL link to stable generated routes where possible

### Requirement: Public Docs Accuracy

Junior public docs SHALL describe supported user-facing behavior and stay aligned with product contracts.

#### Scenario: Docs describe CLI behavior

- **WHEN** docs mention `junior init`, `junior check`, or `junior snapshot create`
- **THEN** they SHALL match the CLI command forms and core behavior specified by the `cli` spec

#### Scenario: Docs describe plugin packages

- **WHEN** docs list first-party provider packages or plugin setup steps
- **THEN** they SHALL match the packages, manifests, trusted hook requirements, and runtime dependency model specified by `provider-packages`, `plugin-manifest`, and `plugin-runtime`

#### Scenario: Docs describe auth, credentials, Slack, scheduler, or dispatch behavior

- **WHEN** docs describe runtime behavior owned by another spec
- **THEN** they SHALL follow that spec's user-visible contract
- **AND** they SHALL avoid describing internal implementation details as if users need to operate them directly

#### Scenario: Tutorial or troubleshooting page is authored

- **WHEN** a page has `type: tutorial` or `type: troubleshooting`
- **THEN** it SHALL include concrete verification or recovery steps
- **AND** it SHALL end with a useful next-step path through internal links

### Requirement: Theme And Customization

Docs theme customization SHALL stay scoped to the docs app and preserve Starlight conventions.

#### Scenario: Custom CSS changes

- **WHEN** `packages/docs/src/styles/custom.css` changes
- **THEN** the change SHALL target docs-site presentation only
- **AND** it SHALL preserve readable Starlight content layouts across normal docs pages

#### Scenario: Homepage visual design changes

- **WHEN** the splash homepage, custom MDX, or home-page CSS changes substantially
- **THEN** contributors SHOULD verify the page visually at common desktop and mobile widths
- **AND** docs build validation SHALL still pass

### Requirement: Docs Validation

Docs changes SHALL be validated with commands that match the affected surface.

#### Scenario: Authored content changes

- **WHEN** Markdown or MDX docs content changes
- **THEN** `pnpm docs:check` SHOULD be run unless the change is clearly mechanical and covered by a broader CI run

#### Scenario: Sidebar, redirects, schema, generated API, or theme config changes

- **WHEN** `astro.config.mjs`, `content.config.ts`, generated API reference configuration, theme integration, or custom CSS changes
- **THEN** `pnpm docs:check` SHOULD be run
- **AND** the verification note SHALL mention any unverified visual or generated-content risk

#### Scenario: Docs refer to package/release inventories

- **WHEN** docs change package lists, plugin package names, or release instructions
- **THEN** contributors SHALL check the owning release/package inventory source
- **AND** any missing automated drift check SHALL be recorded as a verification gap
