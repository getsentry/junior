CREATE TABLE "junior_task_executions" (
	"execution_id" text NOT NULL,
	"kind" text NOT NULL,
	"namespace" text NOT NULL,
	"task_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"executed_at_ms" bigint NOT NULL,
	CONSTRAINT "junior_task_executions_kind_namespace_execution_id_pk" PRIMARY KEY("kind","namespace","execution_id")
);
--> statement-breakpoint
ALTER TABLE "junior_task_executions" ADD CONSTRAINT "junior_task_executions_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_task_executions_task_time_idx" ON "junior_task_executions" USING btree ("kind","namespace","task_id","executed_at_ms");--> statement-breakpoint
CREATE INDEX "junior_task_executions_time_kind_idx" ON "junior_task_executions" USING btree ("executed_at_ms","kind");--> statement-breakpoint
CREATE INDEX "junior_task_executions_conversation_time_idx" ON "junior_task_executions" USING btree ("conversation_id","executed_at_ms");