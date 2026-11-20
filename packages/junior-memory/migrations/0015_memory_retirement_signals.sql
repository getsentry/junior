ALTER TABLE "junior_memory_signals" DROP CONSTRAINT "junior_memory_signals_signal_check";--> statement-breakpoint
-- The new check only allows more values, so every existing row passes. NOT
-- VALID skips the scan under lock and still checks every new write.
ALTER TABLE "junior_memory_signals" ADD CONSTRAINT "junior_memory_signals_signal_check" CHECK ("junior_memory_signals"."signal" IN ('duplicate', 'contradicted', 'superseded')) NOT VALID;
