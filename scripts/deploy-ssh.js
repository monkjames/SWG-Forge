#!/usr/bin/env node
/**
 * Deploy extensions to VSCode SSH Remote.
 *
 * Installs all VSIX files from dist/ into the SSH remote extensions directory.
 * After running, reload the VSCode window (Ctrl+Shift+P -> "Reload Window").
 *
 * Usage:
 *   node scripts/deploy-ssh.js                # Deploy all
 *   node scripts/deploy-ssh.js stf-editor     # Deploy one
 *   node scripts/deploy-ssh.js --build        # Build + deploy all
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PACKAGES = path.join(ROOT, 'packages');

// Parse args
const args = process.argv.slice(2);
const shouldBuild = args.includes('--build');
const targets = args.filter(a => !a.startsWith('--'));

// Build first if requested
if (shouldBuild) {
    console.log('=== Building all extensions ===\n');
    const buildArgs = targets.length > 0 ? targets.join(' ') : '';
    execSync(`node scripts/build-all.js ${buildArgs}`, { cwd: ROOT, stdio: 'inherit' });
    console.log('');
}

// Find VSIX files
if (!fs.existsSync(DIST)) {
    console.error('No dist/ directory. Run "npm run build" first.');
    process.exit(1);
}

let vsixFiles = fs.readdirSync(DIST).filter(f => f.endsWith('.vsix'));

// Filter to targets if specified
if (targets.length > 0) {
    vsixFiles = vsixFiles.filter(f => targets.some(t => f.includes(t)));
}

if (vsixFiles.length === 0) {
    console.error('No VSIX files found in dist/');
    process.exit(1);
}

console.log(`=== Deploying ${vsixFiles.length} extensions ===\n`);

let installed = 0;
let failed = 0;

for (const vsix of vsixFiles) {
    const vsixPath = path.join(DIST, vsix);
    console.log(`Installing ${vsix}...`);

    try {
        execSync(`code --install-extension "${vsixPath}" --force 2>&1`, {
            stdio: 'pipe',
            timeout: 30000
        });
        console.log(`  OK`);
        installed++;
    } catch (err) {
        // code CLI may not work over SSH - fall back to manual install
        console.log('  code CLI failed, trying manual install...');
        try {
            manualInstall(vsixPath);
            console.log('  OK (manual)');
            installed++;
        } catch (err2) {
            console.error(`  FAILED: ${err2.message}`);
            failed++;
        }
    }
}

console.log(`\n=== Done: ${installed} installed, ${failed} failed ===`);
if (installed > 0) {
    console.log('\nReload VSCode window to activate: Ctrl+Shift+P -> "Reload Window"');
}
if (failed > 0) process.exit(1);

function manualInstall(vsixPath) {
    // Find the vscode-server extensions directory
    const home = process.env.HOME || '/home/' + process.env.USER;
    const extDirs = [
        path.join(home, '.vscode-server', 'extensions'),
        path.join(home, '.vscode-server-insiders', 'extensions'),
    ];

    let extDir = extDirs.find(d => fs.existsSync(d));
    if (!extDir) {
        throw new Error('Cannot find VSCode server extensions directory');
    }

    // Extract VSIX (it's a zip)
    const tmpDir = path.join(ROOT, '.deploy-tmp');
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });

    execSync(`unzip -q -o "${vsixPath}" -d "${tmpDir}"`, { stdio: 'pipe' });

    // Read package.json from extracted extension
    const pkgJsonPath = path.join(tmpDir, 'extension', 'package.json');
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const publisher = pkgJson.publisher || 'swgemu';
    const name = pkgJson.name;
    const version = pkgJson.version;

    const installDir = path.join(extDir, `${publisher}.${name}-${version}`);

    // Remove old version if exists
    const oldVersions = fs.readdirSync(extDir)
        .filter(d => d.startsWith(`${publisher}.${name}-`));
    for (const old of oldVersions) {
        const oldPath = path.join(extDir, old);
        console.log(`  Removing old: ${old}`);
        fs.rmSync(oldPath, { recursive: true });
    }

    // Copy extension/ to install directory
    fs.mkdirSync(installDir, { recursive: true });
    execSync(`cp -r "${path.join(tmpDir, 'extension')}"/* "${installDir}"/`, { stdio: 'pipe' });

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
}
