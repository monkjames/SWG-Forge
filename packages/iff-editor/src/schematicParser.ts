/**
 * Draft Schematic Parser - Handles both IFF and Lua schematic files
 * Provides bidirectional sync between client (IFF) and server (Lua) data
 */

import * as fs from 'fs';
import * as path from 'path';

// Slot types from DraftSlot.h
export enum SlotType {
    RESOURCESLOT = 0,
    IDENTICALSLOT = 1,
    MIXEDSLOT = 2,
    OPTIONALIDENTICALSLOT = 3,
    OPTIONALMIXEDSLOT = 4
}

export interface IngredientSlot {
    templateName: string;   // e.g., "craft_weapon_ingredients_n"
    titleName: string;      // e.g., "frame_assembly"
    slotType: SlotType;
    resourceType: string;   // e.g., "iron_doonium" or "object/tangible/component/..."
    quantity: number;
    contribution: number;
}

export interface SchematicData {
    // Basic info
    customObjectName: string;
    craftingToolTab: number;
    complexity: number;
    size: number;
    factoryCrateSize: number;

    // XP
    xpType: string;
    xp: number;

    // Skills
    assemblySkill: string;
    experimentingSkill: string;
    customizationSkill: string;

    // Ingredients
    slots: IngredientSlot[];

    // Target
    targetTemplate: string;
    additionalTemplates: string[];
}

export interface SchematicComparison {
    iffData: SchematicData | null;
    luaData: SchematicData | null;
    differences: SlotDifference[];
    iffPath: string;
    luaPath: string;
    // Experimental property validation
    targetTemplatePath?: string;
    requiredExperimentalProperties?: string[];
    experimentalErrors?: ExperimentalValidation[];
}

export interface SlotDifference {
    index: number;
    field: string;
    iffValue: any;
    luaValue: any;
    severity: 'match' | 'mismatch' | 'missing_iff' | 'missing_lua';
}

export interface ExperimentalValidation {
    slotIndex: number;
    resourceType: string;
    missingProperties: string[];
    requiredProperties: string[];
    availableProperties: string[];
    errorMessage: string;
    suggestedFixes: SuggestedPropertyFix[];  // Properties the resource DOES have
}

export interface SuggestedPropertyFix {
    propertyCode: string;       // e.g., "CD"
    propertyName: string;       // e.g., "Conductivity"
    isAvailable: boolean;       // Resource has this property
}

// Keep old interface for backwards compatibility
export interface SuggestedResourceFix {
    resourceType: string;
    displayName: string;
    hasAllProperties: boolean;
    properties: string[];
}

// Property codes: CR=1, CD=2, DR=3, HR=4, FL=5, MA=6, PE=7, OQ=8, SR=9, UT=10
export const PROPERTY_NAMES: Record<string, string> = {
    'XX': 'None',
    'PO': 'None',
    'CR': 'Cold Resistance',
    'CD': 'Conductivity',
    'DR': 'Decay Resistance',
    'HR': 'Heat Resistance',
    'FL': 'Flavor',
    'MA': 'Malleability',
    'PE': 'Potential Energy',
    'OQ': 'Overall Quality',
    'SR': 'Shock Resistance',
    'UT': 'Unit Toughness'
};

