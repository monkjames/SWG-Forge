/**
 * Complete mobile duplication orchestrator
 */

import * as fs from 'fs';
import * as path from 'path';
import { cloneAppearanceChain, type CloneResult } from './appearanceChainCloner';
import { parseCRCTable, addCRCEntries, serializeCRCTable, parseSTF, serializeSTF, addSTFEntries } from '@swgemu/core';
import type { STFData, StringEntry } from '@swgemu/core';

export interface DuplicateConfig {
    sourceMobilePath: string;
    targetFolder: string;  // Target folder within custom_scripts/mobile/ (e.g., "creatures", "boss/krayt")
    newCreatureName: string;
    displayName: string;
    description: string;
    objectTemplatePath?: string;
    appearancePath?: string;
    isCustom: boolean;
}

export interface DuplicatePaths {
    scriptsPath: string;
    customScriptsPath: string;
    treWorking: string;
    treInfinity: string;
    treVanilla: string;
}

export interface DuplicateResult {
    created: string[];
    modified: string[];
    errors: string[];
}

export interface OverwriteCheckResult {
    willOverwrite: boolean;
    existingFiles: string[];
    stfEntries: { id: string; value: string; }[];
    stfFile: string;
    stfStatus: 'exists' | 'will_copy' | 'will_create';
}

/**
 * Check if duplication would overwrite existing files
 */
export function checkOverwrites(config: DuplicateConfig, paths: DuplicatePaths): OverwriteCheckResult {
    const existingFiles: string[] = [];

    // Check mobile Lua file - use targetFolder instead of deriving from source
    const targetDir = path.join(paths.customScriptsPath, 'mobile', config.targetFolder);
    const targetPath = path.join(targetDir, config.newCreatureName + '.lua');

    if (fs.existsSync(targetPath)) {
        existingFiles.push(targetPath);
    }

    // Check object template if applicable
    if (config.objectTemplatePath) {
        const templateLuaPath = config.objectTemplatePath.replace('.iff', '.lua');
        const targetLuaPath = path.join(paths.customScriptsPath, path.dirname(templateLuaPath), config.newCreatureName + '.lua');
        if (fs.existsSync(targetLuaPath)) {
            existingFiles.push(targetLuaPath);
        }
    }

    // Check STF file status and entries
    const stfRelPath = 'string/en/mob/creature_names.stf';
    const workingPath = path.join(paths.treWorking, stfRelPath);
    const infinityPath = path.join(paths.treInfinity, stfRelPath);
    const vanillaPath = path.join(paths.treVanilla, stfRelPath);

    let stfStatus: 'exists' | 'will_copy' | 'will_create' = 'will_create';
    let stf: STFData | null = null;

    if (fs.existsSync(workingPath)) {
        stfStatus = 'exists';
        stf = parseSTF(new Uint8Array(fs.readFileSync(workingPath)));
    } else if (fs.existsSync(infinityPath)) {
        stfStatus = 'will_copy';
    } else if (fs.existsSync(vanillaPath)) {
        stfStatus = 'will_copy';
    }

    // Build STF entries that will be added
    const stfEntries: { id: string; value: string; }[] = [
        { id: config.newCreatureName, value: config.displayName }
    ];

    if (config.description && config.description.trim()) {
        stfEntries.push({ id: config.newCreatureName + '_desc', value: config.description });
    }

    // Check if STF entries already exist
    if (stf) {
        for (const entry of stfEntries) {
            if (stf.entries.some(e => e.id === entry.id)) {
                // Entry exists - this would be an overwrite
                existingFiles.push(`${stfRelPath} [entry: ${entry.id}]`);
            }
        }
    }

    return {
        willOverwrite: existingFiles.length > 0,
        existingFiles,
        stfEntries,
        stfFile: stfRelPath,
        stfStatus
    };
}

/**
 * Duplicate a complete mobile creature
 */
