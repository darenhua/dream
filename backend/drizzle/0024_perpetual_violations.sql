CREATE TABLE `monthly_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`theme` text NOT NULL,
	`theme_subline` text,
	`story` text NOT NULL,
	`promises_json` text DEFAULT '[]' NOT NULL,
	`subordinate_notes_json` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`superseded_by_plan_id` text,
	`source_conversation_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `monthly_plan_period` ON `monthly_plan` (`period_start`);--> statement-breakpoint
CREATE INDEX `monthly_plan_superseded` ON `monthly_plan` (`superseded_by_plan_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_if_then_chain` (
	`id` text PRIMARY KEY NOT NULL,
	`lineage_id` text,
	`version` integer,
	`prev_version_id` text,
	`source_conversation_id` text,
	`description` text,
	`experiment_group_lineage_id` text,
	`monthly_plan_id` text,
	`trigger` text NOT NULL,
	`friendly_cue_title` text,
	`zone` text,
	`kind` text,
	`shared_cue_with_lineage_id` text,
	`purpose` text,
	`minimum_version` text,
	`reward_kind` text,
	`reward_text` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_if_then_chain`("id", "lineage_id", "version", "prev_version_id", "source_conversation_id", "description", "experiment_group_lineage_id", "monthly_plan_id", "trigger", "friendly_cue_title", "zone", "kind", "shared_cue_with_lineage_id", "purpose", "minimum_version", "reward_kind", "reward_text", "status", "expires_at", "created_at", "updated_at") SELECT "id", "lineage_id", "version", "prev_version_id", "source_conversation_id", "description", "experiment_group_lineage_id", NULL, "trigger", NULL, NULL, NULL, NULL, "purpose", "minimum_version", "reward_kind", "reward_text", "status", "expires_at", "created_at", "updated_at" FROM `if_then_chain`;--> statement-breakpoint
DROP TABLE `if_then_chain`;--> statement-breakpoint
ALTER TABLE `__new_if_then_chain` RENAME TO `if_then_chain`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `if_then_chain_group` ON `if_then_chain` (`experiment_group_lineage_id`);--> statement-breakpoint
CREATE INDEX `if_then_chain_era` ON `if_then_chain` (`monthly_plan_id`);--> statement-breakpoint
ALTER TABLE `daily_plan` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `weekly_plan` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `weekly_plan` ADD `superseded_by_plan_id` text;--> statement-breakpoint
ALTER TABLE `weekly_plan` ADD `monthly_plan_id` text;--> statement-breakpoint
ALTER TABLE `weekly_plan` ADD `leisure_pool_json` text;--> statement-breakpoint
ALTER TABLE `weekly_plan` ADD `dated_events_json` text;--> statement-breakpoint
ALTER TABLE `weekly_plan` ADD `big_reward_json` text;--> statement-breakpoint
ALTER TABLE `weekly_plan` ADD `do_once_json` text;--> statement-breakpoint
ALTER TABLE `weekly_plan_chain` ADD `carryover` text;