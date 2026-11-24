#!/usr/bin/env node
// Lightweight secret scan over git-tracked and untracked-but-not-ignored files.
// It is a safety net, not a replacement for review or a dedicated scanner.
// A line containing `secret-scan:allow` is ignored (for deliberate test fixtures only).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const listed = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);
const files = listed.split('\0').filter(Boolean);

const PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  [
    'Cloudflare/API token assignment',
    /\b(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN)\s*=\s*[A-Za-z0-9_-]{30,}/,
  ],
  ['service account JSON', /"type"\s*:\s*"service_account"/],
  [
    'generic secret assignment',
    /\b(?:secret|password|api[_-]?key|token)\b["']?\s*[:=]\s*["'][A-Za-z0-9+/_-]{24,}["']/i,
  ],
];
const SKIP = [
  /(^|\/)pnpm-lock\.yaml$/,
  /\.(png|jpe?g|gif|ico|woff2?|pdf)$/i,
  /(^|\/)scripts\/check-secrets\.mjs$/,
];

const findings = [];
for (const file of files) {
  if (SKIP.some((re) => re.test(file))) continue;
  if (
    /(^|\/)\.dev\.vars$/.test(file) ||
    (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith('.example'))
  ) {
    findings.push(`${file}: local secret file must not be committed`);
    continue;
  }
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    continue;
  }
  const scanned = text
    .split('\n')
    .filter((line) => !line.includes('secret-scan:allow'))
    .join('\n');
  for (const [label, re] of PATTERNS) {
    if (re.test(scanned)) findings.push(`${file}: possible ${label}`);
  }
}

if (findings.length > 0) {
  console.error('Secret scan FAILED:');
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} files checked).`);
