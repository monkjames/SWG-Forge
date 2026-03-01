/**
 * Post-Generation Automation Actions
 *
 * These are the 6 steps that come after Lua file generation:
 * 1. Append schematics to managers/crafting/schematics.lua
 * 2. Clone shared_*.iff files from a base armor set
 * 3. Register all IFF paths in the CRC string table
 * 4. Copy/clone appearance files (SAT) from base armor
 * 5. Add ACM entries for customization
 * 6. Add STF string entries for item names/descriptions
 */

import * as path from 'path';
import * as fs from 'fs';
import {
    parseCRCTable, serializeCRCTable, addCRCEntries,
    parseACM, serializeACM, addCidxEntry, addMinimalUidxEntry, addAssetLikeExisting, findAssetByPath,
    parseSTF, serializeSTF, addSTFEntries,
    cloneIFFWithReplacements, getArmorIFFReplacements, getSchematicIFFReplacements, getLootSchematicIFFReplacements,
} from '@swgemu/core';
import { ARMOR_PIECES, ArmorPiece } from './armorGenerator';

// ─── Shared path resolution ─────────────────────────────────────────────────────

interface Paths {
    workspace: string;
    scripts: string;
    treWorking: string;
    treVanilla: string;
    treInfinity: string;
}

function getPaths(workspace: string): Paths {
    return {
        workspace,
        scripts: path.join(workspace, 'infinity_wicked/MMOCoreORB/bin/scripts'),
        treWorking: path.join(workspace, 'tre/working'),
        treVanilla: path.join(workspace, 'tre/vanilla'),
        treInfinity: path.join(workspace, 'tre/infinity'),
    };
}

function findTREFile(paths: Paths, relativePath: string): string | null {
    const candidates = [
        path.join(paths.treInfinity, relativePath),
        path.join(paths.treWorking, relativePath),
        path.join(paths.treVanilla, relativePath),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

// ─── Step 1: Schematics Registry ────────────────────────────────────────────────

export interface Step1Result {
    success: boolean;
    message: string;
    linesAdded: number;
}

export function appendSchematicsRegistry(workspace: string, armorName: string, snippet: string): Step1Result {
    const p = getPaths(workspace);
    const schematicsFile = path.join(p.scripts, 'managers/crafting/schematics.lua');

    if (!fs.existsSync(schematicsFile)) {
        return { success: false, message: `File not found: ${schematicsFile}`, linesAdded: 0 };
    }

    const content = fs.readFileSync(schematicsFile, 'utf8');

    // Check if already added
    if (content.includes(`armor_${armorName}_helmet_schematic`)) {
        return { success: true, message: 'Already registered in schematics.lua', linesAdded: 0 };
    }

    // Find a good insertion point - look for the last armor schematic block
    // Strategy: find the last line matching {path="object/draft_schematic/armor/ and insert after that block
    const lines = content.split('\n');
    let insertIdx = -1;

    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('{path="object/draft_schematic/armor/')) {
            insertIdx = i + 1;
            break;
        }
    }

    if (insertIdx === -1) {
        // Fallback: append before the closing of the armorsmith section
        // Just append near the end
        return { success: false, message: 'Could not find insertion point. Add manually:\n' + snippet, linesAdded: 0 };
    }

    // Insert blank line + snippet
    const snippetLines = snippet.split('\n');
    lines.splice(insertIdx, 0, '', ...snippetLines);

    fs.writeFileSync(schematicsFile, lines.join('\n'), 'utf8');
    return { success: true, message: `Added ${snippetLines.length} lines to schematics.lua`, linesAdded: snippetLines.length };
}

// ─── Step 2: Clone Shared IFF Files ─────────────────────────────────────────────

export interface Step2Result {
    success: boolean;
    message: string;
    filesCreated: number;
    errors: string[];
}

