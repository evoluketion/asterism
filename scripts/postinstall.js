'use strict';
// node-pty ships N-API prebuilds for Windows and macOS, which work in Electron as-is, so only
// rebuild where there are none (Linux). This keeps `npm install` working on Windows without
// Visual Studio build tools.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const prebuilt = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`);
if (fs.existsSync(prebuilt)) {
  console.log(`[asterism] using node-pty prebuild for ${process.platform}-${process.arch}`);
} else {
  execSync('npx electron-rebuild -f -w node-pty', { stdio: 'inherit' });
}
