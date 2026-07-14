CREATE TABLE `experiment_task_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_task_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`experiment_task_id`) REFERENCES `experiment_task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_task_goal_unique` ON `experiment_task_goal` (`experiment_task_id`,`goal_id`);--> statement-breakpoint
CREATE TABLE `witness` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform` text DEFAULT 'manual' NOT NULL,
	`handle` text,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`invite_code` text,
	`chat_id` text,
	`linked_at` text,
	`prompt_cadence_days` integer DEFAULT 4 NOT NULL,
	`last_prompt_at` text,
	`muted_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `witness_invite_code_unique` ON `witness` (`invite_code`);--> statement-breakpoint
CREATE TABLE `witness_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`witness_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`witness_id`) REFERENCES `witness`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `witness_goal_unique` ON `witness_goal` (`witness_id`,`goal_id`);