// Resource type -> available properties mapping
// Based on SWG resource system
export const RESOURCE_PROPERTY_MAP: Record<string, string[]> = {
    // Organic resources - most have biological properties
    'organic': ['DR', 'FL', 'HR', 'MA', 'OQ', 'PE', 'SR', 'UT'],
    'creature_resources': ['DR', 'FL', 'HR', 'MA', 'OQ', 'PE', 'SR', 'UT'],
    'creature_food': ['FL', 'PE', 'OQ'],
    'creature_structural': ['DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
    'bone': ['DR', 'OQ', 'SR', 'MA'],
    'hide': ['DR', 'HR', 'OQ', 'SR', 'MA'],
    'meat': ['FL', 'PE', 'OQ'],
    'milk': ['FL', 'PE', 'OQ'],
    'seafood': ['FL', 'PE', 'OQ'],
    'egg': ['FL', 'PE', 'OQ'],

    // Flora - food/organic properties
    'flora_resources': ['DR', 'FL', 'HR', 'MA', 'OQ', 'PE', 'SR', 'UT'],
    'flora_food': ['FL', 'PE', 'OQ'],
    'flora_structural': ['DR', 'OQ', 'SR', 'UT'],
    'fruit': ['FL', 'PE', 'OQ'],
    'vegetable': ['FL', 'PE', 'OQ'],
    'cereal': ['FL', 'PE', 'OQ'],
    'seeds': ['FL', 'PE', 'OQ'],
    'corn': ['FL', 'PE', 'OQ'],
    'rice': ['FL', 'PE', 'OQ'],
    'wheat': ['FL', 'PE', 'OQ'],
    'oats': ['FL', 'PE', 'OQ'],
    'greens': ['FL', 'PE', 'OQ'],
    'beans': ['FL', 'PE', 'OQ'],
    'tubers': ['FL', 'PE', 'OQ'],
    'fungi': ['FL', 'PE', 'OQ'],
    'wood': ['DR', 'OQ', 'SR', 'UT'],

    // Mineral - metallic/industrial properties
    'mineral': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
    'metal': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
    'aluminum': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
    'copper': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
    'steel': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
    'iron': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
    'ore': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],

    // Non-ferrous metals
    'nonferrous_metal': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],

    // Gemstone - only OQ
    'gemstone': ['OQ'],

    // Radioactive - all properties including PE
    'radioactive': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'PE', 'SR', 'UT'],

    // Gas - limited properties
    'gas': ['OQ'],
    'reactive_gas': ['OQ'],
    'inert_gas': ['OQ'],

    // Water
    'water': ['PE', 'OQ'],

    // Energy
    'energy': ['PE', 'OQ'],

    // Polymer/Chemical
    'polymer': ['DR', 'OQ', 'SR', 'UT'],
    'lubricating_oil': ['DR', 'OQ', 'UT'],
    'chemical': ['DR', 'FL', 'OQ', 'PE', 'SR'],

    // Fiberplast
    'fiberplast': ['DR', 'OQ', 'SR', 'UT'],

    // Default for unknown resources
    'unknown': ['OQ']
};

/**
 * Get properties available for a resource type
 * Handles partial matching (e.g., "iron_doonium" matches "iron")
 */
export function getResourceProperties(resourceType: string): string[] {
    if (!resourceType) return [];

    const lowerType = resourceType.toLowerCase();

    // Check for exact match first
    if (RESOURCE_PROPERTY_MAP[lowerType]) {
        return RESOURCE_PROPERTY_MAP[lowerType];
    }

    // Check for partial matches (e.g., "iron_doonium" contains "iron")
    for (const [key, props] of Object.entries(RESOURCE_PROPERTY_MAP)) {
        if (lowerType.includes(key) || key.includes(lowerType)) {
            return props;
        }
    }

    // If it's an IFF path (component), it doesn't have resource properties
    if (lowerType.includes('object/') || lowerType.endsWith('.iff')) {
        return []; // Components don't contribute resource properties
    }

    // Default to OQ only
    return ['OQ'];
}

/**
 * Parse experimental properties from a target template Lua file
 */
export function parseTargetExperimentalProperties(luaPath: string): string[] {
    if (!fs.existsSync(luaPath)) {
        return [];
    }

    const content = fs.readFileSync(luaPath, 'utf8');

    // Extract experimentalProperties array
    const regex = /experimentalProperties\s*=\s*\{([^}]*)\}/m;
    const match = content.match(regex);
    if (!match) return [];

    const properties: string[] = [];
    const stringRegex = /"([^"]+)"/g;
    let stringMatch;
    while ((stringMatch = stringRegex.exec(match[1])) !== null) {
        const prop = stringMatch[1].toUpperCase();
        if (prop !== 'XX' && prop !== 'PO' && !properties.includes(prop)) {
            properties.push(prop);
        }
    }

    return properties;
}

