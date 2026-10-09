'use strict';

const path = require('node:path');
const bcrypt = require('bcryptjs');
const { PrismaClient, Role } = require('@prisma/client');

// Load the monorepo-root .env (and an optional workspace-local .env) so the
// seed works whether it is invoked from the repo root or from apps/api.
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;

/**
 * Idempotent bootstrap for the first ADMIN. Public registration can only ever
 * create AGENTs, so this controlled mechanism is the only way to obtain an
 * administrator. Existing users are never modified (no silent password reset).
 */
async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Initial Admin';

  if (!email || !password) {
    console.log('[seed] ADMIN_EMAIL/ADMIN_PASSWORD not set; skipping admin bootstrap.');
    return;
  }

  if (!PASSWORD_PATTERN.test(password)) {
    throw new Error('ADMIN_PASSWORD must be 8-72 characters and contain a letter and a number.');
  }

  const rounds = Number(process.env.BCRYPT_ROUNDS || 12);
  const normalizedEmail = email.trim().toLowerCase();
  const prisma = new PrismaClient();

  try {
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      console.log(
        `[seed] User ${normalizedEmail} already exists (role=${existing.role}); leaving it unchanged.`,
      );
      return;
    }

    const passwordHash = await bcrypt.hash(password, rounds);
    await prisma.user.create({
      data: { email: normalizedEmail, name, role: Role.ADMIN, passwordHash },
    });
    console.log(`[seed] Created initial ADMIN account ${normalizedEmail}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[seed] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
