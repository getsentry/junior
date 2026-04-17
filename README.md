# junior

Junior is a Slack bot runtime powered by Hono.

Use it to investigate issues, summarize context, and take action from Slack with connected tools.

## Documentation

Canonical docs live at **https://junior.sentry.dev/**.

Start here:

- [Quickstart](https://junior.sentry.dev/start-here/quickstart/)
- [Deploy on Vercel](https://junior.sentry.dev/start-here/deploy/)
- [Plugin setup](https://junior.sentry.dev/extend/plugins-overview/)
- [Contributing](https://junior.sentry.dev/contribute/development/)

## Packages

| Package                        | Purpose                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@sentry/junior`               | Core Slack bot runtime                                                                                                                                              |
| `@sentry/junior-agent-browser` | Agent Browser plugin package for browser automation                                                                                                                 |
| `@sentry/junior-datadog`       | Datadog plugin package for observability workflows (**non-functional**: Datadog has DCR locked down, see the [package README](./packages/junior-datadog/README.md)) |
| `@sentry/junior-github`        | GitHub plugin package for issue workflows                                                                                                                           |
| `@sentry/junior-linear`        | Linear plugin package for issue workflows                                                                                                                           |
| `@sentry/junior-notion`        | Notion plugin package for page search workflows                                                                                                                     |
| `@sentry/junior-sentry`        | Sentry plugin package for issue workflows                                                                                                                           |