/**
 * Validate experimental properties for all slots
 * Returns validation errors for slots with resource type mismatches
 */
/**
 * Find resource types that have all the required properties
 */
export function findCompatibleResourceTypes(requiredProperties: string[]): SuggestedResourceFix[] {
    const compatible: SuggestedResourceFix[] = [];

    for (const [resourceType, props] of Object.entries(RESOURCE_PROPERTY_MAP)) {
        const hasAll = requiredProperties.every(req => props.includes(req));
        if (hasAll) {
            compatible.push({
                resourceType,
                displayName: resourceType.replace(/_/g, ' '),
                hasAllProperties: true,
                properties: props
            });
        }
    }

    // Sort by number of properties (fewer = more specific)
    compatible.sort((a, b) => a.properties.length - b.properties.length);

    return compatible.slice(0, 5); // Return top 5 suggestions
}

export function validateExperimentalProperties(
    slots: IngredientSlot[],
    requiredProperties: string[]
): ExperimentalValidation[] {
    const errors: ExperimentalValidation[] = [];

    // Only validate resource slots (type 0) - component slots don't contribute properties
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];

        // Skip non-resource slots (components)
        if (slot.slotType !== SlotType.RESOURCESLOT && slot.slotType !== SlotType.MIXEDSLOT) {
            continue;
        }

        // Skip if no resource type specified
        if (!slot.resourceType || slot.resourceType.includes('object/')) {
            continue;
        }

        const availableProps = getResourceProperties(slot.resourceType);
        const missingProps: string[] = [];

        // Check which required properties are missing from this resource
        for (const reqProp of requiredProperties) {
            if (!availableProps.includes(reqProp)) {
                missingProps.push(reqProp);
            }
        }

        if (missingProps.length > 0) {
            // Suggest properties the resource DOES have as alternatives
            const suggestedFixes: SuggestedPropertyFix[] = availableProps
                .filter(prop => !requiredProperties.includes(prop)) // Only suggest ones not already required
                .map(prop => ({
                    propertyCode: prop,
                    propertyName: PROPERTY_NAMES[prop] || prop,
                    isAvailable: true
                }));

            errors.push({
                slotIndex: i,
                resourceType: slot.resourceType,
                missingProperties: missingProps,
                requiredProperties: requiredProperties,
                availableProperties: availableProps,
                errorMessage: `"${slot.resourceType}" doesn't have: ${missingProps.map(p => PROPERTY_NAMES[p] || p).join(', ')}`,
                suggestedFixes
            });
        }
    }

    return errors;
}

/**
 * Detect if an IFF file is a draft schematic based on path
 */
export function isDraftSchematic(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    return normalized.includes('/draft_schematic/') && normalized.endsWith('.iff');
}

/**
 * Find the corresponding Lua file for a draft schematic IFF
 */
export function findLuaFile(iffPath: string, workspaceRoot: string): string | null {
    // Convert IFF path to Lua path
    // IFF: tre/working/object/draft_schematic/weapon/shared_pistol_westar31b_schematic.iff
    // Lua: infinity_wicked/.../custom_scripts/object/draft_schematic/weapon/pistol_westar31b_schematic.lua

    const normalized = iffPath.replace(/\\/g, '/');

    // Extract the relative path from object/
    const match = normalized.match(/object\/draft_schematic\/(.+)\.iff$/i);
    if (!match) return null;

    let relativePath = match[1];

    // Remove "shared_" prefix if present
    relativePath = relativePath.replace(/shared_/, '');

    // Build possible Lua paths
    const luaPaths = [
        // Custom scripts location
        path.join(workspaceRoot, 'infinity_wicked/MMOCoreORB/bin/scripts/custom_scripts/object/draft_schematic', relativePath + '.lua'),
        // Standard scripts location
        path.join(workspaceRoot, 'infinity_wicked/MMOCoreORB/bin/scripts/object/draft_schematic', relativePath + '.lua'),
    ];

    for (const luaPath of luaPaths) {
        if (fs.existsSync(luaPath)) {
            return luaPath;
        }
    }

    return null;
}

