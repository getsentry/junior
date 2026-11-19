CREATE TABLE "junior_hourly_stats" (
	"hour" timestamp with time zone NOT NULL,
	"namespace" text NOT NULL,
	"metric" text NOT NULL,
	"name" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "junior_hourly_stats_hour_namespace_metric_name_pk" PRIMARY KEY("hour","namespace","metric","name")
);
