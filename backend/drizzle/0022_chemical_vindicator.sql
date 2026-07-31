ALTER TABLE `chain_run` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `daily_plan` ADD `superseded_by_plan_id` text;--> statement-breakpoint
ALTER TABLE `daily_plan` ADD `draft_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `daily_plan_draft_key` ON `daily_plan` (`draft_key`);