PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_experiment_group_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_group_id` text NOT NULL,
	`organized_goal_id` text NOT NULL,
	`rank` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_experiment_group_goal`("id", "experiment_group_id", "organized_goal_id", "rank", "created_at") SELECT "id", "experiment_group_id", "organized_goal_id", "rank", "created_at" FROM `experiment_group_goal`;--> statement-breakpoint
DROP TABLE `experiment_group_goal`;--> statement-breakpoint
ALTER TABLE `__new_experiment_group_goal` RENAME TO `experiment_group_goal`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_group_goal_unique` ON `experiment_group_goal` (`experiment_group_id`,`organized_goal_id`);--> statement-breakpoint
CREATE TABLE `__new_goal_habit` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`habit_id` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_goal_habit`("id", "goal_id", "habit_id", "description", "created_at") SELECT "id", "goal_id", "habit_id", "description", "created_at" FROM `goal_habit`;--> statement-breakpoint
DROP TABLE `goal_habit`;--> statement-breakpoint
ALTER TABLE `__new_goal_habit` RENAME TO `goal_habit`;--> statement-breakpoint
CREATE UNIQUE INDEX `goal_habit_unique` ON `goal_habit` (`goal_id`,`habit_id`);--> statement-breakpoint
CREATE TABLE `__new_draft_change_set` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`mode` text,
	`primary_entity_type` text,
	`primary_entity_id` text,
	`summary_md` text NOT NULL,
	`operations_json` text NOT NULL,
	`source_refs_json` text,
	`audit_json` text,
	`status` text DEFAULT 'drafting' NOT NULL,
	`rejection_note` text,
	`reconciliation_json` text,
	`marker_token` text,
	`submitted_at` text,
	`applied_records_json` text,
	`applied_at` text,
	`rejected_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `collaboration_workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_draft_change_set`("id", "workspace_id", "mode", "primary_entity_type", "primary_entity_id", "summary_md", "operations_json", "source_refs_json", "audit_json", "status", "rejection_note", "reconciliation_json", "marker_token", "submitted_at", "applied_records_json", "applied_at", "rejected_at", "created_at", "updated_at") SELECT "id", "workspace_id", "mode", "primary_entity_type", "primary_entity_id", "summary_md", "operations_json", "source_refs_json", "audit_json", "status", "rejection_note", "reconciliation_json", "marker_token", "submitted_at", "applied_records_json", "applied_at", "rejected_at", "created_at", "updated_at" FROM `draft_change_set`;--> statement-breakpoint
DROP TABLE `draft_change_set`;--> statement-breakpoint
ALTER TABLE `__new_draft_change_set` RENAME TO `draft_change_set`;--> statement-breakpoint
CREATE INDEX `draft_change_set_workspace` ON `draft_change_set` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `draft_change_set_status` ON `draft_change_set` (`status`);