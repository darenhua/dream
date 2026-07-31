CREATE TABLE `chain_run` (
	`id` text PRIMARY KEY NOT NULL,
	`chain_version_id` text NOT NULL,
	`daily_plan_id` text,
	`calendar_event_id` text,
	`date` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`minimum_only` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chain_version_id`) REFERENCES `if_then_chain`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`daily_plan_id`) REFERENCES `daily_plan`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chain_run_date` ON `chain_run` (`date`);--> statement-breakpoint
CREATE INDEX `chain_run_plan` ON `chain_run` (`daily_plan_id`);--> statement-breakpoint
CREATE TABLE `chain_run_step` (
	`id` text PRIMARY KEY NOT NULL,
	`chain_run_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`done_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chain_run_id`) REFERENCES `chain_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chain_run_step_run` ON `chain_run_step` (`chain_run_id`);--> statement-breakpoint
CREATE TABLE `if_then_chain` (
	`id` text PRIMARY KEY NOT NULL,
	`lineage_id` text,
	`version` integer,
	`prev_version_id` text,
	`source_conversation_id` text,
	`description` text,
	`experiment_group_lineage_id` text NOT NULL,
	`trigger` text NOT NULL,
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
CREATE INDEX `if_then_chain_group` ON `if_then_chain` (`experiment_group_lineage_id`);--> statement-breakpoint
CREATE TABLE `if_then_chain_step` (
	`id` text PRIMARY KEY NOT NULL,
	`chain_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chain_id`) REFERENCES `if_then_chain`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `if_then_chain_step_chain` ON `if_then_chain_step` (`chain_id`);--> statement-breakpoint
CREATE TABLE `plan_doc` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`ref_id` text NOT NULL,
	`content_md` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_doc_scope_ref` ON `plan_doc` (`scope`,`ref_id`);--> statement-breakpoint
CREATE TABLE `weekly_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`current_focus_id` text NOT NULL,
	`week_of` text NOT NULL,
	`direction` text,
	`theme` text,
	`top_outcomes_json` text,
	`milestones_json` text,
	`health_priority` text,
	`social_priority` text,
	`maintenance_priority` text,
	`fear_to_face` text,
	`failure_points_json` text,
	`success_definition` text,
	`candidate_missions_json` text,
	`description` text,
	`source_conversation_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`current_focus_id`) REFERENCES `current_focus`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `weekly_plan_week` ON `weekly_plan` (`week_of`);--> statement-breakpoint
CREATE INDEX `weekly_plan_focus` ON `weekly_plan` (`current_focus_id`);--> statement-breakpoint
CREATE TABLE `weekly_plan_chain` (
	`id` text PRIMARY KEY NOT NULL,
	`weekly_plan_id` text NOT NULL,
	`chain_lineage_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`weekly_plan_id`) REFERENCES `weekly_plan`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weekly_plan_chain_unique` ON `weekly_plan_chain` (`weekly_plan_id`,`chain_lineage_id`);--> statement-breakpoint
CREATE TABLE `win_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`chain_run_step_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `win_entry_date` ON `win_entry` (`date`);--> statement-breakpoint
ALTER TABLE `daily_plan` ADD `top_priority` text;--> statement-breakpoint
ALTER TABLE `daily_plan` ADD `supporting_health` text;--> statement-breakpoint
ALTER TABLE `daily_plan` ADD `supporting_connection` text;--> statement-breakpoint
ALTER TABLE `daily_plan` ADD `first_domino` text;--> statement-breakpoint
ALTER TABLE `daily_plan` ADD `minimum_viable_day` text;--> statement-breakpoint
ALTER TABLE `daily_plan` ADD `parking_lot_json` text;