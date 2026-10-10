-- CreateEnum
CREATE TYPE "HandlingMode" AS ENUM ('AI', 'HANDOFF_PENDING', 'HUMAN');

-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- AlterEnum is intentionally split into the preceding migration so the new
-- 'AI' value is committed before it is referenced below.

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "handling" "HandlingMode" NOT NULL DEFAULT 'AI',
ADD COLUMN     "handoff_reason" TEXT,
ADD COLUMN     "handoff_requested_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "websites" ADD COLUMN     "ai_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ai_fallback_message" TEXT;

-- CreateTable
CREATE TABLE "faq_entries" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "faq_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_jobs" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "status" "AiJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "leased_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "reply_message_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "faq_entries_website_id_created_at_idx" ON "faq_entries"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_jobs_website_id_created_at_idx" ON "ai_jobs"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_jobs_status_available_at_idx" ON "ai_jobs"("status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_jobs_message_id_key" ON "ai_jobs"("message_id");

-- AddForeignKey
ALTER TABLE "faq_entries" ADD CONSTRAINT "faq_entries_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_conversation_id_website_id_fkey" FOREIGN KEY ("conversation_id", "website_id") REFERENCES "conversations"("id", "website_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Custom SQL (not expressible in the Prisma schema) -------------------------
-- AI replies, like SYSTEM messages, are authenticated system-generated
-- answers with no actor rows — they must never be mistaken for a human agent.
-- Extend the sender/reference CHECK constraint with the AI branch.
ALTER TABLE "messages" DROP CONSTRAINT "messages_sender_reference_check";
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_reference_check" CHECK (
    ("sender_type" = 'VISITOR' AND "visitor_id" IS NOT NULL AND "user_id" IS NULL)
    OR ("sender_type" = 'AGENT' AND "user_id" IS NOT NULL AND "visitor_id" IS NULL)
    OR ("sender_type" = 'SYSTEM' AND "visitor_id" IS NULL AND "user_id" IS NULL)
    OR ("sender_type" = 'AI' AND "visitor_id" IS NULL AND "user_id" IS NULL)
);
