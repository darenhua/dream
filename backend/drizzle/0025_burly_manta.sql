PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_weekly_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`current_focus_id` text,
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
	`revision` integer DEFAULT 1 NOT NULL,
	`superseded_by_plan_id` text,
	`monthly_plan_id` text,
	`leisure_pool_json` text,
	`dated_events_json` text,
	`big_reward_json` text,
	`do_once_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`current_focus_id`) REFERENCES `current_focus`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_weekly_plan`("id", "current_focus_id", "week_of", "direction", "theme", "top_outcomes_json", "milestones_json", "health_priority", "social_priority", "maintenance_priority", "fear_to_face", "failure_points_json", "success_definition", "candidate_missions_json", "description", "source_conversation_id", "revision", "superseded_by_plan_id", "monthly_plan_id", "leisure_pool_json", "dated_events_json", "big_reward_json", "do_once_json", "created_at", "updated_at") SELECT "id", "current_focus_id", "week_of", "direction", "theme", "top_outcomes_json", "milestones_json", "health_priority", "social_priority", "maintenance_priority", "fear_to_face", "failure_points_json", "success_definition", "candidate_missions_json", "description", "source_conversation_id", "revision", "superseded_by_plan_id", "monthly_plan_id", "leisure_pool_json", "dated_events_json", "big_reward_json", "do_once_json", "created_at", "updated_at" FROM `weekly_plan`;--> statement-breakpoint
DROP TABLE `weekly_plan`;--> statement-breakpoint
ALTER TABLE `__new_weekly_plan` RENAME TO `weekly_plan`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `weekly_plan_week` ON `weekly_plan` (`week_of`);--> statement-breakpoint
CREATE INDEX `weekly_plan_focus` ON `weekly_plan` (`current_focus_id`);