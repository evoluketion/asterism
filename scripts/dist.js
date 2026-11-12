'use strict';
// Packages the app. On an issue branch the build is labelled with the issue number, so it keeps
// its own settings and window and runs alongside the main build. ASTERISM_VARIANT overrides the
// label; set it empty for a plain build.

const path = require('path');
const { spawnSync } = require('child_process');
const { detectVariant } = require('../src/main/variant');

const platform = process.argv[2];
const target = { linux: 'AppImage', win: 'portable' }[platform];
if (!target) {
  console.error('usage: node scripts/dist.js linux|win');
  process.exit(2);
}

const root = path.join(__dirname, '..');
const variant = process.env.ASTERISM_VARIANT ?? detectVariant(root);
const args = ['electron-builder', `--${platform}`, target, '--publish', 'never'];
if (variant) {
  args.push(
    `-c.extraMetadata.asterismVariant=${variant}`,
    `-c.${platform}.artifactName=\${productName}-\${version}-issue-${variant}.\${ext}`,
  );
  console.log(`Building the issue #${variant} variant`);
}

const r = spawnSync('npx', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
