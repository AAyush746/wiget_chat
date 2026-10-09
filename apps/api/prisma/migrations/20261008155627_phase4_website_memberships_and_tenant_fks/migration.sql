-- DropForeignKey
ALTER TABLE "conversation_events" DROP CONSTRAINT "conversation_events_conversation_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_events" DROP CONSTRAINT "conversation_events_website_id_fkey";

-- DropForeignKey
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_visitor_id_fkey";

-- DropForeignKey
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_website_id_fkey";

-- CreateTable
CREATE TABLE "website_memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "website_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "website_memberships_website_id_idx" ON "website_memberships"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "website_memberships_user_id_website_id_key" ON "website_memberships"("user_id", "website_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_id_website_id_key" ON "conversations"("id", "website_id");

-- CreateIndex
CREATE UNIQUE INDEX "visitors_id_website_id_key" ON "visitors"("id", "website_id");

-- AddForeignKey
ALTER TABLE "website_memberships" ADD CONSTRAINT "website_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_memberships" ADD CONSTRAINT "website_memberships_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_visitor_id_website_id_fkey" FOREIGN KEY ("visitor_id", "website_id") REFERENCES "visitors"("id", "website_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversation_id_website_id_fkey" FOREIGN KEY ("conversation_id", "website_id") REFERENCES "conversations"("id", "website_id") ON DELETE CASCADE ON UPDATE CASCADE;

