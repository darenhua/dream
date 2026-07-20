CREATE TABLE `conversation_record_link` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`marker_token` text NOT NULL,
	`slice_end_idx` integer,
	`record_type` text NOT NULL,
	`record_version_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_record_link_conversation` ON `conversation_record_link` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `conversation_record_link_record` ON `conversation_record_link` (`record_type`,`record_version_id`);--> statement-breakpoint
CREATE TABLE `daily_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`weekly_plan_id` text,
	`date` text NOT NULL,
	`theme` text,
	`description` text,
	`source_conversation_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `daily_plan_date` ON `daily_plan` (`date`);--> statement-breakpoint
CREATE TABLE `daily_plan_item` (
	`id` text PRIMARY KEY NOT NULL,
	`daily_plan_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`calendar_event_id` text,
	`task_lineage_id` text,
	`done_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`daily_plan_id`) REFERENCES `daily_plan`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `daily_plan_item_plan` ON `daily_plan_item` (`daily_plan_id`);--> statement-breakpoint
CREATE TABLE `experiment_idea` (
	`id` text PRIMARY KEY NOT NULL,
	`lineage_id` text,
	`version` integer,
	`prev_version_id` text,
	`source_conversation_id` text,
	`description` text,
	`title` text NOT NULL,
	`retired_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goal_pattern` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_lineage_id` text NOT NULL,
	`pattern_lineage_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_pattern_unique` ON `goal_pattern` (`goal_lineage_id`,`pattern_lineage_id`);--> statement-breakpoint
CREATE TABLE `group_habit` (
	`id` text PRIMARY KEY NOT NULL,
	`group_lineage_id` text NOT NULL,
	`habit_lineage_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_habit_unique` ON `group_habit` (`group_lineage_id`,`habit_lineage_id`);--> statement-breakpoint
CREATE TABLE `group_idea` (
	`id` text PRIMARY KEY NOT NULL,
	`group_lineage_id` text NOT NULL,
	`idea_lineage_id` text NOT NULL,
	`done_at` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_idea_unique` ON `group_idea` (`group_lineage_id`,`idea_lineage_id`);--> statement-breakpoint
CREATE TABLE `idea_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`idea_lineage_id` text NOT NULL,
	`goal_lineage_id` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idea_goal_unique` ON `idea_goal` (`idea_lineage_id`,`goal_lineage_id`);--> statement-breakpoint
CREATE TABLE `idea_project` (
	`id` text PRIMARY KEY NOT NULL,
	`idea_lineage_id` text NOT NULL,
	`project_lineage_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idea_project_unique` ON `idea_project` (`idea_lineage_id`,`project_lineage_id`);--> statement-breakpoint
CREATE TABLE `leisure_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`lineage_id` text,
	`version` integer,
	`prev_version_id` text,
	`source_conversation_id` text,
	`description` text,
	`title` text NOT NULL,
	`counteracts_pattern_lineage_id` text,
	`fits_when` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lineage_parent` (
	`id` text PRIMARY KEY NOT NULL,
	`child_type` text NOT NULL,
	`child_lineage_id` text NOT NULL,
	`parent_type` text NOT NULL,
	`parent_version_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lineage_parent_child` ON `lineage_parent` (`child_type`,`child_lineage_id`);--> statement-breakpoint
CREATE TABLE `pattern_of_behavior` (
	`id` text PRIMARY KEY NOT NULL,
	`lineage_id` text,
	`version` integer,
	`prev_version_id` text,
	`source_conversation_id` text,
	`description` text,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`lineage_id` text,
	`version` integer,
	`prev_version_id` text,
	`source_conversation_id` text,
	`description` text,
	`title` text NOT NULL,
	`deadline_date` text,
	`done_at` text,
	`dropped_at` text,
	`experiment_idea_lineage_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `pushed_at` text;--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `push_failed_at` text;--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `push_error` text;--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `completed_at` text;--> statement-breakpoint
ALTER TABLE `current_focus` ADD `end_date` text;--> statement-breakpoint
ALTER TABLE `draft_change_set` ADD `reconciliation_json` text;--> statement-breakpoint
ALTER TABLE `draft_change_set` ADD `marker_token` text;--> statement-breakpoint
ALTER TABLE `draft_change_set` ADD `submitted_at` text;--> statement-breakpoint
ALTER TABLE `environment_item` ADD `lineage_id` text;--> statement-breakpoint
ALTER TABLE `environment_item` ADD `version` integer;--> statement-breakpoint
ALTER TABLE `environment_item` ADD `prev_version_id` text;--> statement-breakpoint
ALTER TABLE `environment_item` ADD `source_conversation_id` text;--> statement-breakpoint
ALTER TABLE `environment_item` ADD `description` text;--> statement-breakpoint
ALTER TABLE `environment_item` ADD `habit_lineage_id` text;--> statement-breakpoint
ALTER TABLE `environment_item` ADD `effect` text;--> statement-breakpoint
ALTER TABLE `experiment` ADD `current_focus_id` text;--> statement-breakpoint
ALTER TABLE `experiment` ADD `theme` text;--> statement-breakpoint
ALTER TABLE `experiment` ADD `description` text;--> statement-breakpoint
ALTER TABLE `experiment_group` ADD `lineage_id` text;--> statement-breakpoint
ALTER TABLE `experiment_group` ADD `version` integer;--> statement-breakpoint
ALTER TABLE `experiment_group` ADD `prev_version_id` text;--> statement-breakpoint
ALTER TABLE `experiment_group` ADD `source_conversation_id` text;--> statement-breakpoint
ALTER TABLE `experiment_group` ADD `description` text;--> statement-breakpoint
ALTER TABLE `experiment_group` ADD `theme` text;--> statement-breakpoint
ALTER TABLE `experiment_group_goal` ADD `rank` integer;--> statement-breakpoint
ALTER TABLE `experiment_task` ADD `done_at` text;--> statement-breakpoint
ALTER TABLE `habit` ADD `lineage_id` text;--> statement-breakpoint
ALTER TABLE `habit` ADD `version` integer;--> statement-breakpoint
ALTER TABLE `habit` ADD `prev_version_id` text;--> statement-breakpoint
ALTER TABLE `habit` ADD `source_conversation_id` text;--> statement-breakpoint
ALTER TABLE `habit` ADD `description` text;--> statement-breakpoint
ALTER TABLE `habit` ADD `current_focus_id` text;--> statement-breakpoint
ALTER TABLE `organized_goal` ADD `lineage_id` text;--> statement-breakpoint
ALTER TABLE `organized_goal` ADD `version` integer;--> statement-breakpoint
ALTER TABLE `organized_goal` ADD `prev_version_id` text;--> statement-breakpoint
ALTER TABLE `organized_goal` ADD `source_conversation_id` text;--> statement-breakpoint
ALTER TABLE `organized_goal` ADD `description` text;--> statement-breakpoint
ALTER TABLE `organized_goal` ADD `retired_at` text;--> statement-breakpoint
ALTER TABLE `project` ADD `lineage_id` text;--> statement-breakpoint
ALTER TABLE `project` ADD `version` integer;--> statement-breakpoint
ALTER TABLE `project` ADD `prev_version_id` text;--> statement-breakpoint
ALTER TABLE `project` ADD `source_conversation_id` text;--> statement-breakpoint
ALTER TABLE `project` ADD `description` text;--> statement-breakpoint
UPDATE `organized_goal` SET `lineage_id` = `id`, `version` = 1 WHERE `lineage_id` IS NULL;--> statement-breakpoint
UPDATE `habit` SET `lineage_id` = `id`, `version` = 1 WHERE `lineage_id` IS NULL;--> statement-breakpoint
UPDATE `environment_item` SET `lineage_id` = `id`, `version` = 1 WHERE `lineage_id` IS NULL;--> statement-breakpoint
UPDATE `project` SET `lineage_id` = `id`, `version` = 1 WHERE `lineage_id` IS NULL;--> statement-breakpoint
UPDATE `experiment_group` SET `lineage_id` = `id`, `version` = 1 WHERE `lineage_id` IS NULL;--> statement-breakpoint
INSERT INTO `lineage_parent` (`id`, `child_type`, `child_lineage_id`, `parent_type`, `parent_version_id`, `created_at`)
SELECT lower(hex(randomblob(16))), 'experiment_group', `id`, 'experiment_group', `parent_experiment_group_id`, datetime('now')
FROM `experiment_group` WHERE `parent_experiment_group_id` IS NOT NULL;