export function duplicateMobile(config: DuplicateConfig, paths: DuplicatePaths): DuplicateResult {
    const result: DuplicateResult = { created: [], modified: [], errors: [] };

    try {
        // Check for overwrites first
        const overwriteCheck = checkOverwrites(config, paths);
        if (overwriteCheck.willOverwrite) {
            result.errors.push('Cannot duplicate: would overwrite existing files:');
            result.errors.push(...overwriteCheck.existingFiles);
            return result;
        }

        // 1. Clone mobile Lua file
        cloneMobileLua(config, paths, result);

        // 2. Clone object template (if exists)
        if (config.objectTemplatePath) {
            cloneObjectTemplate(config, paths, result);
        }

        // 3. Clone appearance chain (SAT/LOD/MGN/MSH/SHT/DDS)
        if (config.appearancePath) {
            const chainResult = cloneAppearanceChain(
                config.appearancePath,
                config.newCreatureName,
                paths.treWorking,
                paths.treInfinity,
                paths.treVanilla
            );
            result.created.push(...chainResult.cloned);
            result.errors.push(...chainResult.errors);
        }

        // 4. Update CRC table
        updateCRC(config, paths, result);

        // 5. Generate STF strings
        generateSTF(config, paths, result);

    } catch (e: any) {
        result.errors.push('Duplication failed: ' + e.message);
    }

    return result;
}

/**
 * Clone the mobile Lua file
 */
function cloneMobileLua(config: DuplicateConfig, paths: DuplicatePaths, result: DuplicateResult): void {
    const sourceContent = fs.readFileSync(config.sourceMobilePath, 'utf-8');

    // Replace creature name references
    const originalName = path.basename(config.sourceMobilePath, '.lua');
    const newContent = sourceContent.replace(new RegExp(originalName, 'g'), config.newCreatureName);

    // Use targetFolder to determine where to create the file
    const targetDir = path.join(paths.customScriptsPath, 'mobile', config.targetFolder);
    const targetPath = path.join(targetDir, config.newCreatureName + '.lua');

    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, newContent);
    result.created.push(targetPath);

    // Update serverobjects.lua in the target folder
    const serverObjectsPath = path.join(targetDir, 'serverobjects.lua');
    const customFolder = paths.customScriptsPath.split('/').pop() || 'custom_scripts';

    // Build include path: ../custom_scripts/mobile/[targetFolder]/creature_name.lua
    const includePath = `../${customFolder}/mobile/${config.targetFolder}/${config.newCreatureName}.lua`;

    if (fs.existsSync(serverObjectsPath)) {
        fs.appendFileSync(serverObjectsPath, `includeFile("${includePath}")\n`);
        result.modified.push(serverObjectsPath);
    } else {
        fs.writeFileSync(serverObjectsPath, `includeFile("${includePath}")\n`);
        result.created.push(serverObjectsPath);
    }
}

/**
 * Clone the object template Lua file
 */
function cloneObjectTemplate(config: DuplicateConfig, paths: DuplicatePaths, result: DuplicateResult): void {
    if (!config.objectTemplatePath) return;

    // Convert object/mobile/foo.iff → object/mobile/foo.lua
    const templateLuaPath = config.objectTemplatePath.replace('.iff', '.lua');
    const sourceLuaPath = path.join(paths.customScriptsPath, templateLuaPath);

    if (!fs.existsSync(sourceLuaPath)) {
        result.errors.push('Object template Lua not found: ' + templateLuaPath);
        return;
    }

    const sourceContent = fs.readFileSync(sourceLuaPath, 'utf-8');
    const originalName = path.basename(config.objectTemplatePath, '.iff');
    const newContent = sourceContent.replace(new RegExp(originalName, 'g'), config.newCreatureName);

    const targetLuaPath = path.join(paths.customScriptsPath, path.dirname(templateLuaPath), config.newCreatureName + '.lua');
    fs.mkdirSync(path.dirname(targetLuaPath), { recursive: true });
    fs.writeFileSync(targetLuaPath, newContent);
    result.created.push(targetLuaPath);

    // Update objects.lua (shared template)
    const objectsLuaPath = path.join(path.dirname(targetLuaPath), 'objects.lua');
    const sharedTemplatePath = path.dirname(templateLuaPath) + '/shared_' + config.newCreatureName + '.iff';
    const sharedEntry = `\n-- ${config.newCreatureName}\nSharedObjectTemplate:new {\n\tclientTemplateFileName = "${sharedTemplatePath}"\n}\n`;

    if (fs.existsSync(objectsLuaPath)) {
        fs.appendFileSync(objectsLuaPath, sharedEntry);
        result.modified.push(objectsLuaPath);
    } else {
        fs.writeFileSync(objectsLuaPath, sharedEntry);
        result.created.push(objectsLuaPath);
    }
}

