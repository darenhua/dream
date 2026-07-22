ALTER TABLE `experiment_group` ADD `parent_experiment_group_id` text REFERENCES experiment_group(id);--> statement-breakpoint
ALTER TABLE `experiment_group` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `experiment_group` ADD `archived_from_status` text;--> statement-breakpoint
CREATE INDEX `experiment_group_parent` ON `experiment_group` (`parent_experiment_group_id`);