/**
 * Complete clothing generation - wearables, schematics, ACM, everything
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    cloneIFFWithReplacements, parseSTF, serializeSTF, addSTFEntries,
    parseCRCTable, addCRCEntries, serializeCRCTable, parseACM, serializeACM
} from '@swgemu/core';
import type { StringReplacement, StringEntry, STFData} from '@swgemu/core';
import type { ClothingType, ClothingStats } from './clothingTypes';
import { generateDraftSchematic, generateLootSchematic, type SchematicPaths } from './schematicGenerator';

export interface ClothingConfig {
    // Appearance
    appearancePath: string;

    // Target
    clothingType: ClothingType;
    objectName: string;
    displayName: string;
    description: string;

    // Stats
    stats: ClothingStats;

    // Crafting (if isCrafted=true)
    isCrafted: boolean;
    skill?: string;
    complexity?: number;
    xp?: number;
    lootSchematicUses?: number;

    // Customization
    colorSlots: number;
    selectedPalettes: string[];  // Palette file paths

    // Paths
    referenceIffPath: string;
    treWorking: string;
    treInfinity: string;
    scriptsPath: string;
    customScriptsPath: string;
}

export interface GenerationResult {
    created: string[];
    modified: string[];
    errors: string[];
}

/**
 * Generate complete clothing item with all supporting files
 */
export function generateClothing(config: ClothingConfig): GenerationResult {
    const result: GenerationResult = { created: [], modified: [], errors: [] };

    try {
        // 1. Generate wearable item (server + shared Lua)
        generateWearableItem(config, result);

        // 2. Clone and update IFF files
        generateIFF(config, result);

        // 3. STF strings
        generateSTF(config, result);

        // 4. CRC registration
        updateCRC(config, result);

        // 5. ACM customization entries
        if (config.selectedPalettes.length > 0) {
            updateACM(config, result);
        }

        // 6. If crafted: generate schematics
        if (config.isCrafted && config.skill) {
            generateSchematics(config, result);
        }
    } catch (e: any) {
        result.errors.push('Generation failed: ' + e.message);
    }

    return result;
}

// ── Wearable Item Generation ────────────────────────────────────────

function generateWearableItem(config: ClothingConfig, result: GenerationResult): void {
    const wearableDir = path.join(config.customScriptsPath, config.clothingType.folder);
    fs.mkdirSync(wearableDir, { recursive: true });

    // ── Server template ──
    const serverLua = buildWearableLua(config);
    const serverPath = path.join(wearableDir, config.objectName + '.lua');
    fs.writeFileSync(serverPath, serverLua);
    result.created.push(serverPath);

    // ── Shared template ──
    const sharedLua = buildWearableShared(config);
    const objectsPath = path.join(wearableDir, 'objects.lua');
    if (fs.existsSync(objectsPath)) {
        fs.appendFileSync(objectsPath, '\n' + sharedLua);
        result.modified.push(objectsPath);
    } else {
        fs.writeFileSync(objectsPath, sharedLua);
        result.created.push(objectsPath);
    }

    // ── Register in serverobjects.lua ──
    const serverObjectsPath = path.join(wearableDir, 'serverobjects.lua');
    const customFolder = config.customScriptsPath.split('/').pop();
    const includeLine = `includeFile("../${customFolder}/${config.clothingType.folder}/${config.objectName}.lua")\n`;
    if (fs.existsSync(serverObjectsPath)) {
        fs.appendFileSync(serverObjectsPath, includeLine);
        result.modified.push(serverObjectsPath);
    } else {
        fs.writeFileSync(serverObjectsPath, includeLine);
        result.created.push(serverObjectsPath);
    }
}