/**
 * Update CRC table with new object template
 */
function updateCRC(config: DuplicateConfig, paths: DuplicatePaths, result: DuplicateResult): void {
    if (!config.objectTemplatePath) return;

    const crcRelPath = 'misc/object_template_crc_string_table.iff';
    const workingCrc = path.join(paths.treWorking, crcRelPath);
    const infinityCrc = path.join(paths.treInfinity, crcRelPath);

    let crcPath: string;
    if (fs.existsSync(workingCrc)) {
        crcPath = workingCrc;
    } else if (fs.existsSync(infinityCrc)) {
        fs.mkdirSync(path.dirname(workingCrc), { recursive: true });
        fs.copyFileSync(infinityCrc, workingCrc);
        crcPath = workingCrc;
    } else {
        result.errors.push('No CRC table found');
        return;
    }

    const data = fs.readFileSync(crcPath);
    const table = parseCRCTable(new Uint8Array(data));

    const newTemplatePath = path.dirname(config.objectTemplatePath) + '/shared_' + config.newCreatureName + '.iff';
    const added = addCRCEntries(table, [newTemplatePath]);

    if (added.length > 0) {
        fs.writeFileSync(crcPath, Buffer.from(serializeCRCTable(table)));
        if (!result.modified.includes(crcPath)) {
            result.modified.push(crcPath);
        }
    }
}

/**
 * Generate STF strings for the new creature
 * Uses creature_names.stf for display name (mob/creature_names.stf)
 */
function generateSTF(config: DuplicateConfig, paths: DuplicatePaths, result: DuplicateResult): void {
    const stfRelPath = 'string/en/mob/creature_names.stf';
    const workingPath = path.join(paths.treWorking, stfRelPath);
    const infinityPath = path.join(paths.treInfinity, stfRelPath);
    const vanillaPath = path.join(paths.treVanilla, stfRelPath);

    let stf: STFData;
    let wasCopied = false;

    // Try working first, then copy from infinity or vanilla
    if (fs.existsSync(workingPath)) {
        stf = parseSTF(new Uint8Array(fs.readFileSync(workingPath)));
    } else {
        // Copy from reference
        let sourcePath: string | null = null;
        if (fs.existsSync(infinityPath)) {
            sourcePath = infinityPath;
        } else if (fs.existsSync(vanillaPath)) {
            sourcePath = vanillaPath;
        }

        if (sourcePath) {
            stf = parseSTF(new Uint8Array(fs.readFileSync(sourcePath)));
            wasCopied = true;
        } else {
            // Create new if no reference exists
            stf = { version: 1, nextUid: 1, entries: [] };
            wasCopied = true;
        }
    }

    // Add both display name and description using the creature name as ID
    const entries: StringEntry[] = [
        { id: config.newCreatureName, value: config.displayName }
    ];

    // If description provided, add it with _desc suffix
    if (config.description && config.description.trim()) {
        entries.push({ id: config.newCreatureName + '_desc', value: config.description });
    }

    addSTFEntries(stf, entries);

    fs.mkdirSync(path.dirname(workingPath), { recursive: true });
    fs.writeFileSync(workingPath, Buffer.from(serializeSTF(stf)));

    if (wasCopied) {
        result.created.push(workingPath);
    } else if (!result.modified.includes(workingPath)) {
        result.modified.push(workingPath);
    }
}
