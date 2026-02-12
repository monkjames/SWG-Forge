/**
 * Armor Duplicator - clones an entire armor set with new naming.
 *
 * Unlike the config-based generator, this does pure text/binary string
 * replacement to faithfully duplicate all files from a source armor set.
 */

import * as path from 'path';
import * as fs from 'fs';
import { scanArmorSets, ArmorSetInfo } from './armorScanner';
import { ARMOR_PIECES } from './armorGenerator';
import {
    appendSchematicsRegistry,
    cloneSharedIFFs,
    registerCRCEntries,
    cloneAppearanceFiles,
    registerACMEntries,
    addSTFStrings,
} from './postGenActions';

export interface DuplicateConfig {
    sourceArmorName: string;
    sourceFolderName: string;
    targetArmorName: string;
    targetFolderName: string;
    targetDisplayName: string;
}

export interface DuplicateStepResult {
    step: number;
    label: string;
    success: boolean;
    message: string;
}

export interface DuplicateResult {
    steps: DuplicateStepResult[];
    totalFilesCreated: number;
    errors: string[];
}

// ─── Lua Cloning ─────────────────────────────────────────────────────────────

function replaceInContent(content: string, config: DuplicateConfig): string {
    // Replace armor name (the more specific one first)
    let result = content;

    // Replace in Lua variable names: underscored path segments
    // e.g. object_tangible_wearables_armor_bounty_hunter_crafted_
    result = result.split(config.sourceArmorName).join(config.targetArmorName);

    // Replace TRE folder references: armor/bounty_hunter/ → armor/death_watch/
    if (config.sourceFolderName !== config.targetFolderName) {
        result = result.split(`armor/${config.sourceFolderName}/`).join(`armor/${config.targetFolderName}/`);
        // Also in underscored form for Lua variable names
        result = result.split(`armor_${config.sourceFolderName}_`).join(`armor_${config.targetFolderName}_`);
    }

    return result;
}

function replaceInFilename(filename: string, config: DuplicateConfig): string {
    return filename.split(config.sourceArmorName).join(config.targetArmorName);
}

interface CloneLuaResult {
    filesWritten: number;
    errors: string[];
}

function cloneLuaArmorDir(scriptsBase: string, config: DuplicateConfig, sourceInfo: ArmorSetInfo): CloneLuaResult {
    const errors: string[] = [];
    let written = 0;

    // Determine target directory (always goes in custom_scripts)
    const targetDir = path.join(scriptsBase, 'custom_scripts/object/tangible/wearables/armor', config.targetArmorName);
    fs.mkdirSync(targetDir, { recursive: true });

    // Clone all .lua files from source
    const srcDir = sourceInfo.basePath;
    const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.lua'));

    for (const file of files) {
        const srcPath = path.join(srcDir, file);
        const content = fs.readFileSync(srcPath, 'utf8');
        const newContent = replaceInContent(content, config);
        const newFilename = replaceInFilename(file, config);
        const dstPath = path.join(targetDir, newFilename);

        fs.writeFileSync(dstPath, newContent, 'utf8');
        written++;
    }

    return { filesWritten: written, errors };
}

function cloneLuaSchematics(scriptsBase: string, config: DuplicateConfig): CloneLuaResult {
    const errors: string[] = [];
    let written = 0;

    // Search for source schematic files in both custom_scripts and vanilla
    const searchDirs = [
        path.join(scriptsBase, 'custom_scripts/object/draft_schematic/armor'),
        path.join(scriptsBase, 'object/draft_schematic/clothing'),
        path.join(scriptsBase, 'object/draft_schematic/armor'),
    ];

    const targetDir = path.join(scriptsBase, 'custom_scripts/object/draft_schematic/armor');
    fs.mkdirSync(targetDir, { recursive: true });

    const alreadyCloned = new Set<string>();

    for (const searchDir of searchDirs) {
        if (!fs.existsSync(searchDir)) continue;
        const files = fs.readdirSync(searchDir).filter(f =>
            f.includes(config.sourceArmorName) && f.includes('schematic') && f.endsWith('.lua')
        );

        for (const file of files) {
            const newFilename = replaceInFilename(file, config);
            if (alreadyCloned.has(newFilename)) continue;
            alreadyCloned.add(newFilename);

            const srcPath = path.join(searchDir, file);
            const content = fs.readFileSync(srcPath, 'utf8');
            const newContent = replaceInContent(content, config);
            const dstPath = path.join(targetDir, newFilename);

            fs.writeFileSync(dstPath, newContent, 'utf8');
            written++;
        }
    }

    // Also handle objects.lua and serverobjects.lua for schematics
    for (const searchDir of searchDirs) {
        if (!fs.existsSync(searchDir)) continue;
        for (const regFile of ['objects.lua', 'serverobjects.lua']) {
            const regPath = path.join(searchDir, regFile);
            if (!fs.existsSync(regPath)) continue;

            const content = fs.readFileSync(regPath, 'utf8');
            if (!content.includes(config.sourceArmorName)) continue;

            // Extract only the lines related to this armor and append to target registry
            const lines = content.split('\n');
            const relevantLines = lines.filter(l => l.includes(config.sourceArmorName));
            if (relevantLines.length === 0) continue;

            const newLines = relevantLines.map(l => replaceInContent(l, config));
            const targetRegPath = path.join(targetDir, regFile);

            if (fs.existsSync(targetRegPath)) {
                const existing = fs.readFileSync(targetRegPath, 'utf8');
                if (!existing.includes(config.targetArmorName)) {
                    fs.appendFileSync(targetRegPath, '\n' + newLines.join('\n') + '\n', 'utf8');
                }
            } else {
                fs.writeFileSync(targetRegPath, newLines.join('\n') + '\n', 'utf8');
                written++;
            }
        }
    }

    return { filesWritten: written, errors };
}

