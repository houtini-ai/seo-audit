#!/usr/bin/env node
/**
 * build-mcpb.mjs — stage + pack the Claude Desktop extension bundle (.mcpb).
 *
 * Usage:  npm run build:mcpb        (runs npm run build first via the script chain)
 * Output: mcpb-dist/seo-audit-console.mcpb   (mcpb-dist/ is gitignored)
 *
 * What it does, reproducibly:
 *   1. wipes mcpb-dist/.staging and copies manifest (mcpb/manifest.json → manifest.json),
 *      dist/, package.json, package-lock.json, README.md, LICENSE into it
 *   2. runs `npm ci --omit=dev` in the staging dir (production node_modules only;
 *      install scripts DO run — better-sqlite3/onnxruntime need their prebuilds)
 *   3. runs `npx @anthropic-ai/mcpb pack` on the staging dir
 *
 * Notes / constraints (researched 2026-08-03, mcpb CLI 2.1.2, manifest_version 0.3):
 *   - Native deps (better-sqlite3 prebuild, onnxruntime-node) make the bundle
 *     platform-specific to the machine that builds it; manifest declares
 *     compatibility.platforms accordingly (win32 when built here).
 *   - @huggingface/transformers + onnxruntime dominate the size. The ONNX model
 *     itself is NOT bundled — it downloads on first `score_passages` run.
 *
 * DIRECTORY SUBMISSION CHECKLIST (Claude connectors directory, desktop extensions):
 *   Docs:   https://claude.com/docs/connectors/building/submission
 *   Form:   https://clau.de/desktop-extention-submission   (desktop extensions use
 *           this form, NOT the claude.ai admin-settings portal — that's remote-only)
 *   Requirements found:
 *     [ ] Privacy policy: README.md must contain a "Privacy Policy" section AND
 *         manifest.json must carry a privacy_policies[] of HTTPS URLs
 *         (manifest_version 0.2+). Missing/incomplete = immediate rejection.
 *         (Ours points at README#privacy-and-data — retitle that section
 *         "Privacy Policy" and cover collection/usage/storage/third-party
 *         sharing/retention/contact before submitting.)
 *     [ ] Tool annotations: every tool needs a title and readOnlyHint or
 *         destructiveHint as applicable.
 *     [ ] Icon: not required by the MCPB spec to pack, but the submission form
 *         asks for one for the directory listing — prepare a real icon first.
 *     [ ] Documentation URL (we use manual/getting-started.md on GitHub) and
 *         support contact.
 *     [ ] Test-account credentials/instructions detailed enough for a reviewer
 *         (a GSC property the reviewer can access is the hard part here).
 *     [ ] Agree to Anthropic Software Directory Terms + Policy.
 *   Track status / reviewer feedback after submitting; escalations go to
 *   mcp-review@anthropic.com.
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'mcpb-dist');
const staging = join(outDir, '.staging');
const outFile = join(outDir, 'seo-audit-console.mcpb');

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

// 1. stage
if (!existsSync(join(root, 'dist', 'index.js'))) {
  console.error('dist/index.js missing — run `npm run build` first.');
  process.exit(1);
}
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(join(root, 'mcpb', 'manifest.json'), join(staging, 'manifest.json'));
cpSync(join(root, 'dist'), join(staging, 'dist'), { recursive: true });
// manifest.icon points at this filename at the bundle root — the directory listing uses it.
if (existsSync(join(root, 'assets', 'icon.png'))) cpSync(join(root, 'assets', 'icon.png'), join(staging, 'icon.png'));
for (const f of ['package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(staging, f));
}

// 2. production dependencies (reproducible via the lockfile)
console.error('Installing production dependencies in staging (npm ci --omit=dev)...');
run('npm ci --omit=dev --no-audit --no-fund', staging);

// 3. pack
rmSync(outFile, { force: true });
console.error('Packing with @anthropic-ai/mcpb...');
run(`npx --yes @anthropic-ai/mcpb pack "${staging}" "${outFile}"`, root);

const mb = (statSync(outFile).size / 1024 / 1024).toFixed(1);
console.error(`\nDone: ${outFile} (${mb} MB)`);