function buildWearableLua(config: ClothingConfig): string {
    const varPrefix = config.clothingType.folder.replace(/\//g, '_');
    const varName = varPrefix + '_' + config.objectName;
    const sharedVar = varPrefix + '_shared_' + config.objectName;
    const iffPath = config.clothingType.folder + '/' + config.objectName + '.iff';

    const lines: string[] = [];
    lines.push(`${varName} = ${sharedVar}:new {`);

    // Experimentation properties
    lines.push('\tnumberExperimentalProperties = {1, 1, 1, 1},');
    lines.push('\texperimentalProperties = {"XX", "XX", "XX", "XX"},');
    lines.push('\texperimentalWeights = {1, 1, 1, 1},');
    lines.push('\texperimentalGroupTitles = {"null", "null", "null", "null"},');
    lines.push('\texperimentalSubGroupTitles = {"null", "null", "sockets", "hitpoints"},');
    lines.push(`\texperimentalMin = {0, 0, 0, ${config.stats.hitpoints}},`);
    lines.push(`\texperimentalMax = {0, 0, 0, ${config.stats.hitpoints}},`);
    lines.push('\texperimentalPrecision = {0, 0, 0, 0},');
    lines.push('\texperimentalCombineType = {0, 0, 4, 4},');

    // Player races (all)
    lines.push('\tplayerRaces = {');
    lines.push('\t\t"object/creature/player/bothan_male.iff",');
    lines.push('\t\t"object/creature/player/bothan_female.iff",');
    lines.push('\t\t"object/creature/player/human_male.iff",');
    lines.push('\t\t"object/creature/player/human_female.iff",');
    lines.push('\t\t"object/creature/player/ithorian_male.iff",');
    lines.push('\t\t"object/creature/player/ithorian_female.iff",');
    lines.push('\t\t"object/creature/player/moncal_male.iff",');
    lines.push('\t\t"object/creature/player/moncal_female.iff",');
    lines.push('\t\t"object/creature/player/rodian_male.iff",');
    lines.push('\t\t"object/creature/player/rodian_female.iff",');
    lines.push('\t\t"object/creature/player/trandoshan_male.iff",');
    lines.push('\t\t"object/creature/player/trandoshan_female.iff",');
    lines.push('\t\t"object/creature/player/twilek_male.iff",');
    lines.push('\t\t"object/creature/player/twilek_female.iff",');
    lines.push('\t\t"object/creature/player/wookiee_male.iff",');
    lines.push('\t\t"object/creature/player/wookiee_female.iff",');
    lines.push('\t\t"object/creature/player/zabrak_male.iff",');
    lines.push('\t\t"object/creature/player/zabrak_female.iff",');
    lines.push('\t},');

    lines.push('}');
    lines.push('');
    lines.push(`ObjectTemplates:addTemplate(${varName}, "${iffPath}")`);
    lines.push('');

    return lines.join('\n');
}

function buildWearableShared(config: ClothingConfig): string {
    const varPrefix = config.clothingType.folder.replace(/\//g, '_');
    const sharedVar = varPrefix + '_shared_' + config.objectName;
    const sharedIff = config.clothingType.folder + '/shared_' + config.objectName + '.iff';

    return `-- ${config.objectName}\n${sharedVar} = SharedTangibleObjectTemplate:new {
\tclientTemplateFileName = "${sharedIff}"
}
ObjectTemplates:addClientTemplate(${sharedVar}, "${sharedIff}")
`;
}

// ── IFF Generation ──────────────────────────────────────────────────

function generateIFF(config: ClothingConfig, result: GenerationResult): void {
    const refData = fs.readFileSync(config.referenceIffPath);
    const refBytes = new Uint8Array(refData);

    // Build replacements for appearance and strings
    const replacements: StringReplacement[] = [];

    // TODO: Parse reference IFF to find current appearance/STF refs
    // For now, just clone the IFF - full STF replacement will be added later
    replacements.push({
        oldString: 'placeholder_appearance',
        newString: config.appearancePath
    });

    const cloned = cloneIFFWithReplacements(refBytes, replacements);

    // Write shared IFF
    const iffDir = path.join(config.treWorking, config.clothingType.folder);
    fs.mkdirSync(iffDir, { recursive: true });
    const iffPath = path.join(iffDir, 'shared_' + config.objectName + '.iff');
    fs.writeFileSync(iffPath, Buffer.from(cloned));
    result.created.push(iffPath);
}

// ── STF Generation ──────────────────────────────────────────────────

function generateSTF(config: ClothingConfig, result: GenerationResult): void {
    const stfName = 'clothing_custom';

    // Name STF
    writeSTFEntry(config, stfName + '_n', config.objectName, config.displayName, result);

    // Description STF
    writeSTFEntry(config, stfName + '_d', config.objectName, config.description, result);

    // If crafted: add schematic strings
    if (config.isCrafted) {
        const draftName = 'clothing_' + config.objectName;
        const lootName = config.objectName + '_schematic';

        writeSTFEntry(config, stfName + '_n', draftName, config.displayName + ' Schematic', result);
        writeSTFEntry(config, stfName + '_d', draftName, 'A schematic for crafting ' + config.displayName, result);

        writeSTFEntry(config, stfName + '_n', lootName, config.displayName + ' Schematic (Loot)', result);
        writeSTFEntry(config, stfName + '_d', lootName, 'Use this to unlock the ' + config.displayName + ' schematic', result);
    }
}

function writeSTFEntry(config: ClothingConfig, stfName: string, id: string, value: string, result: GenerationResult): void {
    const stfRelPath = 'string/en/custom_content/' + stfName + '.stf';
    const workingPath = path.join(config.treWorking, stfRelPath);
    const infinityPath = path.join(config.treInfinity, stfRelPath);

    let stf: STFData;
    let isNew = false;

    if (fs.existsSync(workingPath)) {
        stf = parseSTF(new Uint8Array(fs.readFileSync(workingPath)));
    } else if (fs.existsSync(infinityPath)) {
        stf = parseSTF(new Uint8Array(fs.readFileSync(infinityPath)));
    } else {
        stf = { version: 1, nextUid: 1, entries: [] };
        isNew = true;
    }

    const entries: StringEntry[] = [{ id, value }];
    addSTFEntries(stf, entries);

    fs.mkdirSync(path.dirname(workingPath), { recursive: true });
    fs.writeFileSync(workingPath, Buffer.from(serializeSTF(stf)));

    if (isNew) {
        result.created.push(workingPath);
    } else if (!result.modified.includes(workingPath)) {
        result.modified.push(workingPath);
    }
}

// ── CRC Registration ────────────────────────────────────────────────

function updateCRC(config: ClothingConfig, result: GenerationResult): void {
    const crcRelPath = 'misc/object_template_crc_string_table.iff';
    const workingCrc = path.join(config.treWorking, crcRelPath);
    const infinityCrc = path.join(config.treInfinity, crcRelPath);

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

    const paths: string[] = [
        config.clothingType.folder + '/shared_' + config.objectName + '.iff'
    ];

    if (config.isCrafted) {
        paths.push('object/draft_schematic/clothing/shared_clothing_' + config.objectName + '.iff');
        paths.push('object/tangible/loot/loot_schematic/shared_' + config.objectName + '_schematic.iff');
    }

    const added = addCRCEntries(table, paths);
    if (added.length > 0) {
        fs.writeFileSync(crcPath, Buffer.from(serializeCRCTable(table)));
        if (!result.modified.includes(crcPath)) {
            result.modified.push(crcPath);
        }
    }
}

// ── ACM Customization ───────────────────────────────────────────────

function updateACM(config: ClothingConfig, result: GenerationResult): void {
    const acmRelPath = 'customization/asset_customization_manager.iff';
    const workingAcm = path.join(config.treWorking, acmRelPath);
    const infinityAcm = path.join(config.treInfinity, acmRelPath);

    let acmPath: string;
    if (fs.existsSync(workingAcm)) {
        acmPath = workingAcm;
    } else if (fs.existsSync(infinityAcm)) {
        fs.mkdirSync(path.dirname(workingAcm), { recursive: true });
        fs.copyFileSync(infinityAcm, workingAcm);
        acmPath = workingAcm;
    } else {
        result.errors.push('No ACM file found');
        return;
    }

    // TODO: Implement ACM entry addition
    // For now, just note that ACM update is needed
    result.errors.push('ACM update not yet implemented - manual ACM entry required for palette: ' + config.selectedPalettes.join(', '));
}

// ── Schematic Generation ────────────────────────────────────────────

function generateSchematics(config: ClothingConfig, result: GenerationResult): void {
    const schematicPaths: SchematicPaths = {
        scriptsPath: config.scriptsPath,
        customScriptsPath: config.customScriptsPath,
    };

    const schematicConfig = {
        objectName: config.objectName,
        displayName: config.displayName,
        description: config.description,
        targetTemplate: config.clothingType.folder + '/' + config.objectName + '.iff',
        clothingType: config.clothingType,
        skill: config.skill || 'crafting_tailor_master',
        complexity: config.complexity || 1,
        xp: config.xp || 90,
        colorSlots: config.colorSlots,
        lootSchematicUses: config.lootSchematicUses || 1,
    };

    // Draft schematic
    const draftResult = generateDraftSchematic(schematicPaths, schematicConfig);
    result.created.push(...draftResult.created);
    result.modified.push(...draftResult.modified);

    // Loot schematic
    const lootResult = generateLootSchematic(schematicPaths, schematicConfig);
    result.created.push(...lootResult.created);
    result.modified.push(...lootResult.modified);
}
