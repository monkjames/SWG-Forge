#!/usr/bin/env node
/**
 * Build all extensions into VSIX packages.
 *
 * Usage:
 *   node scripts/build-all.js              # Build all
 *   node scripts/build-all.js stf-editor   # Build one
 *
 * VSIX files are standard ZIP archives. We build them manually because
 * `vsce package` has Node 18 compatibility issues (undici dependency).
 *
 * VSIX structure:
 *   [Content_Types].xml
 *   extension.vsixmanifest
 *   extension/
 *     package.json
 *     out/           (compiled JS)
 *     ...other files
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGES = path.join(ROOT, 'packages');
const DIST = path.join(ROOT, 'dist');

// Extensions to build (everything except core)
const ALL_EXTENSIONS = fs.readdirSync(PACKAGES)
    .filter(d => d !== 'core' && fs.statSync(path.join(PACKAGES, d)).isDirectory());

const targets = process.argv.slice(2);
const extensions = targets.length > 0
    ? targets.filter(t => ALL_EXTENSIONS.includes(t))
    : ALL_EXTENSIONS;

if (extensions.length === 0) {
    console.error('No valid extensions specified. Available:', ALL_EXTENSIONS.join(', '));
    process.exit(1);
}

// Ensure dist directory exists
if (!fs.existsSync(DIST)) {
    fs.mkdirSync(DIST, { recursive: true });
}

// Build core first
console.log('=== Building @swgemu/core ===');
execSync('npx tsc -p ./', { cwd: path.join(PACKAGES, 'core'), stdio: 'inherit' });

let built = 0;
let failed = 0;

for (const ext of extensions) {
    const extDir = path.join(PACKAGES, ext);
    const pkgJson = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8'));
    const name = pkgJson.name;
    const version = pkgJson.version;
    const publisher = pkgJson.publisher || 'swgemu';
    const vsixName = `${name}-${version}.vsix`;

    console.log(`\n=== Building ${name}@${version} ===`);

    try {
        // Compile TypeScript
        execSync('npx tsc -p ./', { cwd: extDir, stdio: 'inherit' });

        // Build VSIX manually (zip with required structure)
        const vsixPath = path.join(DIST, vsixName);
        buildVSIX(extDir, vsixPath, pkgJson);

        console.log(`  -> ${vsixName}`);
        built++;
    } catch (err) {
        console.error(`  FAILED: ${err.message}`);
        failed++;
    }
}

console.log(`\n=== Done: ${built} built, ${failed} failed ===`);
if (failed > 0) process.exit(1);

function buildVSIX(extDir, outputPath, pkgJson) {
    const tmpDir = path.join(ROOT, '.vsix-tmp');

    // Clean and create temp directory
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });

    // Read .vscodeignore or use defaults
    const ignoreFile = path.join(extDir, '.vscodeignore');
    const defaultIgnores = [
        'src/**', '.vscode/**', '.vscode-test/**', 'node_modules/**',
        '.gitignore', '*.map', 'tsconfig.json', '*.vsix', '.git/**'
    ];

    // Copy extension files (excluding ignored patterns)
    copyExtensionFiles(extDir, path.join(tmpDir, 'extension'), defaultIgnores);

    // Copy core library output into extension's node_modules
    const coreOutDir = path.join(PACKAGES, 'core', 'out');
    if (fs.existsSync(coreOutDir)) {
        const coreDest = path.join(tmpDir, 'extension', 'node_modules', '@swgemu', 'core', 'out');
        fs.mkdirSync(coreDest, { recursive: true });
        copyDir(coreOutDir, coreDest);

        // Copy core package.json
        fs.copyFileSync(
            path.join(PACKAGES, 'core', 'package.json'),
            path.join(tmpDir, 'extension', 'node_modules', '@swgemu', 'core', 'package.json')
        );
    }

    // Write [Content_Types].xml
    fs.writeFileSync(path.join(tmpDir, '[Content_Types].xml'),
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
        '  <Default Extension=".json" ContentType="application/json" />\n' +
        '  <Default Extension=".js" ContentType="application/javascript" />\n' +
        '  <Default Extension=".vsixmanifest" ContentType="text/xml" />\n' +
        '  <Default Extension=".xml" ContentType="text/xml" />\n' +
        '  <Default Extension=".ts" ContentType="text/plain" />\n' +
        '  <Default Extension=".md" ContentType="text/plain" />\n' +
        '  <Default Extension=".txt" ContentType="text/plain" />\n' +
        '  <Default Extension=".png" ContentType="image/png" />\n' +
        '</Types>'
    );

    // Write extension.vsixmanifest
    const publisher = pkgJson.publisher || 'swgemu';
    const displayName = pkgJson.displayName || pkgJson.name;
    const description = pkgJson.description || '';
    const version = pkgJson.version;
    const id = `${publisher}.${pkgJson.name}`;

    fs.writeFileSync(path.join(tmpDir, 'extension.vsixmanifest'),
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">\n' +
        '  <Metadata>\n' +
        `    <Identity Language="en-US" Id="${pkgJson.name}" Version="${version}" Publisher="${publisher}" />\n` +
        `    <DisplayName>${displayName}</DisplayName>\n` +
        `    <Description>${description}</Description>\n` +
        '  </Metadata>\n' +
        '  <Installation>\n' +
        `    <InstallationTarget Id="Microsoft.VisualStudio.Code" />\n` +
        '  </Installation>\n' +
        '  <Dependencies />\n' +
        '  <Assets>\n' +
        '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" />\n' +
        '  </Assets>\n' +
        '</PackageManifest>'
    );

    // Create zip (VSIX is just a zip)
    if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
    }

    execSync(`cd "${tmpDir}" && zip -r -0 "${outputPath}" . -x ".*"`, { stdio: 'pipe' });

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
}

function copyExtensionFiles(src, dest, ignores) {
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        const relativePath = entry.name;

        // Check ignores
        if (shouldIgnore(relativePath, entry.isDirectory(), ignores)) {
            continue;
        }

        if (entry.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            copyExtensionFilesRecursive(srcPath, destPath, ignores, relativePath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function copyExtensionFilesRecursive(src, dest, ignores, prefix) {
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        const relativePath = prefix + '/' + entry.name;

        if (shouldIgnore(relativePath, entry.isDirectory(), ignores)) {
            continue;
        }

        if (entry.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            copyExtensionFilesRecursive(srcPath, destPath, ignores, relativePath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function shouldIgnore(relativePath, isDir, ignores) {
    for (const pattern of ignores) {
        // Simple glob matching
        if (pattern.endsWith('/**')) {
            const dir = pattern.slice(0, -3);
            if (relativePath === dir || relativePath.startsWith(dir + '/')) {
                return true;
            }
        } else if (pattern.startsWith('*.')) {
            const ext = pattern.slice(1);
            if (relativePath.endsWith(ext)) {
                return true;
            }
        } else if (relativePath === pattern) {
            return true;
        }
    }
    return false;
}

function copyDir(src, dest) {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}