/**
 * Parse ingredient slots from IFF SSIS forms
 */
export function parseIFFSlots(root: any): IngredientSlot[] {
    const slots: IngredientSlot[] = [];

    function findSISSForms(node: any): any[] {
        const results: any[] = [];

        // Ingredient slots are FORM SISS (not SSIS - note the letter order)
        if (node.type === 'form' && node.formName === 'SISS') {
            results.push(node);
        }

        if (node.children) {
            for (const child of node.children) {
                results.push(...findSISSForms(child));
            }
        }

        return results;
    }

    const sissForms = findSISSForms(root);

    for (const sissForm of sissForms) {
        const slot = parseSISSForm(sissForm);
        if (slot) {
            slots.push(slot);
        }
    }

    return slots;
}

/**
 * Parse a single SISS form into an IngredientSlot
 */
function parseSISSForm(sissForm: any): IngredientSlot | null {
    if (!sissForm.children) return null;

    let templateName = '';
    let titleName = '';
    let slotType: SlotType = SlotType.RESOURCESLOT;

    for (const child of sissForm.children) {
        if (child.type === 'chunk' && child.tag === 'XXXX' && child.data) {
            const parsed = parseSSISChunk(child.data);
            if (parsed.name === 'name') {
                templateName = parsed.templateName || '';
                titleName = parsed.titleName || '';
            } else if (parsed.name === 'hardpoint') {
                // Hardpoint chunk contains slot type info
                slotType = parsed.slotType || SlotType.RESOURCESLOT;
            }
        }
    }

    return {
        templateName,
        titleName,
        slotType,
        resourceType: '',  // Not stored in IFF SSIS, comes from Lua
        quantity: 0,       // Not stored in IFF SSIS, comes from Lua
        contribution: 100  // Default
    };
}

/**
 * Parse an SSIS XXXX chunk
 */
function parseSSISChunk(data: Uint8Array): any {
    const result: any = {};

    // Find the property name (null-terminated)
    let nameEnd = 0;
    while (nameEnd < data.length && data[nameEnd] !== 0) {
        nameEnd++;
    }

    result.name = decodeASCII(data.slice(0, nameEnd));

    if (result.name === 'name') {
        // Parse the name chunk: \x00\x01\x01templateName\x00\x01titleName\x00
        // or similar format
        let pos = nameEnd + 1;

        // Skip markers
        while (pos < data.length && (data[pos] === 0x00 || data[pos] === 0x01)) {
            pos++;
        }

        // Read template name
        let templateEnd = pos;
        while (templateEnd < data.length && data[templateEnd] !== 0) {
            templateEnd++;
        }
        result.templateName = decodeASCII(data.slice(pos, templateEnd));

        pos = templateEnd + 1;

        // Skip marker
        if (pos < data.length && data[pos] === 0x01) {
            pos++;
        }

        // Read title name
        let titleEnd = pos;
        while (titleEnd < data.length && data[titleEnd] !== 0) {
            titleEnd++;
        }
        result.titleName = decodeASCII(data.slice(pos, titleEnd));
    } else if (result.name === 'hardpoint') {
        // Parse hardpoint chunk for slot type
        let pos = nameEnd + 1;
        if (pos < data.length) {
            result.slotType = data[pos] as SlotType;
        }
    }

    return result;
}

/**
 * Parse a Lua schematic file
 */
