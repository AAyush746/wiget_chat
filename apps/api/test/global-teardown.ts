import { PrismaClient } from '@prisma/client';
import { E2E_SCHEMA, e2eDatabaseUrl } from './global-setup';

/**
 * Drop the dedicated e2e schema so no test residue survives across runs.
 * Failures here must never fail the suite, so everything is guarded.
 */
async function teardown(): Promise<void> {
  const admin = new PrismaClient({ datasourceUrl: e2eDatabaseUrl() });
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${E2E_SCHEMA}" CASCADE`);
  } catch {
    // Best-effort cleanup only.
  } finally {
    await admin.$disconnect();
  }
}

export default teardown;
