/**
 * Generates draft schematics and loot schematics for clothing
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ClothingType, IngredientSlot } from './clothingTypes';

export interface SchematicConfig {
    objectName: string;
    displayName: string;
    description: string;
    targetTemplate: string;
    clothingType: ClothingType;
    skill: string;
    complexity: number;
    xp: number;
    colorSlots: number;
    lootSchematicUses: number;
}

export interface SchematicPaths {
    scriptsPath: string;
    customScriptsPath: string;
}

/**
 * Generate draft schematic Lua files (server + shared)
 */
export function generateDraftSchematic(
    paths: SchematicPaths,
    config: SchematicConfig
): { created: string[]; modified: string[] } {
    const created: string[] = [];
    const modified: string[] = [];

    const draftName = 'clothing_' + config.objectName;
    const draftPath = 'object/draft_schematic/clothing';
    const draftDir = path.join(paths.customScriptsPath, draftPath);

    // Create directory
    fs.mkdirSync(draftDir, { recursive: true });

    // ── Server template ──
    const serverLua = buildDraftSchematicLua(config, draftName, draftPath);
    const serverPath = path.join(draftDir, draftName + '.lua');
    fs.writeFileSync(serverPath, serverLua);
    created.push(serverPath);

    // ── Shared template ──
    const sharedLua = buildDraftSchematicShared(draftName, draftPath);
    const objectsPath = path.join(draftDir, 'objects.lua');
    if (fs.existsSync(objectsPath)) {
        fs.appendFileSync(objectsPath, '\n' + sharedLua);
        modified.push(objectsPath);
    } else {
        fs.writeFileSync(objectsPath, sharedLua);
        created.push(objectsPath);
    }

    // ── Register in serverobjects.lua ──
    const serverObjectsPath = path.join(draftDir, 'serverobjects.lua');
    const includeLine = `includeFile("../custom_scripts/${draftPath}/${draftName}.lua")\n`;
    if (fs.existsSync(serverObjectsPath)) {
        fs.appendFileSync(serverObjectsPath, includeLine);
        modified.push(serverObjectsPath);
    } else {
        fs.writeFileSync(serverObjectsPath, includeLine);
        created.push(serverObjectsPath);
    }

    return { created, modified };
}

/**
 * Generate loot schematic Lua files (server + shared)
 */
export function generateLootSchematic(
    paths: SchematicPaths,
    config: SchematicConfig
): { created: string[]; modified: string[] } {
    const created: string[] = [];
    const modified: string[] = [];

    const lootName = config.objectName + '_schematic';
    const lootPath = 'object/tangible/loot/loot_schematic';
    const lootDir = path.join(paths.customScriptsPath, lootPath);

    fs.mkdirSync(lootDir, { recursive: true });

    // ── Server template ──
    const draftSchematicPath = `object/draft_schematic/clothing/clothing_${config.objectName}.iff`;
    const serverLua = buildLootSchematicLua(config, lootName, lootPath, draftSchematicPath);
    const serverPath = path.join(lootDir, lootName + '.lua');
    fs.writeFileSync(serverPath, serverLua);
    created.push(serverPath);

    // ── Shared template ──
    const sharedLua = buildLootSchematicShared(lootName, lootPath);
    const objectsPath = path.join(lootDir, 'objects.lua');
    if (fs.existsSync(objectsPath)) {
        fs.appendFileSync(objectsPath, '\n' + sharedLua);
        modified.push(objectsPath);
    } else {
        fs.writeFileSync(objectsPath, sharedLua);
        created.push(objectsPath);
    }

    // ── Register in serverobjects.lua ──
    const serverObjectsPath = path.join(lootDir, 'serverobjects.lua');
    const includeLine = `includeFile("../custom_scripts/${lootPath}/${lootName}.lua")\n`;
    if (fs.existsSync(serverObjectsPath)) {
        fs.appendFileSync(serverObjectsPath, includeLine);
        modified.push(serverObjectsPath);
    } else {
        fs.writeFileSync(serverObjectsPath, includeLine);
        created.push(serverObjectsPath);
    }

    return { created, modified };
}

// ── Draft Schematic Lua Builder ─────────────────────────────────────

