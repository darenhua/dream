CREATE TABLE `collaboration_workspace_index` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`index_version` integer DEFAULT 1 NOT NULL,
	`markdown_index` text NOT NULL,
	`reference_manifest_json` text NOT NULL,
	`source_snapshot_json` text NOT NULL,
	`generated_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `collaboration_workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_workspace_index_workspace_id_unique` ON `collaboration_workspace_index` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `collaboration_workspace_index_workspace` ON `collaboration_workspace_index` (`workspace_id`);