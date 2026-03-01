#!/usr/bin/env node
/**
 * Build the screenplay coordinate index from the command line.
 *
 * Usage:
 *   node scripts/build-screenplay-index.js [--planet endor] [--stats]
 *
 * Scans all screenplay directories, parses coordinate data, and saves
 * the index to scripts/screenplay-index.json. This is the same data
 * the VSCode extensions use, but built offline for CLI queries.
 */

const fs = require('fs');
const path = require('path');
const { parseScreenplay, buildIndexEntry, createEmptyIndex } = require('../packages/core/out/screenplay');

const SCRIPTS_PATH = '/home/swgemu/workspace/infinity_wicked/MMOCoreORB/bin/scripts';
const INDEX_PATH = path.join(__dirname, 'screenplay-index.json');

const SCREENPLAY_DIRS = [
    'screenplays/static_spawns',
    'screenplays/caves',
    'screenplays/poi',
    'screenplays/cities',
    'screenplays/dungeon',
    'screenplays/themepark',
    'screenplays/events',
    'screenplays/gcw',
    'custom_scripts/screenplays',
];

function findLuaFiles(dir) {
    const results = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isFile() && e.name.endsWith('.lua')) results.push(full);
            else if (e.isDirectory()) results.push(...findLuaFiles(full));
        }
    } catch { /* dir doesn't exist */ }
    return results;
}

function buildOverrideSet(allFiles) {
    const customPrefix = path.join(SCRIPTS_PATH, 'custom_scripts', 'screenplays');
    const customBases = new Set();
    for (const f of allFiles) {
        if (f.startsWith(customPrefix)) customBases.add(path.basename(f));
    }
    return customBases;
}

function main() {
    const args = process.argv.slice(2);
    const filterPlanet = args.includes('--planet') ? args[args.indexOf('--planet') + 1] : null;
    const showStats = args.includes('--stats');
    const verbose = args.includes('-v') || args.includes('--verbose');

    console.log('Scanning screenplay directories...');

    let allFiles = [];
    for (const relDir of SCREENPLAY_DIRS) {
        const absDir = path.join(SCRIPTS_PATH, relDir);
        const files = findLuaFiles(absDir);
        allFiles.push(...files);
        if (verbose) console.log(`  ${relDir}: ${files.length} files`);
    }
    console.log(`Found ${allFiles.length} Lua files`);

    // Build override set
    const customBases = buildOverrideSet(allFiles);
    const customPrefix = path.join(SCRIPTS_PATH, 'custom_scripts', 'screenplays');

    const index = createEmptyIndex();
    let parsed = 0, skipped = 0, overridden = 0;

    for (const filePath of allFiles) {
        // Skip vanilla files overridden by custom_scripts
        if (!filePath.startsWith(customPrefix) && customBases.has(path.basename(filePath))) {
            overridden++;
            continue;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const stat = fs.statSync(filePath);
        const result = parseScreenplay(content, filePath, stat.mtimeMs);

        if (result) {
            const idxEntry = buildIndexEntry(result);
            index.files[filePath] = { index: idxEntry, entries: result.entries };
            parsed++;
        } else {
            skipped++;
        }
    }

    index.buildTimestamp = Date.now();

    // Save index
    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
    console.log(`\nIndex built: ${parsed} screenplays with coordinates, ${skipped} skipped (no coords), ${overridden} overridden`);
    console.log(`Saved to: ${INDEX_PATH}`);

    // Stats
    if (showStats || filterPlanet) {
        const planetCounts = {};
        const catCounts = {};
        let totalEntries = 0;

        for (const [, entry] of Object.entries(index.files)) {
            const e = entry;
            for (const planet of e.index.planets) {
                if (!planetCounts[planet]) planetCounts[planet] = { screenplays: 0, mobiles: 0, objects: 0, areas: 0 };
                planetCounts[planet].screenplays++;
            }
            if (!catCounts[e.index.category]) catCounts[e.index.category] = 0;
            catCounts[e.index.category]++;
            totalEntries += e.entries.length;

            for (const coord of e.entries) {
                for (const planet of e.index.planets) {
                    if (coord.kind === 'mobile' && coord.planet === planet) planetCounts[planet].mobiles++;
                    if (coord.kind === 'object' && coord.planet === planet) planetCounts[planet].objects++;
                    if (coord.kind === 'area' && coord.planet === planet) planetCounts[planet].areas++;
                }
            }
        }

        console.log(`\nTotal coordinate entries: ${totalEntries}`);
        console.log('\nBy category:');
        for (const [cat, count] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${cat}: ${count} screenplays`);
        }
        console.log('\nBy planet:');
        for (const [planet, counts] of Object.entries(planetCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
            if (filterPlanet && planet !== filterPlanet) continue;
            console.log(`  ${planet}: ${counts.screenplays} screenplays, ${counts.mobiles} mobiles, ${counts.objects} objects, ${counts.areas} areas`);
        }
    }

    // Planet detail
    if (filterPlanet) {
        console.log(`\n=== ${filterPlanet} screenplays ===\n`);
        const entries = Object.values(index.files)
            .filter(e => e.index.planets.includes(filterPlanet))
            .sort((a, b) => {
                if (a.index.category !== b.index.category) return a.index.category.localeCompare(b.index.category);
                return a.index.name.localeCompare(b.index.name);
            });

        let lastCat = '';
        for (const entry of entries) {
            if (entry.index.category !== lastCat) {
                lastCat = entry.index.category;
                console.log(`\n[${lastCat.toUpperCase()}]`);
            }
            const mobiles = entry.entries.filter(e => e.kind === 'mobile' && e.planet === filterPlanet).length;
            const world = entry.index.worldSpawnCount;
            const interior = entry.index.interiorSpawnCount;
            console.log(`  ${entry.index.name} — ${mobiles} mobiles (${world} world, ${interior} interior)`);
        }
    }
}

main();
