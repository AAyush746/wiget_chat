import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

/**
 * Runs every e2e suite against a dedicated Postgres schema instead of the
 * shared `public` schema that the dev server and demo/seed tooling write into.
 *
 * This isolates test data from developer data (e.g. `Demo Store` websites
 * created by `npm run demo`) without deleting it or softening assertions:
 * `globalSetup` drops + recreates the `e2e` schema, applies migrations, then
 * points `DATABASE_URL` at that schema for the whole jest run. `PrismaService`
 * reads `DATABASE_URL` through Nest `ConfigService`, which honors existing
 * process.env values over the `.env` file, so every app under test inherits it.
 *
 * The schema is dropped again in `global-teardown.ts`, leaving no residue.
 */

export const E2E_SCHEMA = 'e2e';

const API_DIR = __dirname;
const ROOT_DIR = resolve(API_DIR, '../../..');
const PRISMA_BIN = resolve(ROOT_DIR, 'node_modules/.bin/prisma');
const SCHEMA_PATH = resolve(API_DIR, '../prisma/schema.prisma');

function baseDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  loadEnv({ path: resolve(ROOT_DIR, '.env') });
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required (set it or add it to the root .env)');
  }
  return url;
}

/** The same URL with the `schema` query parameter pinned to the e2e schema. */
export function e2eDatabaseUrl(base = baseDatabaseUrl()): string {
  const url = new URL(base);
  url.searchParams.set('schema', E2E_SCHEMA);
  return url.toString();
}

async function main(): Promise<void> {
  const baseUrl = baseDatabaseUrl();
  const testUrl = e2eDatabaseUrl(baseUrl);

  // Reset the e2e schema. Connect on the public-schema URL (always present);
  // the flagged user in this stack is the database owner, so it may drop schemas.
  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${E2E_SCHEMA}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${E2E_SCHEMA}"`);
  } finally {
    await admin.$disconnect();
  }

  // Apply every committed migration to the fresh e2e schema.
  execSync(`"${PRISMA_BIN}" migrate deploy --schema "${SCHEMA_PATH}"`, {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'inherit',
  });

  // Make the whole run (and every app under test) use the e2e schema.
  process.env.DATABASE_URL = testUrl;
}

export default main;
