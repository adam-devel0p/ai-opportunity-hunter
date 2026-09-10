CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_domain` text NOT NULL,
	`website` text NOT NULL,
	`country` text,
	`region` text,
	`industry` text,
	`business_type` text,
	`size_estimate` text,
	`size_confidence` text,
	`language` text,
	`description` text,
	`first_discovered_at` integer NOT NULL,
	`last_discovered_at` integer NOT NULL,
	`last_researched_at` integer,
	`next_eligible_research_at` integer,
	`source_campaign_id` text,
	`lifecycle_status` text NOT NULL,
	`exclusion_reason` text,
	`do_not_contact` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_campaign_id`) REFERENCES `discovery_campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_normalized_domain_unique` ON `companies` (`normalized_domain`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text,
	`source` text,
	`profile_url` text,
	`email` text,
	`email_source` text,
	`email_confidence` text NOT NULL,
	`do_not_contact` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `discovery_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`criteria` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evidence_items` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`opportunity_id` text,
	`source_id` text NOT NULL,
	`claim` text NOT NULL,
	`classification` text NOT NULL,
	`supporting_excerpt` text,
	`confidence` real NOT NULL,
	`generated_by_task_id` text,
	`generated_by_prompt_version` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`generated_by_task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `offers` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text NOT NULL,
	`scope` text NOT NULL,
	`expected_outcome` text NOT NULL,
	`key_assumptions` text,
	`duration_estimate` text,
	`price` integer NOT NULL,
	`recurring_price` integer,
	`exclusions` text,
	`validation_needed` text,
	`demo_concept` text,
	`price_band` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`problem_title` text NOT NULL,
	`problem_description` text NOT NULL,
	`problem_category` text NOT NULL,
	`economic_impact` text,
	`impact_assumptions` text,
	`affected_role` text,
	`proposed_solution` text NOT NULL,
	`implementation_strategy` text,
	`dependencies` text,
	`risks` text,
	`estimated_duration_days` real,
	`suggested_price_min` integer,
	`suggested_price_max` integer,
	`recurring_revenue_possibility` text,
	`demo_concept` text,
	`confidence` real,
	`status` text NOT NULL,
	`operator_feedback` text,
	`rejection_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `opportunity_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text NOT NULL,
	`evidence_strength` integer NOT NULL,
	`pain_severity` integer NOT NULL,
	`economic_impact_score` integer NOT NULL,
	`deliverability` integer NOT NULL,
	`purchase_likelihood` integer NOT NULL,
	`speed_to_value` integer NOT NULL,
	`reachability` integer NOT NULL,
	`demonstrability` integer NOT NULL,
	`repeatability` integer NOT NULL,
	`urgency` integer NOT NULL,
	`raw_score` integer NOT NULL,
	`penalties` text NOT NULL,
	`adjusted_score` integer NOT NULL,
	`verifier_result` text,
	`verifier_confidence` real,
	`verifier_weaknesses` text,
	`verifier_unsupported_assumptions` text,
	`verifier_missing_info` text,
	`verifier_dealkillers` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `outreach_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`word_count` integer NOT NULL,
	`prompt_version` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `outreach_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`outreach_draft_id` text NOT NULL,
	`event` text NOT NULL,
	`note` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`outreach_draft_id`) REFERENCES `outreach_drafts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `prompt_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_type` text NOT NULL,
	`version` integer NOT NULL,
	`template` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text,
	`url` text NOT NULL,
	`title` text,
	`retrieved_at` integer NOT NULL,
	`fetched_by_task_id` text,
	`freshness_state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fetched_by_task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `system_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`task_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`run_after` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
