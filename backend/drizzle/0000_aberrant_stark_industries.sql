CREATE TABLE `agent_run` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_name` text NOT NULL,
	`trigger` text NOT NULL,
	`workspace_path` text,
	`output_json` text,
	`status` text NOT NULL,
	`token_usage` text,
	`duration_ms` integer,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `anchor_event` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `anchor_event_date` ON `anchor_event` (`date`);--> statement-breakpoint
CREATE TABLE `calendar_event` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`gcal_event_id` text,
	`title` text NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`rrule` text,
	`block_style` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_gcal_event_id_unique` ON `calendar_event` (`gcal_event_id`);--> statement-breakpoint
CREATE INDEX `calendar_event_entity` ON `calendar_event` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `chat_message` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`agent_run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_message_session` ON `chat_message` (`session_id`);--> statement-breakpoint
CREATE TABLE `chat_session` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text DEFAULT 'schedule' NOT NULL,
	`experiment_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`plan_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text DEFAULT 'claude' NOT NULL,
	`external_id` text NOT NULL,
	`title` text,
	`content_json` text,
	`raw_json` text NOT NULL,
	`content_hash` text,
	`source_created_at` text,
	`source_updated_at` text,
	`slug_detected` integer DEFAULT false NOT NULL,
	`slug_message_idx` integer,
	`distill_requested` integer DEFAULT false NOT NULL,
	`distilled_at` text,
	`extractions_reviewed_at` text,
	`derived_at` text,
	`parse_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_source_external` ON `conversation` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `conversation_pipeline` ON `conversation` (`slug_detected`,`distill_requested`,`distilled_at`,`extractions_reviewed_at`,`derived_at`);--> statement-breakpoint
CREATE TABLE `daily_writeup` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`text` text NOT NULL,
	`agent_run_id` text,
	`days_since_last_visit_at_generation` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_writeup_date_unique` ON `daily_writeup` (`date`);--> statement-breakpoint
CREATE TABLE `environment_item` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`sub_kind` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`rrule` text,
	`duration_minutes` integer,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`event_type` text NOT NULL,
	`payload_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_entity` ON `event` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `experience` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`state` text NOT NULL,
	`planned_for` text,
	`had_at` text,
	`experiment_task_id` text,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`experiment_task_id`) REFERENCES `experiment_task`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `experiment` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`hypothesis_md` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`proposal_id` text,
	`bandwidth` text,
	`planned_duration_days` integer,
	`plan_json` text,
	`queued_at` text,
	`started_at` text,
	`ended_at` text,
	`outcome_md` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `experiment_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_goal_unique` ON `experiment_goal` (`experiment_id`,`goal_id`);--> statement-breakpoint
CREATE TABLE `experiment_task` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`scheduled_for` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `extraction` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`start_idx` integer,
	`end_idx` integer,
	`content_hash` text NOT NULL,
	`origin` text NOT NULL,
	`agent_run_id` text,
	`confirmed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `extraction_conversation` ON `extraction` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `extraction_confirmed` ON `extraction` (`confirmed_at`);--> statement-breakpoint
CREATE TABLE `extraction_link` (
	`id` text PRIMARY KEY NOT NULL,
	`extraction_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`proposal_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`extraction_id`) REFERENCES `extraction`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extraction_link_unique` ON `extraction_link` (`extraction_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `extraction_link_entity` ON `extraction_link` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `goal` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`identity_clause` text,
	`synthesis_md` text,
	`status` text DEFAULT 'backlog' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goal_environment` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`environment_item_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goal`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_item_id`) REFERENCES `environment_item`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_environment_unique` ON `goal_environment` (`goal_id`,`environment_item_id`);--> statement-breakpoint
CREATE TABLE `goal_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`conversation_id` text,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goal`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `goal_habit` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`habit_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goal`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`habit_id`) REFERENCES `habit`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_habit_unique` ON `goal_habit` (`goal_id`,`habit_id`);--> statement-breakpoint
CREATE TABLE `google_auth` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`refresh_token` text NOT NULL,
	`access_token` text,
	`access_token_expires_at` text,
	`dream_calendar_id` text,
	`sync_token` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `habit` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`valence` text DEFAULT 'good' NOT NULL,
	`status` text NOT NULL,
	`rrule` text,
	`preferred_time` text,
	`duration_minutes` integer,
	`experiment_id` text,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`scope_key` text NOT NULL,
	`agent_run_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_at` text,
	`denial_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `proposal_scope_status` ON `proposal` (`scope_key`,`status`);