function buildDraftSchematicLua(config: SchematicConfig, draftName: string, draftPath: string): string {
    const varName = draftPath.replace(/\//g, '_') + '_' + draftName;
    const sharedVar = draftPath.replace(/\//g, '_') + '_shared_' + draftName;

    const ingredientTitles = config.clothingType.ingredientSlots.map(s => `"${s.title}"`).join(', ');
    const resourceTypes = config.clothingType.ingredientSlots.map(s => `"${s.resourceType}"`).join(', ');
    const resourceQuantities = config.clothingType.ingredientSlots.map(s => s.quantity).join(', ');
    const contributions = config.clothingType.ingredientSlots.map(s => s.contribution).join(', ');
    const slotTypes = config.clothingType.ingredientSlots.map(() => '0').join(', ');

    const customizationBlock = config.colorSlots > 1
        ? `\tcustomizationOptions = {2, 2},\n\tcustomizationStringNames = {"/private/index_color_1", "/private/index_color_2"},\n\tcustomizationDefaults = {19, 19},\n`
        : `\tcustomizationOptions = {2},\n\tcustomizationStringNames = {"/private/index_color_1"},\n\tcustomizationDefaults = {19},\n`;

    return `${varName} = ${sharedVar}:new {
\ttemplateType = DRAFTSCHEMATIC,
\tcustomObjectName = "${config.displayName}",
\tcraftingToolTab = ${config.clothingType.craftingTab},
\tcomplexity = ${config.complexity},
\tsize = 3,
\tfactoryCrateType = "object/factory/factory_crate_clothing.iff",

\txpType = "crafting_general",
\txp = ${config.xp},

\tassemblySkill = "general_assembly",
\texperimentingSkill = "general_experimentation",
\tcustomizationSkill = "clothing_customization",

${customizationBlock}
\tingredientTemplateNames = {"craft_clothing_ingredients_n", "craft_clothing_ingredients_n", "craft_clothing_ingredients_n"},
\tingredientTitleNames = {${ingredientTitles}},
\tingredientSlotType = {${slotTypes}},
\tresourceTypes = {${resourceTypes}},
\tresourceQuantities = {${resourceQuantities}},
\tcontribution = {${contributions}},

\ttargetTemplate = "${config.targetTemplate}",
\tadditionalTemplates = {}
}

ObjectTemplates:addTemplate(${varName}, "${draftPath}/${draftName}.iff")
`;
}

function buildDraftSchematicShared(draftName: string, draftPath: string): string {
    const sharedVar = draftPath.replace(/\//g, '_') + '_shared_' + draftName;
    return `-- ${draftName}\n${sharedVar} = SharedDraftSchematicObjectTemplate:new {
\tclientTemplateFileName = "${draftPath}/shared_${draftName}.iff"
}
ObjectTemplates:addClientTemplate(${sharedVar}, "${draftPath}/shared_${draftName}.iff")
`;
}

// ── Loot Schematic Lua Builder ──────────────────────────────────────

function buildLootSchematicLua(config: SchematicConfig, lootName: string, lootPath: string, draftSchematicPath: string): string {
    const varName = lootPath.replace(/\//g, '_') + '_' + lootName;
    const sharedVar = lootPath.replace(/\//g, '_') + '_shared_' + lootName;

    return `${varName} = ${sharedVar}:new {
\ttemplateType = LOOTSCHEMATIC,
\tobjectMenuComponent = "LootSchematicMenuComponent",
\tattributeListComponent = "LootSchematicAttributeListComponent",

\trequiredSkill = "${config.skill}",
\ttargetDraftSchematic = "${draftSchematicPath}",
\ttargetUseCount = ${config.lootSchematicUses}
}

ObjectTemplates:addTemplate(${varName}, "${lootPath}/${lootName}.iff")
`;
}

function buildLootSchematicShared(lootName: string, lootPath: string): string {
    const sharedVar = lootPath.replace(/\//g, '_') + '_shared_' + lootName;
    return `-- ${lootName}\n${sharedVar} = SharedTangibleObjectTemplate:new {
\tclientTemplateFileName = "${lootPath}/shared_${lootName}.iff"
}
ObjectTemplates:addClientTemplate(${sharedVar}, "${lootPath}/shared_${lootName}.iff")
`;
}
