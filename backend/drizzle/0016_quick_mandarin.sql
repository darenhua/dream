CREATE TABLE `current_focus` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_group_id` text NOT NULL,
	`previous_current_focus_id` text,
	`status` text DEFAULT 'current' NOT NULL,
	`entry_reason` text NOT NULL,
	`reasoning_md` text NOT NULL,
	`source_change_set_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`experiment_group_id`) REFERENCES `experiment_group`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `current_focus_group` ON `current_focus` (`experiment_group_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `current_focus_one_current` ON `current_focus` (`status`) WHERE "current_focus"."status" = 'current';--> statement-breakpoint
CREATE TABLE `current_focus_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`current_focus_id` text NOT NULL,
	`organized_goal_id` text NOT NULL,
	`priority_rank` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`current_focus_id`) REFERENCES `current_focus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organized_goal_id`) REFERENCES `organized_goal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `current_focus_goal_unique` ON `current_focus_goal` (`current_focus_id`,`organized_goal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `current_focus_goal_rank_unique` ON `current_focus_goal` (`current_focus_id`,`priority_rank`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_experiment_group` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`motivation_md` text,
	`status` text DEFAULT 'candidate' NOT NULL,
	`closing_review_md` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_experiment_group`("id", "title", "motivation_md", "status", "closing_review_md", "created_at", "updated_at") SELECT "id", "title", "motivation_md", "status", "closing_review_md", "created_at", "updated_at" FROM `experiment_group`;--> statement-breakpoint
DROP TABLE `experiment_group`;--> statement-breakpoint
ALTER TABLE `__new_experiment_group` RENAME TO `experiment_group`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `collaboration_invite` ADD `prioritize_action` text;--> statement-breakpoint
ALTER TABLE `collaboration_workspace` ADD `prioritize_action` text;--> statement-breakpoint
-- Earlier organized work allowed several active groups because no focus
-- decision existed. The revised model starts with no selected focus; users
-- deliberately pick one through a reviewed prioritize workspace.
UPDATE `experiment_group` SET `status` = 'candidate' WHERE `status` = 'active';