export function parseLuaSchematic(luaPath: string): SchematicData | null {
    if (!fs.existsSync(luaPath)) {
        return null;
    }

    const content = fs.readFileSync(luaPath, 'utf8');

    try {
        return {
            customObjectName: extractLuaString(content, 'customObjectName') || '',
            craftingToolTab: extractLuaNumber(content, 'craftingToolTab') || 0,
            complexity: extractLuaNumber(content, 'complexity') || 0,
            size: extractLuaNumber(content, 'size') || 0,
            factoryCrateSize: extractLuaNumber(content, 'factoryCrateSize') || 0,
            xpType: extractLuaString(content, 'xpType') || '',
            xp: extractLuaNumber(content, 'xp') || 0,
            assemblySkill: extractLuaString(content, 'assemblySkill') || '',
            experimentingSkill: extractLuaString(content, 'experimentingSkill') || '',
            customizationSkill: extractLuaString(content, 'customizationSkill') || '',
            slots: extractLuaSlots(content),
            targetTemplate: extractLuaString(content, 'targetTemplate') || '',
            additionalTemplates: extractLuaStringArray(content, 'additionalTemplates') || []
        };
    } catch (e) {
        console.error('Failed to parse Lua schematic:', e);
        return null;
    }
}

/**
 * Extract ingredient slots from Lua content
 */
function extractLuaSlots(content: string): IngredientSlot[] {
    const templateNames = extractLuaStringArray(content, 'ingredientTemplateNames') || [];
    const titleNames = extractLuaStringArray(content, 'ingredientTitleNames') || [];
    const slotTypes = extractLuaNumberArray(content, 'ingredientSlotType') || [];
    const resourceTypes = extractLuaStringArray(content, 'resourceTypes') || [];
    const quantities = extractLuaNumberArray(content, 'resourceQuantities') || [];
    const contributions = extractLuaNumberArray(content, 'contribution') || [];

    const slots: IngredientSlot[] = [];
    const maxLen = Math.max(
        templateNames.length,
        titleNames.length,
        slotTypes.length,
        resourceTypes.length
    );

    for (let i = 0; i < maxLen; i++) {
        slots.push({
            templateName: templateNames[i] || '',
            titleName: titleNames[i] || '',
            slotType: slotTypes[i] as SlotType || SlotType.RESOURCESLOT,
            resourceType: resourceTypes[i] || '',
            quantity: quantities[i] || 0,
            contribution: contributions[i] || 100
        });
    }

    return slots;
}

/**
 * Extract a string value from Lua content
 */
function extractLuaString(content: string, key: string): string | null {
    const regex = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'm');
    const match = content.match(regex);
    return match ? match[1] : null;
}

/**
 * Extract a number value from Lua content
 */
function extractLuaNumber(content: string, key: string): number | null {
    const regex = new RegExp(`${key}\\s*=\\s*([\\d.]+)`, 'm');
    const match = content.match(regex);
    return match ? parseFloat(match[1]) : null;
}

/**
 * Extract a string array from Lua content
 */
function extractLuaStringArray(content: string, key: string): string[] {
    const regex = new RegExp(`${key}\\s*=\\s*\\{([^}]*)\\}`, 'm');
    const match = content.match(regex);
    if (!match) return [];

    const arrayContent = match[1];
    const items: string[] = [];

    // Match quoted strings
    const stringRegex = /"([^"]*)"/g;
    let stringMatch;
    while ((stringMatch = stringRegex.exec(arrayContent)) !== null) {
        items.push(stringMatch[1]);
    }

    return items;
}

/**
 * Extract a number array from Lua content
 */
function extractLuaNumberArray(content: string, key: string): number[] {
    const regex = new RegExp(`${key}\\s*=\\s*\\{([^}]*)\\}`, 'm');
    const match = content.match(regex);
    if (!match) return [];

    const arrayContent = match[1];
    const items: number[] = [];

    // Match numbers (including decimals)
    const numberRegex = /(\d+\.?\d*)/g;
    let numMatch;
    while ((numMatch = numberRegex.exec(arrayContent)) !== null) {
        items.push(parseFloat(numMatch[1]));
    }

    return items;
}

/**
 * Compare IFF and Lua schematic data
 */
