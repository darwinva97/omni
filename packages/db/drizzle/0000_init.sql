CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'agent' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_member" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_member_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "org" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app_session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"active_org_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_state" (
	"line_id" text PRIMARY KEY NOT NULL,
	"sealed" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat" (
	"id" text PRIMARY KEY NOT NULL,
	"line_id" text NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"last_message_at" timestamp with time zone,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"mute_until" timestamp with time zone,
	"ephemeral_seconds" integer
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" text PRIMARY KEY NOT NULL,
	"line_id" text NOT NULL,
	"address" text NOT NULL,
	"push_name" text,
	"saved_name" text,
	"blocked" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_map" (
	"line_id" text NOT NULL,
	"lid" text NOT NULL,
	"phone" text NOT NULL,
	"source" text DEFAULT 'server' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_map_line_id_lid_pk" PRIMARY KEY("line_id","lid")
);
--> statement-breakpoint
CREATE TABLE "line_member" (
	"line_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "line_member_line_id_user_id_pk" PRIMARY KEY("line_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "line" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"channel_kind" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"address" text,
	"driver_config" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"status_at" timestamp with time zone DEFAULT now() NOT NULL,
	"send_rate_per_minute" integer DEFAULT 12 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_receipt" (
	"line_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"participant" text NOT NULL,
	"state" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_receipt_line_id_provider_message_id_participant_pk" PRIMARY KEY("line_id","provider_message_id","participant")
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"line_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"provider_message_id" text,
	"client_message_id" text,
	"sender_address" text NOT NULL,
	"from_me" boolean NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"body" text,
	"raw" jsonb,
	"state" text DEFAULT 'queued' NOT NULL,
	"reply_to_id" text,
	"mentions" jsonb,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"media_key" text,
	"media_mime" text,
	"media_size" integer,
	"media_file_name" text,
	"media_meta" jsonb,
	"media_retain_until" timestamp with time zone,
	"sent_from_platform" boolean DEFAULT false NOT NULL,
	"sent_by_user_id" text,
	"sent_by_connector_id" text,
	"failure_reason" text,
	CONSTRAINT "message_id_timestamp_pk" PRIMARY KEY("id","timestamp")
) PARTITION BY RANGE ("timestamp");
--> statement-breakpoint
-- Partición por defecto: recoge lo que caiga fuera de los rangos mensuales, para
-- que un mensaje con fecha rara nunca provoque un fallo de inserción.
CREATE TABLE IF NOT EXISTS "message_default" PARTITION OF "message" DEFAULT;
--> statement-breakpoint
CREATE TABLE "poll" (
	"id" text PRIMARY KEY NOT NULL,
	"line_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"allow_multiple" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_vote" (
	"poll_id" text NOT NULL,
	"voter" text NOT NULL,
	"selected" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_vote_poll_id_voter_pk" PRIMARY KEY("poll_id","voter")
);
--> statement-breakpoint
CREATE TABLE "reaction" (
	"line_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"reactor" text NOT NULL,
	"emoji" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reaction_line_id_provider_message_id_reactor_pk" PRIMARY KEY("line_id","provider_message_id","reactor")
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"connector_id" text,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"role" text DEFAULT 'operator' NOT NULL,
	"allowed_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_chats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_cidrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rate_limit_per_minute" integer,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"org_id" text NOT NULL,
	"line_id" text,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"response_body" text,
	"error" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoint" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"connector_id" text,
	"line_id" text,
	"url" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret" text NOT NULL,
	"hmac_enabled" boolean DEFAULT true NOT NULL,
	"headers" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"filter" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_log" (
	"id" text PRIMARY KEY NOT NULL,
	"line_id" text NOT NULL,
	"call_id" text NOT NULL,
	"from_address" text NOT NULL,
	"is_video" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_info" (
	"line_id" text NOT NULL,
	"address" text NOT NULL,
	"subject" text NOT NULL,
	"description" text,
	"owner" text,
	"announce_only" boolean DEFAULT false NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_info_line_id_address_pk" PRIMARY KEY("line_id","address")
);
--> statement-breakpoint
CREATE TABLE "group_participant" (
	"line_id" text NOT NULL,
	"group_address" text NOT NULL,
	"participant" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	CONSTRAINT "group_participant_line_id_group_address_participant_pk" PRIMARY KEY("line_id","group_address","participant")
);
--> statement-breakpoint
CREATE TABLE "label_assignment" (
	"label_id" text NOT NULL,
	"line_id" text NOT NULL,
	"target" text NOT NULL,
	"target_kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_assignment_label_id_target_pk" PRIMARY KEY("label_id","target")
);
--> statement-breakpoint
CREATE TABLE "label" (
	"id" text PRIMARY KEY NOT NULL,
	"line_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"actor_user_id" text,
	"actor_api_key_id" text,
	"action" text NOT NULL,
	"target_kind" text,
	"target_id" text,
	"metadata" jsonb,
	"ip" text,
	"user_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_entitlement" (
	"org_id" text NOT NULL,
	"metric" text NOT NULL,
	"limit_value" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_entitlement_org_id_metric_pk" PRIMARY KEY("org_id","metric")
);
--> statement-breakpoint
CREATE TABLE "usage_counter" (
	"org_id" text NOT NULL,
	"metric" text NOT NULL,
	"period" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counter_org_id_metric_period_pk" PRIMARY KEY("org_id","metric","period")
);
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_app_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member" ADD CONSTRAINT "org_member_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member" ADD CONSTRAINT "org_member_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_session" ADD CONSTRAINT "app_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_session" ADD CONSTRAINT "app_session_active_org_id_org_id_fk" FOREIGN KEY ("active_org_id") REFERENCES "public"."org"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_state" ADD CONSTRAINT "auth_state_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_map" ADD CONSTRAINT "identity_map_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_member" ADD CONSTRAINT "line_member_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_member" ADD CONSTRAINT "line_member_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line" ADD CONSTRAINT "line_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipt" ADD CONSTRAINT "message_receipt_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_sent_by_user_id_app_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll" ADD CONSTRAINT "poll_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_poll_id_poll_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."poll"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction" ADD CONSTRAINT "reaction_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_connector_id_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector" ADD CONSTRAINT "connector_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_webhook_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_connector_id_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_log" ADD CONSTRAINT "call_log_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_info" ADD CONSTRAINT "group_info_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_assignment" ADD CONSTRAINT "label_assignment_label_id_label_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."label"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label" ADD CONSTRAINT "label_line_id_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_entitlement" ADD CONSTRAINT "org_entitlement_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counter" ADD CONSTRAINT "usage_counter_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitation_org_idx" ON "invitation" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_token_idx" ON "invitation" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "org_member_user_idx" ON "org_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_session_user_idx" ON "app_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_session_expiry_idx" ON "app_session" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_idx" ON "app_user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_line_address_idx" ON "chat" USING btree ("line_id","address");--> statement-breakpoint
CREATE INDEX "chat_recent_idx" ON "chat" USING btree ("line_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_line_address_idx" ON "contact" USING btree ("line_id","address");--> statement-breakpoint
CREATE INDEX "identity_map_phone_idx" ON "identity_map" USING btree ("line_id","phone");--> statement-breakpoint
CREATE INDEX "line_member_user_idx" ON "line_member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "line_org_slug_idx" ON "line" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "line_org_idx" ON "line" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "message_chat_idx" ON "message" USING btree ("line_id","chat_id","timestamp" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "message_provider_idx" ON "message" USING btree ("line_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "message_client_idx" ON "message" USING btree ("line_id","client_message_id");--> statement-breakpoint
CREATE INDEX "message_state_idx" ON "message" USING btree ("line_id","state");--> statement-breakpoint
CREATE INDEX "poll_line_msg_idx" ON "poll" USING btree ("line_id","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_prefix_idx" ON "api_key" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_key_org_idx" ON "api_key" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_org_slug_idx" ON "connector" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "webhook_delivery_endpoint_idx" ON "webhook_delivery" USING btree ("endpoint_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_delivery_status_idx" ON "webhook_delivery" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_endpoint_org_idx" ON "webhook_endpoint" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoint_line_idx" ON "webhook_endpoint" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX "call_log_line_idx" ON "call_log" USING btree ("line_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "group_participant_lookup_idx" ON "group_participant" USING btree ("line_id","participant");--> statement-breakpoint
CREATE INDEX "label_assignment_target_idx" ON "label_assignment" USING btree ("line_id","target");--> statement-breakpoint
CREATE INDEX "label_line_idx" ON "label" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX "audit_event_org_idx" ON "audit_event" USING btree ("org_id","at" DESC NULLS LAST);