function cloneLuaLootSchematics(scriptsBase: string, config: DuplicateConfig): CloneLuaResult {
    const errors: string[] = [];
    let written = 0;

    const searchDirs = [
        path.join(scriptsBase, 'custom_scripts/object/tangible/loot/loot_schematic/wearables'),
        path.join(scriptsBase, 'object/tangible/loot/loot_schematic'),
    ];

    const targetDir = path.join(scriptsBase, 'custom_scripts/object/tangible/loot/loot_schematic/wearables');
    fs.mkdirSync(targetDir, { recursive: true });

    const alreadyCloned = new Set<string>();

    for (const searchDir of searchDirs) {
        if (!fs.existsSync(searchDir)) continue;
        const files = fs.readdirSync(searchDir).filter(f =>
            f.includes(config.sourceArmorName) && f.includes('schematic') && f.endsWith('.lua')
        );

        for (const file of files) {
            const newFilename = replaceInFilename(file, config);
            if (alreadyCloned.has(newFilename)) continue;
            alreadyCloned.add(newFilename);

            const srcPath = path.join(searchDir, file);
            const content = fs.readFileSync(srcPath, 'utf8');
            const newContent = replaceInContent(content, config);
            const dstPath = path.join(targetDir, newFilename);

            fs.writeFileSync(dstPath, newContent, 'utf8');
            written++;
        }
    }

    // Handle loot schematic registry files
    for (const searchDir of searchDirs) {
        if (!fs.existsSync(searchDir)) continue;
        for (const regFile of ['objects.lua', 'serverobjects.lua']) {
            const regPath = path.join(searchDir, regFile);
            if (!fs.existsSync(regPath)) continue;

            const content = fs.readFileSync(regPath, 'utf8');
            if (!content.includes(config.sourceArmorName)) continue;

            const lines = content.split('\n');
            const relevantLines = lines.filter(l => l.includes(config.sourceArmorName));
            if (relevantLines.length === 0) continue;

            const newLines = relevantLines.map(l => replaceInContent(l, config));
            const targetRegPath = path.join(targetDir, regFile);

            if (fs.existsSync(targetRegPath)) {
                const existing = fs.readFileSync(targetRegPath, 'utf8');
                if (!existing.includes(config.targetArmorName)) {
                    fs.appendFileSync(targetRegPath, '\n' + newLines.join('\n') + '\n', 'utf8');
                }
            } else {
                fs.writeFileSync(targetRegPath, newLines.join('\n') + '\n', 'utf8');
                written++;
            }
        }
    }

    return { filesWritten: written, errors };
}

// ─── Build schematics registry snippet ──────────────────────────────────────

function buildSchematicsSnippet(config: DuplicateConfig): string {
    const lines = [`\t-- ${config.targetDisplayName} Armor`];
    for (const piece of ARMOR_PIECES) {
        lines.push(`\t{path="object/draft_schematic/armor/armor_${config.targetArmorName}_${piece}_schematic.iff"},`);
    }
    return lines.join('\n');
}

// ─── Build CRC paths ────────────────────────────────────────────────────────

function buildCRCPaths(config: DuplicateConfig): string[] {
    const paths: string[] = [];
    for (const piece of ARMOR_PIECES) {
        paths.push(`object/tangible/wearables/armor/${config.targetFolderName}/shared_armor_${config.targetArmorName}_${piece}.iff`);
        paths.push(`object/draft_schematic/armor/shared_armor_${config.targetArmorName}_${piece}_schematic.iff`);
        paths.push(`object/tangible/loot/loot_schematic/shared_armor_${config.targetArmorName}_${piece}_loot_schematic.iff`);
    }
    return paths;
}

// ─── Build ACM paths ────────────────────────────────────────────────────────

function buildACMPaths(config: DuplicateConfig): string[] {
    const paths: string[] = [];
    for (const piece of ARMOR_PIECES) {
        paths.push(`appearance/armor_${config.targetArmorName}_${piece}_m.sat`);
        paths.push(`appearance/armor_${config.targetArmorName}_${piece}_f.sat`);
    }
    return paths;
}

