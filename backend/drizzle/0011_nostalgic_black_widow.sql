CREATE TABLE `collaboration_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`primary_entity_type` text,
	`primary_entity_id` text,
	`secret_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`redeemed_at` text,
	`workspace_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_invite_secret_hash_unique` ON `collaboration_invite` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `collaboration_invite_expiry` ON `collaboration_invite` (`expires_at`);--> statement-breakpoint
CREATE TABLE `collaboration_workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`invite_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`primary_entity_type` text NOT NULL,
	`primary_entity_id` text,
	`user_seed_md` text,
	`selected_organized_goal_ids_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`invite_id`) REFERENCES `collaboration_invite`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_workspace_invite_id_unique` ON `collaboration_workspace` (`invite_id`);--> statement-breakpoint
CREATE INDEX `collaboration_workspace_status` ON `collaboration_workspace` (`status`);--> statement-breakpoint
CREATE TABLE `draft_change_set` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`mode` text NOT NULL,
	`primary_entity_type` text NOT NULL,
	`primary_entity_id` text,
	`summary_md` text NOT NULL,
	`operations_json` text NOT NULL,
	`source_refs_json` text,
	`audit_json` text,
	`status` text DEFAULT 'drafting' NOT NULL,
	`rejection_note` text,
	`applied_at` text,
	`rejected_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `collaboration_workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `draft_change_set_workspace` ON `draft_change_set` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `draft_change_set_status` ON `draft_change_set` (`status`);--> statement-breakpoint
CREATE TABLE `experiment_group` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`motivation_md` text,
	`status` text DEFAULT 'active' NOT NULL,
	`closing_review_md` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `experiment_group_context` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_group_id` text NOT NULL,
	`text_md` text NOT NULL,
	`source_change_set_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`experiment_group_id`) REFERENCES `experiment_group`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `experiment_group_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_group_id` text NOT NULL,
	`organized_goal_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`experiment_group_id`) REFERENCES `experiment_group`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organized_goal_id`) REFERENCES `organized_goal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_group_goal_unique` ON `experiment_group_goal` (`experiment_group_id`,`organized_goal_id`);--> statement-breakpoint
CREATE TABLE `experiment_group_project` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_group_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`experiment_group_id`) REFERENCES `experiment_group`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_group_project_unique` ON `experiment_group_project` (`experiment_group_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `experiment_group_source` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_group_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`experiment_group_id`) REFERENCES `experiment_group`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_group_source_unique` ON `experiment_group_source` (`experiment_group_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `experiment_group_source_entity` ON `experiment_group_source` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `experiment_group_target` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_group_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail_md` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`done_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`experiment_group_id`) REFERENCES `experiment_group`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `experiment_organized_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`organized_goal_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organized_goal_id`) REFERENCES `organized_goal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_organized_goal_unique` ON `experiment_organized_goal` (`experiment_id`,`organized_goal_id`);--> statement-breakpoint
CREATE TABLE `organized_environment_item` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`synthesis_md` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `organized_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`identity_clause` text,
	`synthesis_md` text,
	`priority_rank` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `organized_goal_source` (
	`id` text PRIMARY KEY NOT NULL,
	`organized_goal_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organized_goal_id`) REFERENCES `organized_goal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organized_goal_source_unique` ON `organized_goal_source` (`organized_goal_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `organized_goal_source_entity` ON `organized_goal_source` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `organized_habit` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`synthesis_md` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `organized_registry_source` (
	`id` text PRIMARY KEY NOT NULL,
	`organized_entity_type` text NOT NULL,
	`organized_entity_id` text NOT NULL,
	`raw_entity_type` text NOT NULL,
	`raw_entity_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organized_registry_source_unique` ON `organized_registry_source` (`organized_entity_type`,`organized_entity_id`,`raw_entity_type`,`raw_entity_id`);--> statement-breakpoint
CREATE INDEX `organized_registry_source_raw` ON `organized_registry_source` (`raw_entity_type`,`raw_entity_id`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_source` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_source_unique` ON `project_source` (`project_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `project_source_entity` ON `project_source` (`entity_type`,`entity_id`);--> statement-breakpoint
ALTER TABLE `experiment` ADD `kind` text DEFAULT 'candidate' NOT NULL;--> statement-breakpoint
ALTER TABLE `experiment` ADD `experiment_group_id` text REFERENCES experiment_group(id);--> statement-breakpoint
ALTER TABLE `experiment` ADD `week_of` text;--> statement-breakpoint
ALTER TABLE `experiment` ADD `review_md` text;--> statement-breakpoint
ALTER TABLE `experiment_task` ADD `schedule_mode` text DEFAULT 'calendar' NOT NULL;--> statement-breakpoint
-- Preserve the semantics of historical runs: only old raw queue/archive rows
-- become candidates; anything that was scheduled, ran, or ended remains an
-- executable historical actionable record.
UPDATE `experiment`
SET `kind` = 'actionable'
WHERE `status` IN ('scheduling', 'running', 'succeeded', 'failed')
   OR `started_at` IS NOT NULL
   OR `plan_json` IS NOT NULL;
