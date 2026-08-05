DROP INDEX `daily_plan_draft_key`;--> statement-breakpoint
ALTER TABLE `daily_plan` DROP COLUMN `top_priority`;--> statement-breakpoint
ALTER TABLE `daily_plan` DROP COLUMN `supporting_health`;--> statement-breakpoint
ALTER TABLE `daily_plan` DROP COLUMN `supporting_connection`;--> statement-breakpoint
ALTER TABLE `daily_plan` DROP COLUMN `first_domino`;--> statement-breakpoint
ALTER TABLE `daily_plan` DROP COLUMN `minimum_viable_day`;--> statement-breakpoint
ALTER TABLE `daily_plan` DROP COLUMN `parking_lot_json`;--> statement-breakpoint
ALTER TABLE `daily_plan` DROP COLUMN `draft_key`;