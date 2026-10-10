-- AlterEnum
-- The new enum value is added in its own migration so it is committed before
-- the phase10 migration uses 'AI' (PostgreSQL refuses to use a value added in
-- the same transaction).
ALTER TYPE "MessageSender" ADD VALUE IF NOT EXISTS 'AI';
