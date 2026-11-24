#!/usr/bin/env node
// Refuses to deploy/migrate staging or production while wrangler.jsonc still has placeholders.
// Usage: node scripts/check-deploy-config.mjs <staging|production>
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (target !== 'staging' && target !== 'production') {
  console.error('Usage: check-deploy-config.mjs <staging|production>');
  process.exit(2);
}

const path = join(dirname(fileURLToPath(import.meta.url)), '../apps/api/wrangler.jsonc');
// Comments in wrangler.jsonc are whole-line only (documented there), so this is safe.
const text = readFileSync(path, 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
// Tolerate trailing commas (valid JSONC) before parsing.
const config = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
const env = config.env?.[target];
const problems = [];
if (!env) problems.push(`No "${target}" environment in wrangler.jsonc`);
else {
  const blob = JSON.stringify(env);
  for (const match of blob.matchAll(/REPLACE_WITH_[A-Z0-9_]+/g))
    problems.push(`Placeholder still present: ${match[0]}`);
  for (const db of env.d1_databases ?? []) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(db.database_id)) {
      problems.push(`d1 database_id for ${db.binding} is not a UUID`);
    }
  }
  if (env.vars?.ENVIRONMENT !== target) problems.push(`vars.ENVIRONMENT must be "${target}"`);
  if (target === 'production' && env.vars?.EMAIL_PROVIDER === 'mock')
    problems.push('EMAIL_PROVIDER must not be "mock" in production');
  if (target === 'production' && env.vars?.DRIVE_PROVIDER === 'mock')
    problems.push('DRIVE_PROVIDER must not be "mock" in production');
}
if (problems.length > 0) {
  console.error(`Deploy config check FAILED for ${target}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Deploy config check passed for ${target}.`);
