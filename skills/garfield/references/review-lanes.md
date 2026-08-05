# Native Review Lanes

Use these cards to keep one owner per concern. Corroborate an existing concern
instead of restating it from another lane.

## Behavior/spec

- **Owns:** Demonstrable incorrect behavior, unsafe design, or mismatch with the
  requested behavior, established contract, invariant, compatibility
  expectation, or stated non-goal.
- **Does not own:** Missing proof without a demonstrated defect; maintained
  prose drift; mechanical policy compliance; generated-artifact parity.
- **Quality brake:** State the defect and impact independently from the remedy.
  Prefer the lowest-maintenance boundary, type, or transaction fix. Before
  proposing a persistent mechanism such as a custom validator, trigger, cache,
  compatibility layer, or state field, compare it with a narrower fix and
  explain why the mechanism is necessary. Do not infer an expensive
  implementation mechanically from a spec.

## Repository instructions

- **Owns:** Applicable local rules, ranked in this order: data integrity,
  security, architecture, and operational invariants; then public API and test
  contracts; then naming, comments, exact helpers, and command bookkeeping.
- **Does not own:** Stale maintained prose, missing validation evidence, comment
  quality already owned by its policy lane, or low-consequence stylistic
  compliance presented as an architectural defect.
- **Quality brake:** Enforce the consequence behind a rule, not its wording
  alone. A local rule may be stale or overfit; do not prescribe its named
  pattern when the diff has a simpler design that satisfies the same invariant.

## Validation sufficiency

- **Owns:** Missing or brittle proof, stale validation, and checks that cannot
  detect a realistic regression in the changed behavior.
- **Does not own:** The underlying behavior defect; a test per branch or
  adapter; assertions whose primary subject is an internal call, tool name, mock
  sequence, or styling class unless that surface is the contract.
- **Quality brake:** Admit a test request only when all three have answers:
  (1) what realistic regression can pass now, (2) what highest stable public or
  owned boundary detects it, and (3) why an existing table, fixture, or contract
  case cannot simply be extended. Prefer one representative test per invariant.
  Group stale commands into one readiness check. Record unavailable live,
  browser, credentialed, or external checks as **unverified**, not as code
  defects.

## Specs/docs

- **Owns:** Drift in maintained normative specs and public or operational
  contracts, especially setup, migrations, configuration, privacy, routing,
  ownership, and API behavior.
- **Does not own:** The implementation defect itself, generic repository-policy
  compliance, incidental test comments, or non-authoritative wording presented
  as a product contract.
- **Quality brake:** Group edits by one user or operator contract. When
  implementation and a normative source disagree, report the conflict without
  assuming which side should change; request/task authority or behavior/spec
  must resolve it before this lane rewrites the normative source.
- **Applicability:** Run when behavior or a documented contract changed, or the
  slice should have changed maintained specs or docs.

## Dead code

- **Owns:** Proven unreachable branches, unused private helpers and fields,
  orphaned compatibility paths, duplicate APIs after a hard cut, and stale
  members whose owning runtime workflow was removed.
- **Does not own:** Generated or packed artifacts; naming-only cleanup; an
  exported symbol declared dead solely because repository search finds no
  consumer.
- **Quality brake:** Before removing an export, require private/module-local
  status, an explicit hard cut, authorized breaking change, or evidence that it
  was never supported public API. Deduplicate by family: one concern for the
  obsolete workflow suppresses separate concerns for each member it already
  names.
- **Applicability:** Run when paths were removed, replaced, narrowed, or
  refactored.

## Delayering

- **Owns:** Duplicate ownership of parsing, validation, normalization,
  serialization, queries, locks, error capture, state, or decisions; parallel
  representations; and pass-through layers with no policy or transformation.
- **Does not own:** Healthy seams for dependency injection, composition,
  lifecycle, supported public API, domain vocabulary, compatibility, or test
  clocks merely because their implementation is thin.
- **Quality brake:** Remove a layer only when it carries no policy, side-effect
  seam, compatibility commitment, independent lifecycle, or useful domain
  meaning. Never replace narrow dependency injection with global or module
  mocking. Require semantic-equivalence tests before merging recurrence,
  serialization, or validation engines; require lock-order and concurrency
  evidence before collapsing transactional paths.
- **Applicability:** Run when wrappers, flags, adapters, abstractions,
  indirection, representations, or ownership changed.

## Type boundaries

- **Owns:** Real trust boundaries: untrusted, durable, provider, model, database,
  and public-constructor input; impossible states; nullability; schema/type
  drift; unsafe assertions; and types disconnected from their runtime or
  generated owner.
- **Does not own:** Terminology-only polish, changing a framework-normalized
  value to `unknown` without runtime benefit, unused exports, or a generic-heavy
  type framework whose only purpose is removing one cast.
- **Quality brake:** Parse and normalize once at the nearest owner, then keep
  downstream types narrow. Use the smallest discriminated union, derived type,
  or registry that prevents the demonstrated invalid state. Preserve public
  compatibility through one coherent extended API; do not create indefinite
  parallel old/new options or shims.
- **Applicability:** Run when typed interfaces, casts, nullable values, `any`,
  `unknown`, serialization, schemas, or public constructors changed.

## Generated/dependencies

- **Owns:** Missing, stale, or inconsistent generated/reference artifacts,
  schema and migration history, generated clients or API docs, manifests,
  lockfiles, dependency metadata, packed output, and eval recordings. This lane
  is the sole owner of stale generated or packed artifacts.
- **Does not own:** A generated delta merely because it differs from history,
  or an intentional stronger invariant automatically treated as compatibility
  drift. Dead code must not duplicate artifact findings from this lane.
- **Quality brake:** First classify the delta as intentional contract change or
  accidental drift. For an intentional change, verify runtime schema, generated
  schema, tests, migration/package evidence, and compatibility docs agree. Never
  recommend weakening a valid invariant solely to restore historical validation
  behavior.
- **Applicability:** Run only when the diff touches or should touch an API or
  storage schema, migration sequence, generated/reference output, manifest,
  lockfile, dependency, package artifact, CI dependency surface, or eval
  recording.