export function compareSchematic(iffData: SchematicData | null, luaData: SchematicData | null): SlotDifference[] {
    const differences: SlotDifference[] = [];

    if (!iffData && !luaData) return differences;

    const iffSlots = iffData?.slots || [];
    const luaSlots = luaData?.slots || [];

    const maxLen = Math.max(iffSlots.length, luaSlots.length);

    for (let i = 0; i < maxLen; i++) {
        const iffSlot = iffSlots[i];
        const luaSlot = luaSlots[i];

        if (!iffSlot && luaSlot) {
            differences.push({
                index: i,
                field: 'slot',
                iffValue: null,
                luaValue: luaSlot.titleName,
                severity: 'missing_iff'
            });
            continue;
        }

        if (iffSlot && !luaSlot) {
            differences.push({
                index: i,
                field: 'slot',
                iffValue: iffSlot.titleName,
                luaValue: null,
                severity: 'missing_lua'
            });
            continue;
        }

        if (iffSlot && luaSlot) {
            // Compare titleName
            if (iffSlot.titleName !== luaSlot.titleName) {
                differences.push({
                    index: i,
                    field: 'titleName',
                    iffValue: iffSlot.titleName,
                    luaValue: luaSlot.titleName,
                    severity: 'mismatch'
                });
            }

            // Compare templateName
            if (iffSlot.templateName !== luaSlot.templateName) {
                differences.push({
                    index: i,
                    field: 'templateName',
                    iffValue: iffSlot.templateName,
                    luaValue: luaSlot.templateName,
                    severity: 'mismatch'
                });
            }

            // Compare slotType
            if (iffSlot.slotType !== luaSlot.slotType) {
                differences.push({
                    index: i,
                    field: 'slotType',
                    iffValue: iffSlot.slotType,
                    luaValue: luaSlot.slotType,
                    severity: 'mismatch'
                });
            }
        }
    }

    return differences;
}

/**
 * Generate Lua content from schematic data
 */
export function generateLuaContent(data: SchematicData, objectName: string, iffPath: string): string {
    const templateNames = data.slots.map(s => `"${s.templateName}"`).join(', ');
    const titleNames = data.slots.map(s => `"${s.titleName}"`).join(', ');
    const slotTypes = data.slots.map(s => s.slotType).join(', ');
    const resourceTypes = data.slots.map(s => `"${s.resourceType}"`).join(', ');
    const quantities = data.slots.map(s => s.quantity).join(', ');
    const contributions = data.slots.map(s => s.contribution).join(', ');

    return `${objectName} = ${objectName.replace(/_schematic$/, '')}_shared_schematic:new {

	templateType = DRAFTSCHEMATIC,

	customObjectName = "${data.customObjectName}",

	craftingToolTab = ${data.craftingToolTab}, -- (See DraftSchematicObjectTemplate.h)
	complexity = ${data.complexity},
	size = ${data.size},
	factoryCrateSize = ${data.factoryCrateSize},

	xpType = "${data.xpType}",
	xp = ${data.xp},

	assemblySkill = "${data.assemblySkill}",
	experimentingSkill = "${data.experimentingSkill}",
	customizationSkill = "${data.customizationSkill}",

	customizationOptions = {},
	customizationStringNames = {},
	customizationDefaults = {},

	ingredientTemplateNames = {${templateNames}},
	ingredientTitleNames = {${titleNames}},
	ingredientSlotType = {${slotTypes}},
	resourceTypes = {${resourceTypes}},
	resourceQuantities = {${quantities}},
	contribution = {${contributions}},

	targetTemplate = "${data.targetTemplate}",

	additionalTemplates = {}

}
ObjectTemplates:addTemplate(${objectName}, "${iffPath}")
`;
}

// Helper function
function decodeASCII(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) break;
        result += String.fromCharCode(bytes[i]);
    }
    return result;
}

// ============================================================================
// STRING VALIDATION - Validates STF string references in schematics
// ============================================================================

export interface StringValidationError {
    slotIndex: number;
    field: 'templateName' | 'titleName';
    stfFile: string;
    stfKey: string;
    errorMessage: string;
}

