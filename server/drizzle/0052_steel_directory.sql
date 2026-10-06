CREATE TABLE "directory_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"snapshot_id" text,
	"source_url" text,
	"evidence_quote" text NOT NULL,
	"evidence_locator" text,
	"extraction_method" text DEFAULT 'model' NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_agent" text,
	"created_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"short_name" text,
	"credit_code" text,
	"region" text,
	"entry_type" text DEFAULT 'unknown' NOT NULL,
	"website" text,
	"address" text,
	"legal_representative" text,
	"status" text DEFAULT 'candidate' NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"review_status" text DEFAULT 'unreviewed' NOT NULL,
	"merged_into_entry_id" text,
	"last_verified_at" timestamp with time zone,
	"last_verified_by_agent" text,
	"created_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_phone_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"phone" text NOT NULL,
	"phone_normalized" text NOT NULL,
	"phone_type" text DEFAULT 'unknown' NOT NULL,
	"label" text,
	"snapshot_id" text,
	"source_url" text,
	"evidence_quote" text NOT NULL,
	"evidence_locator" text,
	"extraction_method" text DEFAULT 'model' NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_review_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"queue_id" text,
	"decided_by" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_review_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"reason" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"queued_by_agent" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"http_status" integer,
	"content_fingerprint" text NOT NULL,
	"title" text,
	"excerpt" text,
	"blocked_reason" text,
	"captured_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"host" text NOT NULL,
	"kind" text NOT NULL,
	"access_status" text DEFAULT 'unknown' NOT NULL,
	"blocked_reason" text,
	"blocked_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"notes" text,
	"registered_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "directory_claims_entry_idx" ON "directory_claims" USING btree ("entry_id","field");--> statement-breakpoint
CREATE INDEX "directory_claims_snapshot_idx" ON "directory_claims" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "directory_claims_unverified_idx" ON "directory_claims" USING btree ("verified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_entries_credit_code_key" ON "directory_entries" USING btree ("credit_code") WHERE credit_code is not null;--> statement-breakpoint
CREATE INDEX "directory_entries_name_idx" ON "directory_entries" USING btree ("name_normalized");--> statement-breakpoint
CREATE INDEX "directory_entries_region_idx" ON "directory_entries" USING btree ("region");--> statement-breakpoint
CREATE INDEX "directory_entries_review_idx" ON "directory_entries" USING btree ("review_status","status");--> statement-breakpoint
CREATE INDEX "directory_entries_merged_idx" ON "directory_entries" USING btree ("merged_into_entry_id");--> statement-breakpoint
CREATE INDEX "directory_phone_claims_entry_idx" ON "directory_phone_claims" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "directory_phone_claims_phone_idx" ON "directory_phone_claims" USING btree ("phone_normalized");--> statement-breakpoint
CREATE INDEX "directory_phone_claims_review_idx" ON "directory_phone_claims" USING btree ("review_status","created_at");--> statement-breakpoint
CREATE INDEX "directory_review_decisions_subject_idx" ON "directory_review_decisions" USING btree ("subject_type","subject_id","decided_at");--> statement-breakpoint
CREATE INDEX "directory_review_decisions_decided_by_idx" ON "directory_review_decisions" USING btree ("decided_by");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_review_queue_pending_key" ON "directory_review_queue" USING btree ("subject_type","subject_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "directory_review_queue_pending_idx" ON "directory_review_queue" USING btree ("status","priority","queued_at");--> statement-breakpoint
CREATE INDEX "directory_snapshots_source_idx" ON "directory_snapshots" USING btree ("source_id","fetched_at");--> statement-breakpoint
CREATE INDEX "directory_snapshots_fingerprint_idx" ON "directory_snapshots" USING btree ("content_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_snapshots_url_fingerprint_key" ON "directory_snapshots" USING btree ("url","content_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_sources_url_key" ON "directory_sources" USING btree ("url");--> statement-breakpoint
CREATE INDEX "directory_sources_host_idx" ON "directory_sources" USING btree ("host");--> statement-breakpoint
CREATE INDEX "directory_sources_access_idx" ON "directory_sources" USING btree ("access_status","last_checked_at");