export function cloneSharedIFFs(
    workspace: string,
    sourceArmorName: string, sourceFolderName: string,
    targetArmorName: string, targetFolderName: string
): Step2Result {
    const p = getPaths(workspace);
    const errors: string[] = [];
    let created = 0;

    // DERV parent base names per piece
    const pieceParents: Record<ArmorPiece, string> = {
        helmet: 'shared_base_helmet_closed_full',
        chest_plate: 'shared_base_vest',
        leggings: 'shared_base_skirt',
        boots: 'shared_base_shoes',
        belt: 'shared_base_belt',
        gloves: 'shared_base_gauntlets',
        bracer_l: 'shared_base_bracer_l',
        bracer_r: 'shared_base_bracer_r',
        bicep_l: 'shared_base_bicep_l',
        bicep_r: 'shared_base_bicep_r',
    };

    for (const piece of ARMOR_PIECES) {
        // 1. Armor IFF
        const srcArmorIff = `object/tangible/wearables/armor/${sourceFolderName}/shared_armor_${sourceArmorName}_${piece}.iff`;
        const dstArmorIff = `object/tangible/wearables/armor/${targetFolderName}/shared_armor_${targetArmorName}_${piece}.iff`;

        const srcFile = findTREFile(p, srcArmorIff);
        if (srcFile) {
            const data = new Uint8Array(fs.readFileSync(srcFile));
            const replacements = getArmorIFFReplacements(sourceArmorName, targetArmorName, sourceFolderName, targetFolderName, piece);
            const cloned = cloneIFFWithReplacements(data, replacements);

            const dstPath = path.join(p.treWorking, dstArmorIff);
            fs.mkdirSync(path.dirname(dstPath), { recursive: true });
            fs.writeFileSync(dstPath, cloned);
            created++;
        } else {
            errors.push(`Source not found: ${srcArmorIff}`);
        }

        // 2. Draft schematic IFF
        const srcSchIff = `object/draft_schematic/armor/shared_armor_${sourceArmorName}_${piece}_schematic.iff`;
        const dstSchIff = `object/draft_schematic/armor/shared_armor_${targetArmorName}_${piece}_schematic.iff`;

        const srcSchFile = findTREFile(p, srcSchIff);
        if (srcSchFile) {
            const data = new Uint8Array(fs.readFileSync(srcSchFile));
            const replacements = getSchematicIFFReplacements(sourceArmorName, targetArmorName, piece);
            const cloned = cloneIFFWithReplacements(data, replacements);

            const dstPath = path.join(p.treWorking, dstSchIff);
            fs.mkdirSync(path.dirname(dstPath), { recursive: true });
            fs.writeFileSync(dstPath, cloned);
            created++;
        } else {
            errors.push(`Source not found: ${srcSchIff}`);
        }

        // 3. Loot schematic IFF
        const srcLootIff = `object/tangible/loot/loot_schematic/shared_armor_${sourceArmorName}_${piece}_loot_schematic.iff`;
        const dstLootIff = `object/tangible/loot/loot_schematic/shared_armor_${targetArmorName}_${piece}_loot_schematic.iff`;

        const srcLootFile = findTREFile(p, srcLootIff);
        if (srcLootFile) {
            const data = new Uint8Array(fs.readFileSync(srcLootFile));
            const replacements = getLootSchematicIFFReplacements(sourceArmorName, targetArmorName, sourceFolderName, targetFolderName, piece);
            const cloned = cloneIFFWithReplacements(data, replacements);

            const dstPath = path.join(p.treWorking, dstLootIff);
            fs.mkdirSync(path.dirname(dstPath), { recursive: true });
            fs.writeFileSync(dstPath, cloned);
            created++;
        } else {
            errors.push(`Source not found: ${srcLootIff}`);
        }
    }

    return {
        success: errors.length === 0,
        message: `Created ${created} IFF files` + (errors.length > 0 ? ` (${errors.length} errors)` : ''),
        filesCreated: created,
        errors,
    };
}

// ─── Step 3: CRC Table Registration ─────────────────────────────────────────────

export interface Step3Result {
    success: boolean;
    message: string;
    entriesAdded: number;
}

export function registerCRCEntries(workspace: string, iffPaths: string[]): Step3Result {
    const p = getPaths(workspace);
    const crcTablePath = path.join(p.treWorking, 'misc/object_template_crc_string_table.iff');

    if (!fs.existsSync(crcTablePath)) {
        return { success: false, message: `CRC table not found: ${crcTablePath}`, entriesAdded: 0 };
    }

    const data = new Uint8Array(fs.readFileSync(crcTablePath));
    const table = parseCRCTable(data);
    const added = addCRCEntries(table, iffPaths);
    const serialized = serializeCRCTable(table);
    fs.writeFileSync(crcTablePath, serialized);

    return {
        success: true,
        message: `Added ${added.length} entries to CRC table (${table.entries.length} total)`,
        entriesAdded: added.length,
    };
}

// ─── Step 4: Clone Appearance Files ─────────────────────────────────────────────

export interface Step4Result {
    success: boolean;
    message: string;
    filesCopied: number;
    errors: string[];
}

export function cloneAppearanceFiles(
    workspace: string,
    sourceArmorName: string, targetArmorName: string
): Step4Result {
    const p = getPaths(workspace);
    const errors: string[] = [];
    let copied = 0;

    for (const piece of ARMOR_PIECES) {
        // Look for male and female SAT files
        for (const suffix of ['_m.sat', '_f.sat']) {
            const srcName = `appearance/armor_${sourceArmorName}_${piece}${suffix}`;
            const dstName = `appearance/armor_${targetArmorName}_${piece}${suffix}`;

            const srcFile = findTREFile(p, srcName);
            if (srcFile) {
                const dstPath = path.join(p.treWorking, dstName);
                fs.mkdirSync(path.dirname(dstPath), { recursive: true });
                fs.copyFileSync(srcFile, dstPath);
                copied++;
            } else {
                // Try without crafted_ prefix or other naming patterns
                errors.push(`Not found: ${srcName}`);
            }
        }
    }

    return {
        success: copied > 0,
        message: `Copied ${copied} appearance files` + (errors.length > 0 ? ` (${errors.length} not found)` : ''),
        filesCopied: copied,
        errors,
    };
}

