#!/usr/bin/env node
/**
 * Clean build artifacts from all packages.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGES = path.join(ROOT, 'packages');
const DIST = path.join(ROOT, 'dist');

const dirs = fs.readdirSync(PACKAGES).filter(d =>
    fs.statSync(path.join(PACKAGES, d)).isDirectory()
);

let cleaned = 0;

for (const dir of dirs) {
    const outDir = path.join(PACKAGES, dir, 'out');
    if (fs.existsSync(outDir)) {
        fs.rmSync(outDir, { recursive: true });
        console.log(`Cleaned ${dir}/out`);
        cleaned++;
    }
}

if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true });
    console.log('Cleaned dist/');
    cleaned++;
}

const vsixTmp = path.join(ROOT, '.vsix-tmp');
if (fs.existsSync(vsixTmp)) {
    fs.rmSync(vsixTmp, { recursive: true });
    console.log('Cleaned .vsix-tmp/');
    cleaned++;
}

console.log(`Done: ${cleaned} directories cleaned.`);
