CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"picture" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"github_profile" text,
	"linkedin_profile" text,
	"project_link" text,
	"project_description" text,
	"first_domain" text NOT NULL,
	"second_domain" text,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"management_question_id" integer NOT NULL,
	"management_question" text NOT NULL,
	"management_answer" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_reviews" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rating" integer,
	"remarks" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_type" text NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"applications_open" boolean DEFAULT true NOT NULL,
	"slot_booking_open" boolean DEFAULT true NOT NULL,
	"task_duration_hours" integer DEFAULT 48 NOT NULL,
	"meeting_link_lead_minutes" integer DEFAULT 30 NOT NULL,
	"results_published" boolean DEFAULT false NOT NULL,
	"announcement" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slot_interviewers" (
	"slot_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	CONSTRAINT "slot_interviewers_slot_id_admin_id_pk" PRIMARY KEY("slot_id","admin_id")
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 20 NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"booked_count" integer DEFAULT 0 NOT NULL,
	"domain" text,
	"meet_link" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slots_capacity_check" CHECK ("slots"."booked_count" >= 0 AND "slots"."booked_count" <= "slots"."capacity"),
	CONSTRAINT "slots_duration_check" CHECK ("slots"."duration_minutes" BETWEEN 5 AND 240)
);
--> statement-breakpoint
CREATE TABLE "task_assignments" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"domain" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"submission_link" text,
	"submission_notes" text,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"domain" text NOT NULL,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"assigned_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"reg_no" text,
	"picture" text,
	"slot_id" uuid,
	"booked_at" timestamp with time zone,
	"meeting_link_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_reviews" ADD CONSTRAINT "interview_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_reviews" ADD CONSTRAINT "interview_reviews_reviewed_by_admins_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_interviewers" ADD CONSTRAINT "slot_interviewers_slot_id_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_interviewers" ADD CONSTRAINT "slot_interviewers_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_created_by_admins_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_admins_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_slot_id_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."slots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_first_domain_idx" ON "applications" USING btree ("first_domain");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_type","account_id");--> statement-breakpoint
CREATE INDEX "slots_start_time_idx" ON "slots" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "tasks_domain_active_idx" ON "tasks" USING btree ("domain","is_active");--> statement-breakpoint
CREATE INDEX "users_slot_idx" ON "users" USING btree ("slot_id");