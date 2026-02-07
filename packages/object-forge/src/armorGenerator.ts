/**
 * Armor Set Generator
 *
 * Generates all Lua files needed for a complete armor set:
 * - 10 armor piece templates
 * - 10 draft schematics
 * - 10 loot schematics
 * - objects.lua (shared templates)
 * - serverobjects.lua (includes)
 * - Entries for managers/crafting/schematics.lua
 *
 * Based on bounty_hunter_crafted armor set patterns.
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ArmorConfig {
    // Basic identity
    armorName: string;       // e.g. "nightsister_crafted" (no spaces, lowercase with underscores)
    displayName: string;     // e.g. "Nightsister" (for comments and custom names)
    folderName: string;      // e.g. "nightsister" (TRE subfolder under armor/)

    // Armor stats
    rating: 'LIGHT' | 'MEDIUM' | 'HEAVY';
    maxCondition: number;

    // Resistances (base values)
    kinetic: number;
    energy: number;
    electricity: number;
    stun: number;
    blast: number;
    heat: number;
    cold: number;
    acid: number;
    lightSaber: number;

    // Vulnerability flags (sum of damage type constants)
    vulnerability: string;    // e.g. "ACID + STUN + LIGHTSABER"
    specialResist?: string;   // e.g. "LIGHTSABER" (optional)

    // Encumbrance (base values - these vary per piece)
    healthEncumbrance: number;
    actionEncumbrance: number;
    mindEncumbrance: number;

    // Crafting
    xp: number;
    requiredSkill?: string;                 // For loot schematics
    certificationsRequired?: string[];      // Optional cert requirements
    customizationVariable?: string;         // e.g. "/private/index_color_1"

    // Ingredients (9 slots for standard armor)
    ingredients: ArmorIngredient[];

    // Experimentation (per-piece overrides)
    perPieceStats?: Partial<Record<ArmorPiece, PieceOverrides>>;
}

export interface ArmorIngredient {
    titleName: string;       // e.g. "auxilary_coverage"
    slotType: 0 | 1;        // 0 = resource, 1 = component
    resourceType: string;    // e.g. "ore_intrusive" or "object/tangible/component/..."
    quantity: number;
}

export interface PieceOverrides {
    healthEncumbrance?: number;
    actionEncumbrance?: number;
    mindEncumbrance?: number;
    experimentalMin?: number[];
    experimentalMax?: number[];
}

export type ArmorPiece = 'helmet' | 'chest_plate' | 'leggings' | 'boots' | 'belt' |
    'gloves' | 'bracer_l' | 'bracer_r' | 'bicep_l' | 'bicep_r';

export const ARMOR_PIECES: ArmorPiece[] = [
    'helmet', 'chest_plate', 'leggings', 'boots', 'belt',
    'gloves', 'bracer_l', 'bracer_r', 'bicep_l', 'bicep_r'
];

export interface GeneratedFiles {
    armorPieces: { piece: ArmorPiece; path: string; content: string }[];
    schematics: { piece: ArmorPiece; path: string; content: string }[];
    lootSchematics: { piece: ArmorPiece; path: string; content: string }[];
    objectsLua: { path: string; content: string };
    serverObjectsLua: { path: string; content: string };
    schematicObjectsLua: { path: string; content: string };
    schematicServerObjectsLua: { path: string; content: string };
    lootSchematicObjectsLua: { path: string; content: string };
    lootSchematicServerObjectsLua: { path: string; content: string };
    schematicsRegistrySnippet: string;
    crcPaths: string[];  // All IFF paths that need CRC table entries
    acmPaths: string[];  // Appearance paths for ACM registration
    summary: string;
}

// ─── Player races (standard list) ──────────────────────────────────────────────

const PLAYER_RACES = [
    '"object/creature/player/bothan_male.iff"',
    '"object/creature/player/bothan_female.iff"',
    '"object/creature/player/human_male.iff"',
    '"object/creature/player/human_female.iff"',
    '"object/creature/player/moncal_male.iff"',
    '"object/creature/player/moncal_female.iff"',
    '"object/creature/player/rodian_male.iff"',
    '"object/creature/player/rodian_female.iff"',
    '"object/creature/player/sullustan_male.iff"',
    '"object/creature/player/sullustan_female.iff"',
    '"object/creature/player/trandoshan_male.iff"',
    '"object/creature/player/trandoshan_female.iff"',
    '"object/creature/player/twilek_male.iff"',
    '"object/creature/player/twilek_female.iff"',
    '"object/creature/player/zabrak_male.iff"',
    '"object/creature/player/zabrak_female.iff"',
    '"object/creature/player/chiss_male.iff"',
    '"object/creature/player/chiss_female.iff"',
].concat([
    '"object/mobile/vendor/aqualish_female.iff"',
    '"object/mobile/vendor/aqualish_male.iff"',
    '"object/mobile/vendor/bothan_female.iff"',
    '"object/mobile/vendor/bothan_male.iff"',
    '"object/mobile/vendor/devaronian_male.iff"',
    '"object/mobile/vendor/human_female.iff"',
    '"object/mobile/vendor/human_male.iff"',
    '"object/mobile/vendor/moncal_female.iff"',
    '"object/mobile/vendor/moncal_male.iff"',
    '"object/mobile/vendor/nikto_male.iff"',
    '"object/mobile/vendor/rodian_female.iff"',
    '"object/mobile/vendor/rodian_male.iff"',
    '"object/mobile/vendor/sullustan_female.iff"',
    '"object/mobile/vendor/sullustan_male.iff"',
    '"object/mobile/vendor/trandoshan_female.iff"',
    '"object/mobile/vendor/trandoshan_male.iff"',
    '"object/mobile/vendor/twilek_female.iff"',
    '"object/mobile/vendor/twilek_male.iff"',
    '"object/mobile/vendor/weequay_male.iff"',
    '"object/mobile/vendor/zabrak_female.iff"',
    '"object/mobile/vendor/zabrak_male.iff"',
    '"object/mobile/vendor/chiss_female.iff"',
    '"object/mobile/vendor/chiss_male.iff"',
]);

// ─── Default experimental data (standard armor pattern) ─────────────────────────

const DEFAULT_EXP = {
    numberExperimentalProperties: [1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 2, 1],
    experimentalProperties: ['XX', 'XX', 'XX', 'XX', 'OQ', 'SR', 'OQ', 'UT', 'MA', 'OQ', 'MA', 'OQ', 'MA', 'OQ', 'XX', 'XX', 'OQ', 'SR', 'XX'],
    experimentalWeights: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    experimentalGroupTitles: ['null', 'null', 'null', 'exp_durability', 'exp_quality', 'exp_resistance', 'exp_durability', 'exp_durability', 'exp_durability', 'null', 'null', 'exp_resistance', 'null'],
    experimentalSubGroupTitles: ['null', 'null', 'sockets', 'hit_points', 'armor_effectiveness', 'armor_integrity', 'armor_health_encumbrance', 'armor_action_encumbrance', 'armor_mind_encumbrance', 'armor_rating', 'armor_special_type', 'armor_special_effectiveness', 'armor_special_integrity'],
    experimentalPrecision: [0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 10, 0],
    experimentalCombineType: [0, 0, 4, 1, 1, 1, 1, 1, 1, 4, 4, 4, 1],
};

// Default min/max per piece type (index 6=health_enc, 7=action_enc, 8=mind_enc)
const PIECE_DEFAULTS: Record<ArmorPiece, { min: number[]; max: number[] }> = {
    helmet:      { min: [0, 0, 0, 1000, 45, 30000, 22, 22, 188, 1, 0, 5, 0], max: [0, 0, 0, 1000, 55, 50000, 13, 13, 113, 1, 0, 30, 0] },
    chest_plate: { min: [0, 0, 0, 1000, 45, 30000, 219, 66, 16, 1, 0, 5, 0], max: [0, 0, 0, 1000, 55, 50000, 131, 39, 9, 1, 0, 30, 0] },
    leggings:    { min: [0, 0, 0, 1000, 45, 30000, 109, 109, 66, 1, 0, 5, 0], max: [0, 0, 0, 1000, 55, 50000, 65, 65, 39, 1, 0, 30, 0] },
    boots:       { min: [0, 0, 0, 1000, 45, 30000, 22, 22, 16, 1, 0, 5, 0], max: [0, 0, 0, 1000, 55, 50000, 13, 13, 9, 1, 0, 30, 0] },
    belt:        { min: [0, 0, 0, 1000, 45, 30000, 22, 22, 16, 1, 0, 5, 0], max: [0, 0, 0, 1000, 55, 50000, 13, 13, 9, 1, 0, 30, 0] },
    gloves:      { min: [0, 0, 0, 1000, 45, 30000, 22, 22, 16, 1, 0, 5, 0], max: [0, 0, 0, 1000, 55, 50000, 13, 13, 9, 1, 0, 30, 0] },
    bracer_l:    { min: [0, 0, 0, 1000, 45, 30000, 22, 22, 16, 1, 0, 5, 0], max: [0, 0, 0, 1000, 55, 50000, 13, 13, 9, 1, 0, 30, 0] },
    bracer_r:    { min: [0, 0, 0, 1000, 45, 30000, 22, 22, 16, 1, 0, 5, 0], max: [0, 0, 0, 1000, 55, 50000, 13, 13, 9, 1, 0, 30, 0] },
    bicep_l:     { min: [0, 0, 0, 1000, 45, 30000, 22, 22, 16, 1, 0, 5, 0], max: [0, 0, 0, 1000, 55, 50000, 13, 13, 9, 1, 0, 30, 0] },
    bicep_r:     { min: [0, 0, 0, 1000, 45, 30000, 22, 22, 16, 1, 0, 5, 0], max: [0, 0, 0, 1000, 55, 50000, 13, 13, 9, 1, 0, 30, 0] },
};

// ─── Generator ──────────────────────────────────────────────────────────────────

export function generateArmorSet(config: ArmorConfig): GeneratedFiles {
    const result: GeneratedFiles = {
        armorPieces: [],
        schematics: [],
        lootSchematics: [],
        objectsLua: { path: '', content: '' },
        serverObjectsLua: { path: '', content: '' },
        schematicObjectsLua: { path: '', content: '' },
        schematicServerObjectsLua: { path: '', content: '' },
        lootSchematicObjectsLua: { path: '', content: '' },
        lootSchematicServerObjectsLua: { path: '', content: '' },
        schematicsRegistrySnippet: '',
        crcPaths: [],
        acmPaths: [],
        summary: '',
    };

    const customDir = `custom_scripts/object/tangible/wearables/armor/${config.armorName}`;
    const schematicDir = `custom_scripts/object/draft_schematic/armor`;
    const lootDir = `custom_scripts/object/tangible/loot/loot_schematic/wearables`;

    // TRE paths use folderName for the IFF structure
    const treArmorBase = `object/tangible/wearables/armor/${config.folderName}`;
    const treSchematicBase = `object/draft_schematic/armor`;
    const treLootBase = `object/tangible/loot/loot_schematic`;

    let objectsContent = `-- ${config.displayName} Armor - Shared Templates\n\n`;
    let serverObjContent = `-- ${config.displayName} Armor - Server Objects\n`;
    let schematicObjContent = `-- ${config.displayName} Armor Schematics - Shared Templates\n\n`;
    let schematicServerContent = `-- ${config.displayName} Armor Schematics - Server Objects\n`;
    let lootObjContent = `-- ${config.displayName} Armor Loot Schematics - Shared Templates\n\n`;
    let lootServerContent = `-- ${config.displayName} Armor Loot Schematics - Server Objects\n`;
    let registryLines: string[] = [];

    for (const piece of ARMOR_PIECES) {
        const pieceName = `armor_${config.armorName}_${piece}`;
        const schematicName = `armor_${config.armorName}_${piece}_schematic`;
        const lootName = `armor_${config.armorName}_${piece}_loot_schematic`;

        // IFF paths (for TRE/CRC)
        const armorIffPath = `${treArmorBase}/armor_${config.armorName}_${piece}.iff`;
        const sharedArmorIff = `${treArmorBase}/shared_armor_${config.armorName}_${piece}.iff`;
        const schematicIffPath = `${treSchematicBase}/${schematicName}.iff`;
        const sharedSchematicIff = `${treSchematicBase}/shared_${schematicName}.iff`;
        const lootIffPath = `${treLootBase}/${lootName}.iff`;
        const sharedLootIff = `${treLootBase}/shared_${lootName}.iff`;

        result.crcPaths.push(sharedArmorIff, sharedSchematicIff, sharedLootIff);

        // Lua variable names
        const armorVar = `object_tangible_wearables_armor_${config.armorName}_${pieceName}`;
        const sharedArmorVar = `object_tangible_wearables_armor_${config.armorName}_shared_${pieceName}`;
        const schematicVar = `object_draft_schematic_armor_${schematicName}`;
        const sharedSchematicVar = `object_draft_schematic_armor_shared_${schematicName}`;
        const lootVar = `object_tangible_loot_loot_schematic_${lootName}`;
        const sharedLootVar = `object_tangible_loot_loot_schematic_shared_${lootName}`;

        // 1. Armor piece template
        result.armorPieces.push({
            piece,
            path: `${customDir}/${pieceName}.lua`,
            content: generateArmorPiece(config, piece, armorVar, sharedArmorVar, armorIffPath),
        });

        // 2. Draft schematic
        result.schematics.push({
            piece,
            path: `${schematicDir}/${schematicName}.lua`,
            content: generateSchematic(config, piece, schematicVar, sharedSchematicVar, schematicIffPath, armorIffPath),
        });

        // 3. Loot schematic
        result.lootSchematics.push({
            piece,
            path: `${lootDir}/${lootName}.lua`,
            content: generateLootSchematic(config, lootVar, sharedLootVar, lootIffPath, schematicIffPath),
        });

        // objects.lua entries
        objectsContent += generateSharedTemplate(sharedArmorVar, 'SharedTangibleObjectTemplate', sharedArmorIff) + '\n';
        schematicObjContent += generateSharedTemplate(sharedSchematicVar, 'SharedDraftSchematicObjectTemplate', sharedSchematicIff) + '\n';
        lootObjContent += generateSharedTemplate(sharedLootVar, 'SharedTangibleObjectTemplate', sharedLootIff) + '\n';

        // serverobjects.lua entries
        serverObjContent += `includeFile("../custom_scripts/object/tangible/wearables/armor/${config.armorName}/${pieceName}.lua")\n`;
        schematicServerContent += `includeFile("../custom_scripts/object/draft_schematic/armor/${schematicName}.lua")\n`;
        lootServerContent += `includeFile("../custom_scripts/object/tangible/loot/loot_schematic/wearables/${lootName}.lua")\n`;

        // Schematics registry
        registryLines.push(`\t{path="${schematicIffPath}"},`);
    }

    result.objectsLua = { path: `${customDir}/objects.lua`, content: objectsContent };
    result.serverObjectsLua = { path: `${customDir}/serverobjects.lua`, content: serverObjContent };
    result.schematicObjectsLua = { path: `${schematicDir}/objects.lua`, content: schematicObjContent };
    result.schematicServerObjectsLua = { path: `${schematicDir}/serverobjects.lua`, content: schematicServerContent };
    result.lootSchematicObjectsLua = { path: `${lootDir}/objects.lua`, content: lootObjContent };
    result.lootSchematicServerObjectsLua = { path: `${lootDir}/serverobjects.lua`, content: lootServerContent };

    result.schematicsRegistrySnippet = `\t-- ${config.displayName} Armor\n` + registryLines.join('\n');

    // ACM appearance paths (SAT files for male/female)
    for (const piece of ARMOR_PIECES) {
        result.acmPaths.push(`appearance/armor_${config.armorName}_${piece}_m.sat`);
        result.acmPaths.push(`appearance/armor_${config.armorName}_${piece}_f.sat`);
    }

    // Summary
    const totalFiles = result.armorPieces.length + result.schematics.length + result.lootSchematics.length + 6;
    result.summary = [
        `=== ${config.displayName} Armor Set ===`,
        `Armor pieces: ${result.armorPieces.length}`,
        `Draft schematics: ${result.schematics.length}`,
        `Loot schematics: ${result.lootSchematics.length}`,
        `Registry files: 6 (objects.lua + serverobjects.lua x3)`,
        `Total Lua files: ${totalFiles}`,
        `CRC entries needed: ${result.crcPaths.length}`,
        `ACM entries needed: ${result.acmPaths.length}`,
        ``,
        `Schematics registry snippet (add to managers/crafting/schematics.lua):`,
        result.schematicsRegistrySnippet,
    ].join('\n');

    return result;
}

// ─── Individual file generators ─────────────────────────────────────────────────

function generateArmorPiece(
    config: ArmorConfig, piece: ArmorPiece,
    varName: string, sharedVarName: string, iffPath: string
): string {
    const overrides = config.perPieceStats?.[piece] || {};
    const hEnc = overrides.healthEncumbrance ?? config.healthEncumbrance;
    const aEnc = overrides.actionEncumbrance ?? config.actionEncumbrance;
    const mEnc = overrides.mindEncumbrance ?? config.mindEncumbrance;

    const defaults = PIECE_DEFAULTS[piece];
    const expMin = overrides.experimentalMin || defaults.min;
    const expMax = overrides.experimentalMax || defaults.max;

    const lines: string[] = [];
    lines.push(`${varName} = ${sharedVarName}:new {`);
    lines.push(`\ttemplateType = ARMOROBJECT,`);
    lines.push(`\tobjectMenuComponent = "ArmorObjectMenuComponent",`);

    if (config.certificationsRequired && config.certificationsRequired.length > 0) {
        lines.push(`\tcertificationsRequired = { ${config.certificationsRequired.map(c => `"${c}"`).join(', ')} },`);
    }

    lines.push(`\tplayerRaces = { ${PLAYER_RACES.join(',\n\t\t\t\t')} },`);
    lines.push('');
    lines.push(`\tvulnerability = ${config.vulnerability},`);
    if (config.specialResist) {
        lines.push(`\tspecialResist = ${config.specialResist},`);
    }
    lines.push('');
    lines.push(`\thealthEncumbrance = ${hEnc},`);
    lines.push(`\tactionEncumbrance = ${aEnc},`);
    lines.push(`\tmindEncumbrance = ${mEnc},`);
    lines.push('');
    lines.push(`\tmaxCondition = ${config.maxCondition},`);
    lines.push(`\trating = ${config.rating},`);
    lines.push('');
    lines.push(`\tkinetic = ${config.kinetic},`);
    lines.push(`\tenergy = ${config.energy},`);
    lines.push(`\telectricity = ${config.electricity},`);
    lines.push(`\tstun = ${config.stun},`);
    lines.push(`\tblast = ${config.blast},`);
    lines.push(`\theat = ${config.heat},`);
    lines.push(`\tcold = ${config.cold},`);
    lines.push(`\tacid = ${config.acid},`);
    if (config.lightSaber > 0) {
        lines.push(`\tlightSaber = ${config.lightSaber},`);
    }
    lines.push('');

    // Experimental data
    lines.push(`\tnumberExperimentalProperties = {${DEFAULT_EXP.numberExperimentalProperties.join(', ')}},`);
    lines.push(`\texperimentalProperties = {${DEFAULT_EXP.experimentalProperties.map(s => `"${s}"`).join(', ')}},`);
    lines.push(`\texperimentalWeights = {${DEFAULT_EXP.experimentalWeights.join(', ')}},`);
    lines.push(`\texperimentalGroupTitles = {${DEFAULT_EXP.experimentalGroupTitles.map(s => `"${s}"`).join(', ')}},`);
    lines.push(`\texperimentalSubGroupTitles = {${DEFAULT_EXP.experimentalSubGroupTitles.map(s => `"${s}"`).join(', ')}},`);
    lines.push(`\texperimentalMin = {${expMin.join(', ')}},`);
    lines.push(`\texperimentalMax = {${expMax.join(', ')}},`);
    lines.push(`\texperimentalPrecision = {${DEFAULT_EXP.experimentalPrecision.join(', ')}},`);
    lines.push(`\texperimentalCombineType = {${DEFAULT_EXP.experimentalCombineType.join(', ')}},`);
    lines.push('}');
    lines.push('');
    lines.push(`ObjectTemplates:addTemplate(${varName}, "${iffPath}")`);

    return lines.join('\n');
}

function generateSchematic(
    config: ArmorConfig, piece: ArmorPiece,
    varName: string, sharedVarName: string,
    schematicIffPath: string, targetIffPath: string
): string {
    const custVar = config.customizationVariable || '/private/index_color_1';

    const lines: string[] = [];
    lines.push(`${varName} = ${sharedVarName}:new {`);
    lines.push('');
    lines.push(`\ttemplateType = DRAFTSCHEMATIC,`);
    lines.push('');
    lines.push(`\tcustomObjectName = "",`);
    lines.push(`\tfactoryCrateSize = 0,`);
    lines.push(`\tcraftingToolTab = 2,`);
    lines.push(`\tcomplexity = 1,`);
    lines.push(`\tsize = 4,`);
    lines.push('');
    lines.push(`\txpType = "crafting_clothing_armor",`);
    lines.push(`\txp = ${config.xp},`);
    lines.push('');
    lines.push(`\tassemblySkill = "armor_assembly",`);
    lines.push(`\texperimentingSkill = "armor_experimentation",`);
    lines.push(`\tcustomizationSkill = "armor_customization",`);
    lines.push('');
    lines.push(`\tcustomizationOptions = {2},`);
    lines.push(`\tcustomizationStringNames = {"${custVar}"},`);
    lines.push(`\tcustomizationDefaults = {0},`);
    lines.push('');

    // Ingredients
    const templateNames = config.ingredients.map(() => '"craft_clothing_ingredients_n"');
    const titleNames = config.ingredients.map(i => `"${i.titleName}"`);
    const slotTypes = config.ingredients.map(i => i.slotType);
    const resourceTypes = config.ingredients.map(i => `"${i.resourceType}"`);
    const quantities = config.ingredients.map(i => i.quantity);
    const contributions = config.ingredients.map(() => 100);

    lines.push(`\tingredientTemplateNames = {${templateNames.join(', ')}},`);
    lines.push(`\tingredientTitleNames = {${titleNames.join(', ')}},`);
    lines.push(`\tingredientSlotType = {${slotTypes.join(', ')}},`);
    lines.push(`\tresourceTypes = {${resourceTypes.join(', ')}},`);
    lines.push(`\tresourceQuantities = {${quantities.join(', ')}},`);
    lines.push(`\tcontribution = {${contributions.join(', ')}},`);
    lines.push('');
    lines.push(`\ttargetTemplate = "${targetIffPath}",`);
    lines.push('');
    lines.push(`\tadditionalTemplates = {}`);
    lines.push('}');
    lines.push('');
    lines.push(`ObjectTemplates:addTemplate(${varName}, "${schematicIffPath}")`);

    return lines.join('\n');
}

function generateLootSchematic(
    config: ArmorConfig,
    varName: string, sharedVarName: string,
    lootIffPath: string, targetSchematicIffPath: string
): string {
    const reqSkill = config.requiredSkill || 'crafting_armorsmith_master';

    const lines: string[] = [];
    lines.push(`${varName} = ${sharedVarName}:new {`);
    lines.push(`\ttemplateType = LOOTSCHEMATIC,`);
    lines.push(`\tobjectMenuComponent = "LootSchematicMenuComponent",`);
    lines.push(`\tattributeListComponent = "LootSchematicAttributeListComponent",`);
    lines.push(`\trequiredSkill = "${reqSkill}",`);
    lines.push(`\ttargetDraftSchematic = "${targetSchematicIffPath}",`);
    lines.push(`\ttargetUseCount = 5`);
    lines.push('}');
    lines.push('');
    lines.push(`ObjectTemplates:addTemplate(${varName}, "${lootIffPath}")`);

    return lines.join('\n');
}

function generateSharedTemplate(varName: string, templateClass: string, iffPath: string): string {
    return [
        `${varName} = ${templateClass}:new {`,
        `\tclientTemplateFileName = "${iffPath}"`,
        `}`,
        '',
        `ObjectTemplates:addClientTemplate(${varName}, "${iffPath}")`,
        '',
    ].join('\n');
}

// ─── Default config for quick start ─────────────────────────────────────────────

export function getDefaultArmorConfig(): ArmorConfig {
    return {
        armorName: 'custom_crafted',
        displayName: 'Custom',
        folderName: 'custom',
        rating: 'LIGHT',
        maxCondition: 30000,
        kinetic: 15,
        energy: 15,
        electricity: 15,
        stun: 45,
        blast: 15,
        heat: 15,
        cold: 15,
        acid: 15,
        lightSaber: 25,
        vulnerability: 'ACID + STUN + LIGHTSABER',
        specialResist: 'LIGHTSABER',
        healthEncumbrance: 1,
        actionEncumbrance: 1,
        mindEncumbrance: 1,
        xp: 550,
        requiredSkill: 'crafting_armorsmith_master',
        customizationVariable: '/private/index_color_1',
        ingredients: [
            { titleName: 'auxilary_coverage', slotType: 0, resourceType: 'ore_intrusive', quantity: 75 },
            { titleName: 'body', slotType: 0, resourceType: 'fuel_petrochem_solid_known', quantity: 75 },
            { titleName: 'liner', slotType: 0, resourceType: 'fiberplast_naboo', quantity: 38 },
            { titleName: 'hardware_and_attachments', slotType: 0, resourceType: 'aluminum', quantity: 45 },
            { titleName: 'binding_and_reinforcement', slotType: 0, resourceType: 'copper_beyrllius', quantity: 30 },
            { titleName: 'padding', slotType: 0, resourceType: 'hide_wooly', quantity: 30 },
            { titleName: 'armor', slotType: 1, resourceType: 'object/tangible/component/armor/shared_armor_segment_composite.iff', quantity: 3 },
            { titleName: 'load_bearing_harness', slotType: 1, resourceType: 'object/tangible/component/clothing/shared_synthetic_cloth.iff', quantity: 1 },
            { titleName: 'reinforcement', slotType: 1, resourceType: 'object/tangible/component/clothing/shared_reinforced_fiber_panels.iff', quantity: 1 },
        ],
    };
}