export interface StringValidationResult {
    errors: StringValidationError[];
    warnings: StringValidationError[];
    valid: boolean;
}

/**
 * Validate that all ingredient string references exist in STF files
 *
 * TODO: Implement STF file reading
 * - Parse STF binary format or use exported CSV files
 * - Check if templateName keys exist in their STF files
 * - Check if titleName keys exist in their STF files
 * - Return validation errors for missing strings
 *
 * @param slots - Ingredient slots to validate
 * @param stfBasePath - Base path to string/en/ folder
 * @returns Validation result with errors and warnings
 */
export function validateSlotStrings(
    slots: IngredientSlot[],
    stfBasePath: string
): StringValidationResult {
    const errors: StringValidationError[] = [];
    const warnings: StringValidationError[] = [];

    // TODO: Implement string validation
    // For each slot:
    //   1. Parse templateName to get STF file (e.g., "craft_weapon_ingredients_n")
    //   2. Check if titleName key exists in that STF file
    //   3. If not found, add to errors
    //
    // Example:
    //   templateName: "craft_weapon_ingredients_n"
    //   titleName: "frame_assembly"
    //   -> Check string/en/craft_weapon_ingredients_n.stf for key "frame_assembly"

    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];

        if (!slot.templateName) {
            warnings.push({
                slotIndex: i,
                field: 'templateName',
                stfFile: '',
                stfKey: slot.titleName,
                errorMessage: `Slot ${i + 1}: No template name specified`
            });
        }

        // TODO: Actually check if the string exists in the STF file
        // const stfPath = path.join(stfBasePath, slot.templateName + '.stf');
        // const stfContent = parseSTF(stfPath);
        // if (!stfContent.has(slot.titleName)) {
        //     errors.push({ ... });
        // }
    }

    return {
        errors,
        warnings,
        valid: errors.length === 0
    };
}

// ============================================================================
// CRAFTING SIMULATOR - Simulates crafting outcomes with given resource stats
// ============================================================================

export interface ResourceStats {
    /** Overall Quality (0-1000) */
    OQ: number;
    /** Conductivity (0-1000) */
    CD?: number;
    /** Cold Resistance (0-1000) */
    CR?: number;
    /** Decay Resistance (0-1000) */
    DR?: number;
    /** Heat Resistance (0-1000) */
    HR?: number;
    /** Flavor (0-1000) */
    FL?: number;
    /** Malleability (0-1000) */
    MA?: number;
    /** Potential Energy (0-1000) */
    PE?: number;
    /** Shock Resistance (0-1000) */
    SR?: number;
    /** Unit Toughness (0-1000) */
    UT?: number;
}

export interface ComponentStats {
    /** Pre-crafted component quality multiplier (0.0-1.0) */
    quality: number;
    /** Experimental attributes from the component */
    attributes: Record<string, number>;
}

export interface SlotInput {
    slotIndex: number;
    /** For resource slots */
    resourceStats?: ResourceStats;
    /** For component slots */
    componentStats?: ComponentStats;
}

export interface ExperimentalAttribute {
    name: string;
    displayName: string;
    minValue: number;
    maxValue: number;
    precision: number;
    combineType: CombineType;
    /** Which properties contribute to this attribute */
    contributingProperties: string[];
    /** Weights for each contributing property */
    propertyWeights: number[];
}

export enum CombineType {
    RESOURCE = 0,      // Average based on resource quality
    LINEAR = 1,        // Linear interpolation
    PERCENTAGE = 2,    // Percentage-based
    BITSET = 3,        // Bitwise combination
    OVERRIDE = 4,      // Last value wins
    LIMITED = 5        // Capped combination
}

