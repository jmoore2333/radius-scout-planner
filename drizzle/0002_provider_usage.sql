CREATE TABLE `provider_usage_periods` (
	`provider` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`limit` integer NOT NULL,
	`used` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`provider`, `period_start`)
);

CREATE TABLE `provider_usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`period_start` text NOT NULL,
	`units` integer NOT NULL,
	`reason` text NOT NULL,
	`metadata_json` text,
	`created_at` text NOT NULL
);
