CREATE TABLE "inbound_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "contact_request_id" UUID,
  "demo_request_id" UUID,
  "author_id" UUID,
  "kind" TEXT NOT NULL,
  "body" VARCHAR(10000) NOT NULL,
  "delivery_status" TEXT,
  "sent_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inbound_messages_one_request" CHECK (num_nonnulls(contact_request_id, demo_request_id) = 1),
  CONSTRAINT "inbound_messages_kind" CHECK (
    (kind = 'note' AND delivery_status IS NULL AND sent_at IS NULL) OR
    (kind = 'reply' AND delivery_status IS NOT NULL AND delivery_status IN ('pending', 'sent', 'failed'))
  ),
  CONSTRAINT "inbound_messages_contact_fkey" FOREIGN KEY ("contact_request_id") REFERENCES "contact_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inbound_messages_demo_fkey" FOREIGN KEY ("demo_request_id") REFERENCES "demo_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inbound_messages_author_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "inbound_messages_contact_request_id_created_at_idx" ON "inbound_messages"("contact_request_id", "created_at");
CREATE INDEX "inbound_messages_demo_request_id_created_at_idx" ON "inbound_messages"("demo_request_id", "created_at");
CREATE INDEX "inbound_messages_author_id_idx" ON "inbound_messages"("author_id");
