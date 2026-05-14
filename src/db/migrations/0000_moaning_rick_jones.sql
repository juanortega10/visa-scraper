CREATE TYPE "public"."billing_mode" AS ENUM('free', 'paid');--> statement-breakpoint
CREATE TYPE "public"."bot_status" AS ENUM('created', 'login_required', 'active', 'paused', 'error', 'invalid_credentials');--> statement-breakpoint
CREATE TYPE "public"."credential_attempt_status" AS ENUM('pending', 'discovering', 'ready', 'failed', 'used');--> statement-breakpoint
CREATE TYPE "public"."proxy_provider" AS ENUM('direct', 'brightdata', 'firecrawl', 'webshare');--> statement-breakpoint
CREATE TABLE "agencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"clerk_user_id" varchar(50) NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text,
	"billing_mode" "billing_mode" DEFAULT 'free' NOT NULL,
	"max_bots" integer DEFAULT 5 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"action" varchar(30) NOT NULL,
	"locale" varchar(10),
	"result" varchar(20) NOT NULL,
	"error_message" text,
	"password_encrypted" text,
	"clerk_user_id" varchar(50),
	"ip" varchar(45),
	"bot_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ban_episodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"duration_min" integer,
	"classification" varchar(20) NOT NULL,
	"poll_count" integer DEFAULT 1 NOT NULL,
	"poll_details" jsonb DEFAULT '[]'::jsonb,
	"trigger_context" jsonb,
	"recovery_context" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookable_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"date" date NOT NULL,
	"outcome" varchar(30) NOT NULL,
	"consular_date_at_detection" date,
	"days_improvement" integer,
	"locale" varchar(10),
	"detected_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_credential_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"agency_id" integer NOT NULL,
	"visa_email" text NOT NULL,
	"visa_password" text NOT NULL,
	"country" varchar(2) NOT NULL,
	"locale" varchar(10),
	"status" "credential_attempt_status" DEFAULT 'pending' NOT NULL,
	"discovery_token" varchar(64),
	"discovered_data" jsonb,
	"last_error" text,
	"last_attempt_at" timestamp,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"bot_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" serial PRIMARY KEY NOT NULL,
	"visa_email" text NOT NULL,
	"visa_password" text NOT NULL,
	"schedule_id" varchar(20) NOT NULL,
	"applicant_ids" jsonb NOT NULL,
	"consular_facility_id" varchar(10) DEFAULT '25' NOT NULL,
	"asc_facility_id" varchar(10) DEFAULT '26' NOT NULL,
	"locale" varchar(10) DEFAULT 'es-co' NOT NULL,
	"current_consular_date" date,
	"current_consular_time" varchar(5),
	"current_cas_date" date,
	"current_cas_time" varchar(5),
	"status" "bot_status" DEFAULT 'created' NOT NULL,
	"proxy_provider" "proxy_provider" DEFAULT 'direct' NOT NULL,
	"proxy_urls" jsonb,
	"user_id" varchar(20),
	"active_run_id" varchar(50),
	"active_cloud_run_id" varchar(50),
	"poll_environments" jsonb DEFAULT '["dev"]'::jsonb,
	"cloud_enabled" boolean DEFAULT false NOT NULL,
	"clerk_user_id" varchar(50),
	"cas_cache_json" jsonb,
	"target_date_before" date,
	"max_reschedules" integer,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"max_cas_gap_days" integer,
	"skip_cas" boolean DEFAULT false NOT NULL,
	"speculative_time_fallback" boolean DEFAULT false NOT NULL,
	"min_days_from_today" integer,
	"poll_interval_seconds" integer,
	"target_polls_per_min" integer,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"webhook_url" text,
	"notification_email" text,
	"owner_email" text,
	"notification_phone" text,
	"visa_category" varchar(20),
	"visa_type_raw" text,
	"visa_class_id" integer,
	"applicant_visa_types" jsonb,
	"activated_at" timestamp,
	"agency_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_prefetch_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"total_dates" integer NOT NULL,
	"full_dates" integer NOT NULL,
	"low_dates" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"request_count" integer NOT NULL,
	"changes_json" jsonb,
	"reliability_json" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "date_sightings" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"date" date NOT NULL,
	"appeared_at" timestamp DEFAULT now() NOT NULL,
	"disappeared_at" timestamp,
	"duration_ms" integer,
	"days_from_now" integer
);
--> statement-breakpoint
CREATE TABLE "dispatch_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"scout_bot_id" integer NOT NULL,
	"facility_id" varchar(10) NOT NULL,
	"available_dates" jsonb,
	"subscribers_considered" integer NOT NULL,
	"subscribers_attempted" integer NOT NULL,
	"subscribers_succeeded" integer NOT NULL,
	"subscribers_failed" integer NOT NULL,
	"subscribers_skipped" integer NOT NULL,
	"details" jsonb,
	"duration_ms" integer,
	"poll_log_id" integer,
	"run_id" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "excluded_dates" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "excluded_times" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"date" date,
	"time_start" varchar(5) NOT NULL,
	"time_end" varchar(5) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"event" varchar(50) NOT NULL,
	"channel" varchar(10) NOT NULL,
	"recipient" text NOT NULL,
	"status" varchar(10) NOT NULL,
	"external_id" varchar(100),
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"earliest_date" date,
	"dates_count" integer,
	"response_time_ms" integer,
	"top_dates" jsonb,
	"raw_dates_count" integer,
	"provider" varchar(15),
	"relogin_happened" boolean,
	"phase_timings" jsonb,
	"status" varchar(30) NOT NULL,
	"reschedule_result" varchar(30),
	"reschedule_details" jsonb,
	"all_dates" jsonb,
	"chain_id" varchar(10),
	"poll_phase" varchar(20),
	"fetch_index" integer,
	"run_id" varchar(50),
	"public_ip" varchar(45),
	"date_changes" jsonb,
	"error" text,
	"ban_phase" varchar(15),
	"connection_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reschedule_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"old_consular_date" date,
	"old_consular_time" varchar(5),
	"old_cas_date" date,
	"old_cas_time" varchar(5),
	"new_consular_date" date,
	"new_consular_time" varchar(5),
	"new_cas_date" date,
	"new_cas_time" varchar(5),
	"success" boolean NOT NULL,
	"dispatch_log_id" integer,
	"error" text,
	"run_id" varchar(100),
	"provider" varchar(20),
	"session_age_ms" integer,
	"fail_step" varchar(50),
	"fail_reason" varchar(50),
	"duration_ms" integer,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"yatri_cookie" text NOT NULL,
	"csrf_token" text,
	"authenticity_token" text,
	"last_used_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ban_episodes" ADD CONSTRAINT "ban_episodes_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookable_events" ADD CONSTRAINT "bookable_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cas_prefetch_logs" ADD CONSTRAINT "cas_prefetch_logs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_sightings" ADD CONSTRAINT "date_sightings_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excluded_dates" ADD CONSTRAINT "excluded_dates_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excluded_times" ADD CONSTRAINT "excluded_times_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_logs" ADD CONSTRAINT "poll_logs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_logs" ADD CONSTRAINT "reschedule_logs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agencies_clerk_idx" ON "agencies" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "auth_logs_created_idx" ON "auth_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ban_episodes_bot_started_idx" ON "ban_episodes" USING btree ("bot_id","started_at");--> statement-breakpoint
