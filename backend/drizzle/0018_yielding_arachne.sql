CREATE TABLE `companion_branch_draft` (
	`id` text PRIMARY KEY NOT NULL,
	`companion_identity_id` text NOT NULL,
	`parent_experiment_group_id` text NOT NULL,
	`user_seed_md` text NOT NULL,
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
	FOREIGN KEY (`parent_experiment_group_id`) REFERENCES `experiment_group`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `companion_branch_draft_identity` ON `companion_branch_draft` (`companion_identity_id`);--> statement-breakpoint
CREATE INDEX `companion_branch_draft_status` ON `companion_branch_draft` (`status`);--> statement-breakpoint
CREATE INDEX `companion_branch_draft_parent` ON `companion_branch_draft` (`parent_experiment_group_id`);