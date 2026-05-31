# OpenTelemetry Semantics Verification Map

| Capability     | Requirement                | Scenario                                       | Primary Layer   | Current Coverage                                 | Action    | Gap / Notes                                       |
| -------------- | -------------------------- | ---------------------------------------------- | --------------- | ------------------------------------------------ | --------- | ------------------------------------------------- |
| OTel semantics | Semantic-first keys        | Existing semantic keys pass through            | Unit/code       | `logging.ts` normalization                       | keep      | More direct tests could help.                     |
| OTel semantics | Legacy aliases             | legacy keys map to current names               | Unit/code       | `LEGACY_KEY_MAP`                                 | add later | Explicit alias tests are not obvious.             |
| OTel semantics | `app.*` fallback           | unknown non-semantic keys normalize to `app.*` | Unit/code       | logging facade                                   | add later | Useful focused test gap.                          |
| OTel semantics | Core context keys          | LogContext maps Slack/user/model/run           | Unit            | `with-span.test.ts`, Pi tests                    | keep      | `app.run.id` naming remains open.                 |
| OTel semantics | GenAI keys                 | chat/tool/usage attributes use `gen_ai.*`      | Unit            | Pi, traced-stream, agent-tools, usage tests      | keep      | Finish reason canonicalization gap.               |
| OTel semantics | MCP keys                   | MCP/JSON-RPC/network/server attrs              | Unit            | `mcp/client.test.ts`, `mcp/tool-manager.test.ts` | keep      | Additional attributes may need tests.             |
| OTel semantics | Process keys               | sandbox bash spans use process keys            | Unit/manual     | sandbox code/tests                               | add later | Direct tracing assertion gap.                     |
| OTel semantics | `app.*` namespace families | custom keys stay domain-scoped                 | Static/spec     | `rg` inventory                                   | keep      | No exhaustive registry yet.                       |
| OTel semantics | Header safety              | safe HTTP/Slack header attrs only              | Security/manual | security/logging policy                          | add later | Header convention review needed before expansion. |