CREATE INDEX "ban_episodes_open_idx" ON "ban_episodes" USING btree ("bot_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX "bookable_events_bot_det_idx" ON "bookable_events" USING btree ("bot_id","detected_at");--> statement-breakpoint
CREATE INDEX "bookable_events_date_idx" ON "bookable_events" USING btree ("date");--> statement-breakpoint
CREATE INDEX "credential_attempts_agency_idx" ON "bot_credential_attempts" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "credential_attempts_status_idx" ON "bot_credential_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bots_status_idx" ON "bots" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bots_schedule_idx" ON "bots" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "bots_agency_idx" ON "bots" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "cas_prefetch_logs_bot_idx" ON "cas_prefetch_logs" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "ds_bot_appeared_idx" ON "date_sightings" USING btree ("bot_id","appeared_at");--> statement-breakpoint
CREATE INDEX "ds_bot_date_idx" ON "date_sightings" USING btree ("bot_id","date");--> statement-breakpoint
CREATE INDEX "dispatch_logs_scout_idx" ON "dispatch_logs" USING btree ("scout_bot_id");--> statement-breakpoint
CREATE INDEX "dispatch_logs_created_idx" ON "dispatch_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "excluded_dates_bot_idx" ON "excluded_dates" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "excluded_times_bot_idx" ON "excluded_times" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "notification_logs_bot_idx" ON "notification_logs" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "notification_logs_created_idx" ON "notification_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "poll_logs_bot_created_idx" ON "poll_logs" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "reschedule_logs_bot_idx" ON "reschedule_logs" USING btree ("bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_bot_idx" ON "sessions" USING btree ("bot_id");