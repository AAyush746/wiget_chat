-- AlterTable: optional client-generated idempotency key for message sends
ALTER TABLE "messages" ADD COLUMN "client_message_id" UUID;

-- CreateIndex: retried sends with the same key must collide, not duplicate.
-- Postgres treats NULLs as distinct, so messages without a key are unaffected.
CREATE UNIQUE INDEX "messages_conversation_id_client_message_id_key" ON "messages"("conversation_id", "client_message_id");
