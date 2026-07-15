CREATE TABLE `strike_state` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`paused_until` text,
	`pause_reason` text,
	`armed` integer DEFAULT true NOT NULL,
	`last_alert_at` text,
	`updated_at` text NOT NULL
);
