CREATE TABLE `planning_flow_session` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_type` text NOT NULL,
	`operation` text NOT NULL,
	`target_start_date` text NOT NULL,
	`target_end_date` text,
	`target_plan_id` text,
	`initial_plan_revision` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`context_snapshot_json` text,
	`playbook_version` text NOT NULL,
	`request_id` text,
	`payload_hash` text,
	`receipt_json` text,
	`result_plan_id` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planning_flow_session_target` ON `planning_flow_session` (`plan_type`,`target_start_date`,`status`);--> statement-breakpoint
CREATE INDEX `planning_flow_session_status` ON `planning_flow_session` (`status`);