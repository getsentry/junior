CREATE TABLE "junior_conversation_metrics" (
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_conversation_metrics_conversation_id_run_id_metric_pk" PRIMARY KEY("conversation_id","run_id","metric")
);
--> statement-breakpoint
ALTER TABLE "junior_conversation_metrics" ADD CONSTRAINT "junior_conversation_metrics_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_conversation_metrics_occurred_at_metric_idx" ON "junior_conversation_metrics" USING btree ("occurred_at","metric");--> statement-breakpoint
INSERT INTO "junior_conversation_metrics" ("conversation_id", "run_id", "metric", "value", "occurred_at", "updated_at")
SELECT conversation_id, coalesce(metric_run_id, 'legacy:' || conversation_id), metric, value, updated_at, updated_at
FROM junior_conversations
CROSS JOIN LATERAL (VALUES
  ('duration_ms', duration_ms::double precision),
  ('total_tokens', CASE WHEN coalesce(usage_json->>'inputTokens', usage_json->>'outputTokens', usage_json->>'cachedInputTokens', usage_json->>'cacheCreationTokens') IS NOT NULL THEN coalesce((usage_json->>'inputTokens')::double precision, 0) + coalesce((usage_json->>'outputTokens')::double precision, 0) + coalesce((usage_json->>'cachedInputTokens')::double precision, 0) + coalesce((usage_json->>'cacheCreationTokens')::double precision, 0) ELSE (usage_json->>'totalTokens')::double precision END),
  ('input_tokens', (usage_json->>'inputTokens')::double precision),
  ('output_tokens', (usage_json->>'outputTokens')::double precision),
  ('cached_input_tokens', (usage_json->>'cachedInputTokens')::double precision),
  ('cache_creation_tokens', (usage_json->>'cacheCreationTokens')::double precision),
  ('reasoning_tokens', (usage_json->>'reasoningTokens')::double precision),
  ('cost_usd', CASE WHEN usage_json->'cost'->>'total' IS NOT NULL THEN (usage_json->'cost'->>'total')::double precision WHEN coalesce(usage_json->'cost'->>'input', usage_json->'cost'->>'output', usage_json->'cost'->>'cacheRead', usage_json->'cost'->>'cacheWrite') IS NOT NULL THEN coalesce((usage_json->'cost'->>'input')::double precision, 0) + coalesce((usage_json->'cost'->>'output')::double precision, 0) + coalesce((usage_json->'cost'->>'cacheRead')::double precision, 0) + coalesce((usage_json->'cost'->>'cacheWrite')::double precision, 0) END)
) AS metric_rows(metric, value)
WHERE value IS NOT NULL AND value >= 0;
