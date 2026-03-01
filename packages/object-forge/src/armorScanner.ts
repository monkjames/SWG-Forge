/**
 * Armor Scanner - discovers existing armor sets on the filesystem.
 *
 * Scans both custom_scripts/ and vanilla scripts/ armor directories,
 * checks for schematics, loot schematics, TRE IFFs, and appearances.
 */

import * as path from 'path';
import * as fs from 'fs';

export interface ArmorSetInfo {
    name: string;              // e.g. "bounty_hunter_crafted"
    folderName: string;        // TRE folder e.g. "bounty_hunter"
    displayLabel: string;      // for dropdown e.g. "bounty_hunter_crafted (12 Lua, IFF, SAT)"
    source: 'custom' | 'vanilla';
    basePath: string;          // absolute path to armor folder
    luaPieces: string[];       // list of piece filenames
    hasObjects: boolean;
    hasServerObjects: boolean;
    schematicCount: number;
    lootSchematicCount: number;
    hasIFFs: boolean;
    hasSATs: boolean;
}

/**
 * Derive the TRE folder name from objects.lua clientTemplateFileName paths.
 * e.g. "object/tangible/wearables/armor/bounty_hunter/shared_armor_..." → "bounty_hunter"
 */
function deriveFolderName(objectsLuaPath: string): string | null {
    try {
        const content = fs.readFileSync(objectsLuaPath, 'utf8');
        const match = content.match(/wearables\/armor\/([^/]+)\/shared_/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/**
 * Derive the armor name from the lua filenames in a folder.
 * e.g. "armor_bounty_hunter_crafted_helmet.lua" → "bounty_hunter_crafted"
 */
function deriveArmorName(luaFiles: string[]): string | null {
    // Find a piece file (not objects.lua or serverobjects.lua)
    const pieceFile = luaFiles.find(f =>
        f.startsWith('armor_') && f.endsWith('.lua')
    );
    if (!pieceFile) return null;

    // Strip "armor_" prefix and known piece suffixes
    const base = pieceFile.replace(/\.lua$/, '').replace(/^armor_/, '');
    const suffixes = [
        '_helmet', '_chest_plate', '_leggings', '_boots', '_belt',
        '_gloves', '_bracer_l', '_bracer_r', '_bicep_l', '_bicep_r',
    ];
    for (const s of suffixes) {
        if (base.endsWith(s)) return base.slice(0, -s.length);
    }
    return null;
}

/**
 * Scan for existing armor sets across custom_scripts and vanilla scripts.
 */
export function scanArmorSets(workspace: string): ArmorSetInfo[] {
    const results: ArmorSetInfo[] = [];
    const scriptsBase = path.join(workspace, 'infinity_wicked/MMOCoreORB/bin/scripts');

    const scanPaths: { dir: string; source: 'custom' | 'vanilla' }[] = [
        { dir: path.join(scriptsBase, 'custom_scripts/object/tangible/wearables/armor'), source: 'custom' },
        { dir: path.join(scriptsBase, 'object/tangible/wearables/armor'), source: 'vanilla' },
    ];

    for (const { dir, source } of scanPaths) {
        if (!fs.existsSync(dir)) continue;

        const subdirs = fs.readdirSync(dir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort();

        for (const subdir of subdirs) {
            const armorDir = path.join(dir, subdir);
            const files = fs.readdirSync(armorDir).filter(f => f.endsWith('.lua'));

            const luaPieces = files.filter(f =>
                f.startsWith('armor_') && !f.includes('schematic')
            );

            if (luaPieces.length === 0) continue;

            const armorName = deriveArmorName(luaPieces);
            if (!armorName) continue;

            // Derive TRE folder from objects.lua
            const objectsPath = path.join(armorDir, 'objects.lua');
            let folderName = deriveFolderName(objectsPath) || subdir;

            // Count schematics
            const schematicDirs = [
                path.join(scriptsBase, 'custom_scripts/object/draft_schematic/armor'),
                path.join(scriptsBase, 'object/draft_schematic/clothing'),
            ];
            let schematicCount = 0;
            for (const sd of schematicDirs) {
                if (!fs.existsSync(sd)) continue;
                const schFiles = fs.readdirSync(sd).filter(f =>
                    f.includes(armorName) && f.includes('schematic') && f.endsWith('.lua')
                );
                schematicCount += schFiles.length;
            }

            // Count loot schematics
            const lootDirs = [
                path.join(scriptsBase, 'custom_scripts/object/tangible/loot/loot_schematic/wearables'),
                path.join(scriptsBase, 'object/tangible/loot/loot_schematic'),
            ];
            let lootCount = 0;
            for (const ld of lootDirs) {
                if (!fs.existsSync(ld)) continue;
                const lootFiles = fs.readdirSync(ld).filter(f =>
                    f.includes(armorName) && f.includes('schematic') && f.endsWith('.lua')
                );
                lootCount += lootFiles.length;
            }

            // Check for IFFs in TRE
            const treRoots = ['tre/working', 'tre/infinity', 'tre/vanilla'];
            let hasIFFs = false;
            for (const tr of treRoots) {
                const iffDir = path.join(workspace, tr, 'object/tangible/wearables/armor', folderName);
                if (fs.existsSync(iffDir)) {
                    const iffs = fs.readdirSync(iffDir).filter(f =>
                        f.includes(armorName) && f.endsWith('.iff')
                    );
                    if (iffs.length > 0) { hasIFFs = true; break; }
                }
            }

            // Check for SATs in TRE
            let hasSATs = false;
            for (const tr of treRoots) {
                const appDir = path.join(workspace, tr, 'appearance');
                if (!fs.existsSync(appDir)) continue;
                const sats = fs.readdirSync(appDir).filter(f =>
                    f.includes(armorName) && f.endsWith('.sat')
                );
                if (sats.length > 0) { hasSATs = true; break; }
            }

            // Build label
            const parts = [`${luaPieces.length} Lua`];
            if (schematicCount > 0) parts.push(`${schematicCount} sch`);
            if (hasIFFs) parts.push('IFF');
            if (hasSATs) parts.push('SAT');

            results.push({
                name: armorName,
                folderName,
                displayLabel: `${armorName} (${parts.join(', ')})`,
                source,
                basePath: armorDir,
                luaPieces,
                hasObjects: files.includes('objects.lua'),
                hasServerObjects: files.includes('serverobjects.lua'),
                schematicCount,
                lootSchematicCount: lootCount,
                hasIFFs,
                hasSATs,
            });
        }
    }

    // Sort: custom first, then alphabetical
    results.sort((a, b) => {
        if (a.source !== b.source) return a.source === 'custom' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    return results;
}