// ─── Step 5: ACM Registration ───────────────────────────────────────────────────

export interface Step5Result {
    success: boolean;
    message: string;
    entriesAdded: number;
}

export function registerACMEntries(
    workspace: string, acmPaths: string[], copyFromArmorName?: string
): Step5Result {
    const p = getPaths(workspace);

    // Find the ACM file
    const acmFile = findTREFile(p, 'customization/asset_customization_manager.iff');
    if (!acmFile) {
        return { success: false, message: 'ACM file not found in TRE directories', entriesAdded: 0 };
    }

    const data = new Uint8Array(fs.readFileSync(acmFile));
    const acm = parseACM(data);

    let added = 0;
    let copyFromIndex: number | undefined;

    // If copying from existing armor, find its asset index
    if (copyFromArmorName) {
        const samplePath = `appearance/armor_${copyFromArmorName}_helmet_m.sat`;
        const existing = findAssetByPath(acm, samplePath);
        if (existing) {
            copyFromIndex = existing.assetIndex;
        }
    }

    for (const assetPath of acmPaths) {
        if (findAssetByPath(acm, assetPath)) continue; // Already exists

        if (copyFromIndex) {
            try {
                addAssetLikeExisting(acm, assetPath, copyFromIndex);
                added++;
            } catch {
                // Fallback to minimal
                const maxIdx = acm.uidxEntries.reduce((m, e) => Math.max(m, e.index), 0);
                const newIdx = maxIdx + 1;
                addMinimalUidxEntry(acm, newIdx);
                addCidxEntry(acm, assetPath, newIdx);
                added++;
            }
        } else {
            const maxIdx = acm.uidxEntries.reduce((m, e) => Math.max(m, e.index), 0);
            const newIdx = maxIdx + 1;
            addMinimalUidxEntry(acm, newIdx);
            addCidxEntry(acm, assetPath, newIdx);
            added++;
        }
    }

    if (added > 0) {
        const serialized = serializeACM(acm);
        // Write to working directory
        const dstPath = path.join(p.treWorking, 'customization/asset_customization_manager.iff');
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.writeFileSync(dstPath, serialized);
    }

    return {
        success: true,
        message: `Added ${added} ACM entries (saved to tre/working/)`,
        entriesAdded: added,
    };
}

// ─── Step 6: STF String Entries ─────────────────────────────────────────────────

export interface Step6Result {
    success: boolean;
    message: string;
    entriesAdded: number;
    errors: string[];
}

export function addSTFStrings(
    workspace: string, armorName: string, displayName: string
): Step6Result {
    const p = getPaths(workspace);
    const errors: string[] = [];
    let totalAdded = 0;

    // Piece display names
    const pieceDisplayNames: Record<ArmorPiece, string> = {
        helmet: 'Helmet',
        chest_plate: 'Chest Plate',
        leggings: 'Leggings',
        boots: 'Boots',
        belt: 'Belt',
        gloves: 'Gloves',
        bracer_l: 'Left Bracer',
        bracer_r: 'Right Bracer',
        bicep_l: 'Left Bicep',
        bicep_r: 'Right Bicep',
    };

    // 1. wearables_name.stf - item names
    const nameEntries = ARMOR_PIECES.map(piece => ({
        id: `armor_${armorName}_${piece}`,
        value: `${displayName} ${pieceDisplayNames[piece]}`,
    }));

    // 2. wearables_detail.stf - item descriptions
    const detailEntries = ARMOR_PIECES.map(piece => ({
        id: `armor_${armorName}_${piece}`,
        value: `A ${displayName.toLowerCase()} ${pieceDisplayNames[piece].toLowerCase()}.`,
    }));

    // Process each STF file
    const stfUpdates: { relativePath: string; entries: { id: string; value: string }[] }[] = [
        { relativePath: 'string/en/wearables_name.stf', entries: nameEntries },
        { relativePath: 'string/en/wearables_detail.stf', entries: detailEntries },
    ];

    for (const update of stfUpdates) {
        const stfFile = findTREFile(p, update.relativePath);
        if (!stfFile) {
            errors.push(`STF not found: ${update.relativePath}`);
            continue;
        }

        try {
            const data = new Uint8Array(fs.readFileSync(stfFile));
            const stf = parseSTF(data);
            const added = addSTFEntries(stf, update.entries);
            totalAdded += added;

            if (added > 0) {
                const serialized = serializeSTF(stf);
                const dstPath = path.join(p.treWorking, update.relativePath);
                fs.mkdirSync(path.dirname(dstPath), { recursive: true });
                fs.writeFileSync(dstPath, serialized);
            }
        } catch (err: any) {
            errors.push(`Failed to update ${update.relativePath}: ${err.message}`);
        }
    }

    return {
        success: errors.length === 0,
        message: `Added ${totalAdded} STF entries` + (errors.length > 0 ? ` (${errors.length} errors)` : ''),
        entriesAdded: totalAdded,
        errors,
    };
}
