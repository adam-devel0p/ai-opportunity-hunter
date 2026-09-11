CREATE TABLE `exclusion_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
