CREATE TABLE `inbound_message` (
	`id` text PRIMARY KEY NOT NULL,
	`witness_id` text,
	`chat_id` text NOT NULL,
	`sender_handle` text NOT NULL,
	`from_user` integer DEFAULT false NOT NULL,
	`text` text NOT NULL,
	`transport_message_id` text,
	`processed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`witness_id`) REFERENCES `witness`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_message_transport_message_id_unique` ON `inbound_message` (`transport_message_id`);--> statement-breakpoint
CREATE INDEX `inbound_chat` ON `inbound_message` (`chat_id`);--> statement-breakpoint
ALTER TABLE `witness` ADD `link_requested_at` text;