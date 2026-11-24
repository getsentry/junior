CREATE TABLE "junior_stats" (
	"date" date NOT NULL,
	"namespace" text NOT NULL,
	"metric" text NOT NULL,
	"name" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "junior_stats_date_namespace_metric_name_pk" PRIMARY KEY("date","namespace","metric","name")
);
