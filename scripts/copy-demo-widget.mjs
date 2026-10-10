/**
 * Copies the built widget bundle into the demo storefront's `public/` folder.
 *
 * The demo storefront serves the widget as a static asset from
 * `apps/demo/public/widget.js`, which is deliberately git-ignored (it is a
 * build artifact, not source). Without this step a fresh clone starts the
 * storefront with no chat bubble and no obvious cause, so the copy is wired
 * into `npm run demo:storefront` instead of being a manual chore.
 *
 * Run automatically; also safe to invoke directly:
 *   node scripts/copy-demo-widget.js
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'apps/widget/dist/widget.js');
const targetDir = resolve(root, 'apps/demo/public');
const target = resolve(targetDir, 'widget.js');

if (!existsSync(source)) {
  console.error(
    `Widget bundle not found at ${source}.\n` +
      `Build it first:  npm run build -w @chatflow/widget`,
  );
  process.exit(1);
}

try {
  mkdirSync(targetDir, { recursive: true });
} catch {
  // Already exists — nothing to do.
}

copyFileSync(source, target);
console.log(`demo widget updated -> ${target}`);
