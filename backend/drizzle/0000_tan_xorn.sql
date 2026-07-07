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
CREATE TABLE `category` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`top_k_override` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_name_unique` ON `category` (`name`);--> statement-breakpoint
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
	`categorize_processed_at` text,
	`parse_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_source_external` ON `conversation` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `conversation_slug_queue` ON `conversation` (`slug_detected`,`categorize_processed_at`);--> statement-breakpoint
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
CREATE TABLE `experiment` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`reasoning_md` text,
	`goal_ids` text DEFAULT '[]' NOT NULL,
	`levers_json` text DEFAULT '{}' NOT NULL,
	`actions_json` text DEFAULT '[]' NOT NULL,
	`bandwidth` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`committed_at` text,
	`ended_at` text,
	`outcome_md` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goal` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text,
	`title` text NOT NULL,
	`identity_clause` text,
	`synthesis_md` text,
	`status` text DEFAULT 'suggested' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `category`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
CREATE INDEX `proposal_scope_status` ON `proposal` (`scope_key`,`status`);--> statement-breakpoint
CREATE TABLE `rant_link` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`category_id` text NOT NULL,
	`active_for_derive` integer DEFAULT true NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `category`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rant_link_convo_category` ON `rant_link` (`conversation_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `registry_item` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`valence` text,
	`status` text DEFAULT 'active' NOT NULL,
	`source_conversation_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action
);
