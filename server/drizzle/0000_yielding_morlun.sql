CREATE TABLE `admin_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`absolute_expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_users` (
	`username` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `camera_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`camera_id` text NOT NULL,
	`type` text NOT NULL,
	`state` text NOT NULL,
	`occurred_at` text NOT NULL,
	`received_at` text NOT NULL,
	`source` text NOT NULL,
	`topic` text NOT NULL,
	`dedup_hash` text NOT NULL,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `camera_events_dedup_hash_unique` ON `camera_events` (`dedup_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `camera_events_camera_id_id_idx` ON `camera_events` (`camera_id`,`id`);--> statement-breakpoint
CREATE TABLE `cameras` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`onvif_port` integer NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`password_enc` text NOT NULL,
	`rtsp_override_enc` text,
	`profile_token` text DEFAULT '' NOT NULL,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`state` text DEFAULT 'disabled' NOT NULL,
	`last_error` text,
	`last_seen_at` text,
	`last_event_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cameras_name_unique` ON `cameras` (`name`);--> statement-breakpoint
CREATE TABLE `media_cleanup` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stream_name` text NOT NULL,
	`created_at` text NOT NULL
);