export interface CraftingResult {
    /** Calculated experimental attribute values */
    attributes: Record<string, {
        assemblyValue: number;
        minPossible: number;
        maxPossible: number;
        experimentRange: number;
    }>;
    /** Overall assembly success chance */
    assemblySuccessChance: number;
    /** Risk assessment */
    riskLevel: 'low' | 'medium' | 'high';
    /** Detailed breakdown per slot */
    slotContributions: Array<{
        slotIndex: number;
        contributionPercent: number;
        qualityImpact: number;
    }>;
}

/**
 * Simulate crafting with given resource/component inputs
 *
 * TODO: Implement crafting simulation
 * - Calculate initial assembly values based on resource stats
 * - Apply contribution percentages
 * - Handle different combine types
 * - Calculate experimentation ranges
 *
 * @param schematic - The schematic being crafted
 * @param experimentalAttributes - Target template's experimental definitions
 * @param inputs - Resource/component stats for each slot
 * @returns Simulated crafting result
 */
export function simulateCrafting(
    schematic: SchematicData,
    experimentalAttributes: ExperimentalAttribute[],
    inputs: SlotInput[]
): CraftingResult {
    // TODO: Implement crafting simulation
    //
    // Algorithm overview:
    // 1. For each experimental attribute:
    //    a. Get contributing properties (e.g., OQ, CD)
    //    b. For each slot:
    //       - Get resource stats for contributing properties
    //       - Weight by property weights
    //       - Weight by slot contribution percentage
    //    c. Combine slot contributions based on combineType
    //    d. Calculate assembly value within min/max range
    //
    // 2. Calculate experimentation range:
    //    - Based on assembly skill
    //    - Max improvement = (max - assemblyValue) * experimentBonus
    //
    // 3. Risk assessment:
    //    - Low: all resources > 900 OQ
    //    - Medium: all resources > 500 OQ
    //    - High: any resource < 500 OQ

    const result: CraftingResult = {
        attributes: {},
        assemblySuccessChance: 0.95, // Placeholder
        riskLevel: 'low',
        slotContributions: []
    };

    // Placeholder: calculate basic contributions
    for (let i = 0; i < schematic.slots.length; i++) {
        const slot = schematic.slots[i];
        const input = inputs.find(inp => inp.slotIndex === i);

        result.slotContributions.push({
            slotIndex: i,
            contributionPercent: slot.contribution,
            qualityImpact: input?.resourceStats?.OQ || input?.componentStats?.quality || 0
        });
    }

    // Placeholder: calculate attribute values
    for (const attr of experimentalAttributes) {
        result.attributes[attr.name] = {
            assemblyValue: (attr.minValue + attr.maxValue) / 2,
            minPossible: attr.minValue,
            maxPossible: attr.maxValue,
            experimentRange: (attr.maxValue - attr.minValue) * 0.1
        };
    }

    return result;
}

/**
 * Parse experimental attributes from a target template Lua file
 *
 * TODO: Implement full experimental attribute parsing
 * - Extract numberExperimentalProperties
 * - Extract experimentalProperties (property codes)
 * - Extract experimentalWeights
 * - Extract experimentalGroupTitles
 * - Extract experimentalSubGroupTitles
 * - Extract experimentalMin/Max
 * - Extract experimentalPrecision
 * - Extract experimentalCombineType
 *
 * @param luaPath - Path to target template Lua file
 * @returns Array of experimental attribute definitions
 */
export function parseExperimentalAttributes(luaPath: string): ExperimentalAttribute[] {
    if (!fs.existsSync(luaPath)) {
        return [];
    }

    const content = fs.readFileSync(luaPath, 'utf8');
    const attributes: ExperimentalAttribute[] = [];

    // TODO: Implement full parsing
    // For now, just extract the property codes we already have
    const properties = parseTargetExperimentalProperties(luaPath);

    // Create placeholder attributes
    for (const prop of properties) {
        attributes.push({
            name: prop,
            displayName: PROPERTY_NAMES[prop] || prop,
            minValue: 0,
            maxValue: 100,
            precision: 0,
            combineType: CombineType.RESOURCE,
            contributingProperties: [prop],
            propertyWeights: [1]
        });
    }

    return attributes;
}
