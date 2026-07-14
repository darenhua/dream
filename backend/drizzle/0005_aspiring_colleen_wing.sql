CREATE TABLE `outbound_message` (
	`id` text PRIMARY KEY NOT NULL,
	`witness_id` text NOT NULL,
	`kind` text NOT NULL,
	`body_text` text NOT NULL,
	`context_json` text,
	`related_type` text,
	`related_id` text,
	`dedupe_key` text,
	`status` text DEFAULT 'pending_approval' NOT NULL,
	`not_before` text,
	`sent_at` text,
	`transport_message_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`witness_id`) REFERENCES `witness`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `outbound_status` ON `outbound_message` (`status`);--> statement-breakpoint
CREATE INDEX `outbound_dedupe` ON `outbound_message` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `review_writeup` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`draft_md` text,
	`final_md` text,
	`status` text DEFAULT 'drafting' NOT NULL,
	`agent_run_id` text,
	`approved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_writeup_experiment_id_unique` ON `review_writeup` (`experiment_id`);