// ─── Main orchestrator ──────────────────────────────────────────────────────

export function duplicateArmorSet(
    workspace: string,
    config: DuplicateConfig,
    onProgress?: (result: DuplicateStepResult) => void
): DuplicateResult {
    const scriptsBase = path.join(workspace, 'infinity4.0.0/MMOCoreORB/bin/scripts');
    const allSteps: DuplicateStepResult[] = [];
    const allErrors: string[] = [];
    let totalFiles = 0;

    // Find source armor set info
    const armorSets = scanArmorSets(workspace);
    const sourceInfo = armorSets.find(s => s.name === config.sourceArmorName);
    if (!sourceInfo) {
        const err: DuplicateStepResult = { step: 0, label: 'Find source', success: false, message: `Source armor "${config.sourceArmorName}" not found` };
        allSteps.push(err);
        onProgress?.(err);
        return { steps: allSteps, totalFilesCreated: 0, errors: [err.message] };
    }

    // Step 1: Clone Lua armor files
    {
        const r = cloneLuaArmorDir(scriptsBase, config, sourceInfo);
        totalFiles += r.filesWritten;
        const step: DuplicateStepResult = {
            step: 1, label: 'Clone Lua armor files',
            success: r.errors.length === 0,
            message: `Wrote ${r.filesWritten} files`,
        };
        allSteps.push(step);
        allErrors.push(...r.errors);
        onProgress?.(step);
    }

    // Step 2: Clone Lua draft schematics
    {
        const r = cloneLuaSchematics(scriptsBase, config);
        totalFiles += r.filesWritten;
        const step: DuplicateStepResult = {
            step: 2, label: 'Clone Lua schematics',
            success: r.errors.length === 0,
            message: `Wrote ${r.filesWritten} files`,
        };
        allSteps.push(step);
        allErrors.push(...r.errors);
        onProgress?.(step);
    }

    // Step 3: Clone Lua loot schematics
    {
        const r = cloneLuaLootSchematics(scriptsBase, config);
        totalFiles += r.filesWritten;
        const step: DuplicateStepResult = {
            step: 3, label: 'Clone Lua loot schematics',
            success: r.errors.length === 0,
            message: `Wrote ${r.filesWritten} files`,
        };
        allSteps.push(step);
        allErrors.push(...r.errors);
        onProgress?.(step);
    }

    // Step 4: Register schematics in schematics.lua
    {
        const snippet = buildSchematicsSnippet(config);
        const r = appendSchematicsRegistry(workspace, config.targetArmorName, snippet);
        const step: DuplicateStepResult = {
            step: 4, label: 'Register schematics',
            success: r.success,
            message: r.message,
        };
        allSteps.push(step);
        if (!r.success) allErrors.push(r.message);
        onProgress?.(step);
    }

    // Step 5: Clone IFF files
    {
        const r = cloneSharedIFFs(workspace, config.sourceArmorName, config.sourceFolderName, config.targetArmorName, config.targetFolderName);
        totalFiles += r.filesCreated;
        const step: DuplicateStepResult = {
            step: 5, label: 'Clone IFF files',
            success: r.success,
            message: r.message,
        };
        allSteps.push(step);
        allErrors.push(...r.errors);
        onProgress?.(step);
    }

    // Step 6: Register CRC entries
    {
        const crcPaths = buildCRCPaths(config);
        const r = registerCRCEntries(workspace, crcPaths);
        const step: DuplicateStepResult = {
            step: 6, label: 'Register CRC entries',
            success: r.success,
            message: r.message,
        };
        allSteps.push(step);
        if (!r.success) allErrors.push(r.message);
        onProgress?.(step);
    }

    // Step 7: Clone appearance (SAT) files
    {
        const r = cloneAppearanceFiles(workspace, config.sourceArmorName, config.targetArmorName);
        totalFiles += r.filesCopied;
        const step: DuplicateStepResult = {
            step: 7, label: 'Clone appearance files',
            success: r.success,
            message: r.message,
        };
        allSteps.push(step);
        allErrors.push(...r.errors);
        onProgress?.(step);
    }

    // Step 8: Register ACM entries
    {
        const acmPaths = buildACMPaths(config);
        const r = registerACMEntries(workspace, acmPaths, config.sourceArmorName);
        const step: DuplicateStepResult = {
            step: 8, label: 'Register ACM entries',
            success: r.success,
            message: r.message,
        };
        allSteps.push(step);
        if (!r.success) allErrors.push(r.message);
        onProgress?.(step);
    }

    // Step 9: Add STF strings
    {
        const r = addSTFStrings(workspace, config.targetArmorName, config.targetDisplayName);
        const step: DuplicateStepResult = {
            step: 9, label: 'Add STF strings',
            success: r.success,
            message: r.message,
        };
        allSteps.push(step);
        allErrors.push(...r.errors);
        onProgress?.(step);
    }

    return { steps: allSteps, totalFilesCreated: totalFiles, errors: allErrors };
}
