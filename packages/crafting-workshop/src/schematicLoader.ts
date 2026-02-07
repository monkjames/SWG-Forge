/**
 * Schematic Loader - Handles loading and linking schematic-related files
 *
 * A crafting project consists of:
 * - Draft Schematic IFF (client-side appearance/structure)
 * - Draft Schematic Lua (server-side behavior/ingredients)
 * - Target Template Lua (the crafted item's properties)
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// INTERFACES
// ============================================================================

export interface IngredientSlot {
    templateName: string;   // e.g., "craft_weapon_ingredients_n"
    titleName: string;      // e.g., "frame_assembly"
    slotType: number;       // 0=resource, 1=identical, 2=mixed, etc.
    resourceType: string;   // e.g., "iron_doonium" or component path
    quantity: number;
    contribution: number;   // 0-100
}

export interface SchematicData {
    customObjectName: string;
    craftingToolTab: number;
    complexity: number;
    size: number;
    factoryCrateSize: number;
    xpType: string;
    xp: number;
    assemblySkill: string;
    experimentingSkill: string;
    customizationSkill: string;
    slots: IngredientSlot[];
    targetTemplate: string;
}

export interface ResourceWeightInfo {
    stat: string;       // e.g., "DR"
    weight: number;     // raw weight value
    percentage: number; // calculated percentage (0-100)
}

export interface AttributeWeights {
    attribute: string;              // e.g., "power"
    group: string;                  // e.g., "exp_effectiveness"
    resourceWeights: ResourceWeightInfo[];
}

export interface BlueFrogDefaults {
    // Medicine properties
    useCount?: number;
    effectiveness?: number;
    duration?: number;
    medicineUse?: number;
    // Weapon properties
    minDamage?: number;
    maxDamage?: number;
    attackSpeed?: number;
    healthAttackCost?: number;
    actionAttackCost?: number;
    mindAttackCost?: number;
    woundsRatio?: number;
    // Armor properties
    armorRating?: number;
    kinetic?: number;
    energy?: number;
    electricity?: number;
    stun?: number;
    blast?: number;
    heat?: number;
    cold?: number;
    acid?: number;
    lightSaber?: number;
}

// Mapping between blue frog properties and experimental attributes
export const BLUEFROG_EXPERIMENTAL_MAP: Record<string, string> = {
    'useCount': 'charges',
    'effectiveness': 'power',
    'minDamage': 'mindamage',
    'maxDamage': 'maxdamage',
    'attackSpeed': 'attackspeed',
    'woundsRatio': 'woundchance',
    'healthAttackCost': 'attackhealthcost',
    'actionAttackCost': 'attackactioncost',
    'mindAttackCost': 'attackmindcost',
};

// Reverse mapping: experimental attribute -> blue frog property
export const EXPERIMENTAL_BLUEFROG_MAP: Record<string, string> = {
    'charges': 'useCount',
    'power': 'effectiveness',
    'mindamage': 'minDamage',
    'maxdamage': 'maxDamage',
    'attackspeed': 'attackSpeed',
    'woundchance': 'woundsRatio',
    'attackhealthcost': 'healthAttackCost',
    'attackactioncost': 'actionAttackCost',
    'attackmindcost': 'mindAttackCost',
};

// Object types for Blue Frog defaults inference
export type ObjectType = 'medicine' | 'weapon' | 'armor' | 'food' | 'component' | 'unknown';

// Default Blue Frog properties by object type
export const BLUEFROG_DEFAULTS_BY_TYPE: Record<ObjectType, Partial<BlueFrogDefaults>> = {
    medicine: {
        useCount: 5,
        effectiveness: 50,
        duration: 30,
        medicineUse: 0,
    },
    weapon: {
        minDamage: 50,
        maxDamage: 100,
        attackSpeed: 1.0,
        healthAttackCost: 50,
        actionAttackCost: 50,
        mindAttackCost: 0,
        woundsRatio: 0,
    },
    armor: {
        armorRating: 0,
        kinetic: 0,
        energy: 0,
        electricity: 0,
        stun: 0,
        blast: 0,
        heat: 0,
        cold: 0,
        acid: 0,
        lightSaber: 0,
    },
    food: {
        // Food-specific defaults (TBD)
    },
    component: {
        // Component defaults depend on type
    },
    unknown: {},
};

export interface TargetTemplateData {
    numberExperimentalProperties: number[];
    experimentalProperties: string[];
    experimentalWeights: number[];
    experimentalGroupTitles: string[];
    experimentalSubGroupTitles: string[];
    experimentalMin: number[];
    experimentalMax: number[];
    experimentalPrecision: number[];
    experimentalCombineType: number[];
    // Calculated: which resource stats matter for each attribute
    attributeWeights: AttributeWeights[];
    // Calculated: all resource stats that matter for ANY attribute
    usedResourceStats: string[];
    // Blue frog default values (non-crafted baseline)
    blueFrogDefaults: BlueFrogDefaults;
    // Track which blue frog values were inferred vs explicit in file
    blueFrogInferred: Set<string>;
    // Detected object type
    objectType: ObjectType;
}

export interface SchematicProject {
    schematicIffPath: string | null;
    schematicLuaPath: string | null;
    targetTemplatePath: string | null;
    schematic: SchematicData;
    targetTemplate: TargetTemplateData | null;
}

// ============================================================================
// VALIDATION
// ============================================================================

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationResult {
    severity: ValidationSeverity;
    category: string;
    message: string;
    file?: string;
    line?: number;
    fix?: string;  // Suggested fix
}

export interface ValidationReport {
    passed: boolean;
    errors: number;
    warnings: number;
    infos: number;
    results: ValidationResult[];
}

// ============================================================================
// LOADER
// ============================================================================

export class SchematicLoader {
    /**
     * Load a complete schematic project from any related file
     */
    static loadProject(filePath: string, workspaceRoot: string): SchematicProject {
        const normalized = filePath.replace(/\\/g, '/');
        const isIff = normalized.endsWith('.iff');
        const isLua = normalized.endsWith('.lua');

        if (!isIff && !isLua) {
            throw new Error('File must be an IFF or Lua file');
        }

        // Determine file roles based on path
        let schematicIffPath: string | null = null;
        let schematicLuaPath: string | null = null;

        if (normalized.includes('/draft_schematic/')) {
            if (isIff) {
                schematicIffPath = filePath;
                schematicLuaPath = this.findMatchingLua(filePath, workspaceRoot);
            } else {
                schematicLuaPath = filePath;
                schematicIffPath = this.findMatchingIff(filePath, workspaceRoot);
            }
        } else {
            throw new Error('File does not appear to be a draft schematic');
        }

        // Parse schematic data
        let schematic: SchematicData;
        if (schematicLuaPath && fs.existsSync(schematicLuaPath)) {
            schematic = this.parseLuaSchematic(schematicLuaPath);
        } else {
            // Minimal data from IFF only
            schematic = {
                customObjectName: path.basename(filePath, path.extname(filePath)),
                craftingToolTab: 0,
                complexity: 0,
                size: 0,
                factoryCrateSize: 0,
                xpType: '',
                xp: 0,
                assemblySkill: '',
                experimentingSkill: '',
                customizationSkill: '',
                slots: [],
                targetTemplate: ''
            };
        }

        // Find and parse target template
        let targetTemplatePath: string | null = null;
        let targetTemplate: TargetTemplateData | null = null;

        if (schematic.targetTemplate) {
            targetTemplatePath = this.findTargetTemplate(schematic.targetTemplate, workspaceRoot);
            if (targetTemplatePath) {
                targetTemplate = this.parseTargetTemplate(targetTemplatePath);
            }
        }

        return {
            schematicIffPath,
            schematicLuaPath,
            targetTemplatePath,
            schematic,
            targetTemplate
        };
    }

    /**
     * Validate a loaded schematic project
     */
    static validateProject(project: SchematicProject, workspaceRoot: string): ValidationReport {
        const results: ValidationResult[] = [];

        // ========================================
        // SCHEMATIC LUA VALIDATIONS
        // ========================================

        if (!project.schematicLuaPath) {
            results.push({
                severity: 'error',
                category: 'Schematic Lua',
                message: 'No schematic Lua file found',
                fix: 'Create a Lua file in custom_scripts/object/draft_schematic/'
            });
        } else {
            // Check targetTemplate path exists
            if (!project.schematic.targetTemplate) {
                results.push({
                    severity: 'error',
                    category: 'Schematic Lua',
                    message: 'targetTemplate is not defined',
                    file: project.schematicLuaPath,
                    fix: 'Add targetTemplate = "object/tangible/..." to the schematic'
                });
            } else if (!project.targetTemplatePath) {
                results.push({
                    severity: 'error',
                    category: 'Schematic Lua',
                    message: `targetTemplate "${project.schematic.targetTemplate}" does not exist`,
                    file: project.schematicLuaPath,
                    fix: 'Create the target template Lua file or fix the path'
                });
            }

            // Check slot array consistency
            const slotCount = project.schematic.slots.length;
            if (slotCount === 0) {
                results.push({
                    severity: 'warning',
                    category: 'Schematic Lua',
                    message: 'No ingredient slots defined',
                    file: project.schematicLuaPath
                });
            }

            // Check contribution values - calculate complexity based on deviation from 100
            const contributions = project.schematic.slots.map(s => s.contribution);
            const totalContribution = contributions.reduce((sum, c) => sum + c, 0);

            if (totalContribution === 0 && slotCount > 0) {
                results.push({
                    severity: 'warning',
                    category: 'Schematic Lua',
                    message: 'All contribution values are 0 - resources will not affect crafted stats',
                    file: project.schematicLuaPath,
                    fix: 'Set contribution values for each slot'
                });
            } else if (slotCount > 0) {
                // Calculate complexity: sum of absolute deviations from 100
                const complexityScore = contributions.reduce((sum, c) => sum + Math.abs(c - 100), 0);

                let complexityLevel: string;
                let severity: ValidationSeverity = 'info';

                if (complexityScore === 0) {
                    complexityLevel = 'Simple (all slots equal)';
                } else if (complexityScore < 100) {
                    complexityLevel = 'Normal';
                } else if (complexityScore < 200) {
                    complexityLevel = 'Moderate';
                } else {
                    complexityLevel = 'High';
                }

                results.push({
                    severity,
                    category: 'Schematic Lua',
                    message: `Contribution complexity: ${complexityLevel} (score: ${complexityScore})`,
                    file: project.schematicLuaPath
                });
            }

            // Check required skills
            if (!project.schematic.assemblySkill) {
                results.push({
                    severity: 'warning',
                    category: 'Schematic Lua',
                    message: 'assemblySkill is not defined',
                    file: project.schematicLuaPath
                });
            }
            if (!project.schematic.experimentingSkill) {
                results.push({
                    severity: 'warning',
                    category: 'Schematic Lua',
                    message: 'experimentingSkill is not defined',
                    file: project.schematicLuaPath
                });
            }
        }

        // ========================================
        // TARGET TEMPLATE VALIDATIONS
        // ========================================

        if (project.targetTemplate && project.targetTemplatePath) {
            const tt = project.targetTemplate;

            // Check array length consistency
            const groupCount = tt.experimentalGroupTitles.length;
            const subGroupCount = tt.experimentalSubGroupTitles.length;
            const minCount = tt.experimentalMin.length;
            const maxCount = tt.experimentalMax.length;
            const precisionCount = tt.experimentalPrecision.length;
            const combineTypeCount = tt.experimentalCombineType.length;
            const numPropsCount = tt.numberExperimentalProperties.length;

            const allEqual = [groupCount, subGroupCount, minCount, maxCount, precisionCount, combineTypeCount, numPropsCount]
                .every(c => c === groupCount);

            if (!allEqual) {
                results.push({
                    severity: 'error',
                    category: 'Target Template',
                    message: `Array length mismatch: groupTitles(${groupCount}), subGroupTitles(${subGroupCount}), min(${minCount}), max(${maxCount}), precision(${precisionCount}), combineType(${combineTypeCount}), numProps(${numPropsCount})`,
                    file: project.targetTemplatePath,
                    fix: 'Ensure all experimental arrays have the same length'
                });
            }

            // Check sum of numberExperimentalProperties
            const sumNumProps = tt.numberExperimentalProperties.reduce((a, b) => a + b, 0);
            const propsCount = tt.experimentalProperties.length;
            const weightsCount = tt.experimentalWeights.length;

            if (sumNumProps !== propsCount) {
                results.push({
                    severity: 'error',
                    category: 'Target Template',
                    message: `Sum of numberExperimentalProperties (${sumNumProps}) doesn't match experimentalProperties length (${propsCount})`,
                    file: project.targetTemplatePath,
                    fix: 'Adjust numberExperimentalProperties so sum equals experimentalProperties length'
                });
            }

            if (sumNumProps !== weightsCount) {
                results.push({
                    severity: 'error',
                    category: 'Target Template',
                    message: `Sum of numberExperimentalProperties (${sumNumProps}) doesn't match experimentalWeights length (${weightsCount})`,
                    file: project.targetTemplatePath,
                    fix: 'Adjust numberExperimentalProperties so sum equals experimentalWeights length'
                });
            }

            // Check min <= max for each attribute
            for (let i = 0; i < tt.experimentalMin.length; i++) {
                const min = tt.experimentalMin[i];
                const max = tt.experimentalMax[i];
                const attrName = tt.experimentalSubGroupTitles[i] || `index ${i}`;

                // Skip null placeholders
                if (attrName === 'null' || tt.experimentalGroupTitles[i] === 'null') continue;

                if (min > max) {
                    results.push({
                        severity: 'warning',
                        category: 'Target Template',
                        message: `"${attrName}" has min (${min}) > max (${max}) - this inverts the attribute`,
                        file: project.targetTemplatePath,
                        fix: 'Swap min and max values if this is unintentional'
                    });
                }
            }

            // Check for attributes without formulas (empty resourceWeights)
            if (tt.attributeWeights.length === 0 && tt.experimentalSubGroupTitles.some(s => s !== 'null')) {
                results.push({
                    severity: 'error',
                    category: 'Target Template',
                    message: 'No valid crafting formulas found - experimentalProperties may be empty or invalid',
                    file: project.targetTemplatePath
                });
            }

            // Check Blue Frog defaults
            const hasInferredOnly = tt.blueFrogInferred.size === Object.keys(tt.blueFrogDefaults).length && tt.blueFrogInferred.size > 0;

            if (hasInferredOnly) {
                results.push({
                    severity: 'info',
                    category: 'Target Template',
                    message: 'Blue Frog defaults are auto-inferred (no explicit values in file)',
                    file: project.targetTemplatePath,
                    fix: 'Add explicit default values for spawned items (optional)'
                });
            }
        }

        // ========================================
        // IFF FILE VALIDATIONS
        // ========================================

        if (!project.schematicIffPath) {
            results.push({
                severity: 'warning',
                category: 'Schematic IFF',
                message: 'No schematic IFF file found',
                fix: 'Create IFF in tre/working/object/draft_schematic/'
            });
        } else {
            // Check if IFF exists
            if (!fs.existsSync(project.schematicIffPath)) {
                results.push({
                    severity: 'error',
                    category: 'Schematic IFF',
                    message: 'Schematic IFF file does not exist',
                    file: project.schematicIffPath
                });
            } else {
                // Basic IFF validation - check for FORM header
                try {
                    const buffer = fs.readFileSync(project.schematicIffPath);
                    if (buffer.length < 8) {
                        results.push({
                            severity: 'error',
                            category: 'Schematic IFF',
                            message: 'IFF file is too small to be valid',
                            file: project.schematicIffPath
                        });
                    } else {
                        const header = buffer.subarray(0, 4).toString('ascii');
                        if (header !== 'FORM') {
                            results.push({
                                severity: 'error',
                                category: 'Schematic IFF',
                                message: `Invalid IFF header: expected "FORM", got "${header}"`,
                                file: project.schematicIffPath
                            });
                        }
                    }
                } catch (e: any) {
                    results.push({
                        severity: 'error',
                        category: 'Schematic IFF',
                        message: `Failed to read IFF file: ${e.message}`,
                        file: project.schematicIffPath
                    });
                }
            }
        }

        // ========================================
        // TARGET OBJECT IFF VALIDATION
        // ========================================

        if (project.schematic.targetTemplate) {
            const targetIffPath = this.findTargetObjectIff(project.schematic.targetTemplate, workspaceRoot);
            if (!targetIffPath) {
                results.push({
                    severity: 'warning',
                    category: 'Target Object IFF',
                    message: `Target object IFF not found: ${project.schematic.targetTemplate}`,
                    fix: 'Create IFF in tre/working/ or verify the path is correct'
                });
            }
        }

        // ========================================
        // STRING VALIDATION
        // ========================================

        // Check string references in schematic Lua
        if (project.schematicLuaPath && fs.existsSync(project.schematicLuaPath)) {
            const luaContent = fs.readFileSync(project.schematicLuaPath, 'utf8');
            const stringRefs = this.extractStringReferences(luaContent);

            for (const ref of stringRefs) {
                const stfResult = this.checkStringExists(ref.stfFile, ref.key, workspaceRoot);
                if (!stfResult.exists) {
                    results.push({
                        severity: 'warning',
                        category: 'Strings',
                        message: `String not found: @${ref.stfFile}:${ref.key}`,
                        file: project.schematicLuaPath,
                        fix: stfResult.stfExists
                            ? `Add key "${ref.key}" to string/en/${ref.stfFile}.stf`
                            : `Create STF file: string/en/${ref.stfFile}.stf`
                    });
                }
            }
        }

        // Check string references in target template Lua
        if (project.targetTemplatePath && fs.existsSync(project.targetTemplatePath)) {
            const luaContent = fs.readFileSync(project.targetTemplatePath, 'utf8');
            const stringRefs = this.extractStringReferences(luaContent);

            for (const ref of stringRefs) {
                const stfResult = this.checkStringExists(ref.stfFile, ref.key, workspaceRoot);
                if (!stfResult.exists) {
                    results.push({
                        severity: 'warning',
                        category: 'Strings',
                        message: `String not found: @${ref.stfFile}:${ref.key}`,
                        file: project.targetTemplatePath,
                        fix: stfResult.stfExists
                            ? `Add key "${ref.key}" to string/en/${ref.stfFile}.stf`
                            : `Create STF file: string/en/${ref.stfFile}.stf`
                    });
                }
            }
        }

        // ========================================
        // COMPILE REPORT
        // ========================================

        const errors = results.filter(r => r.severity === 'error').length;
        const warnings = results.filter(r => r.severity === 'warning').length;
        const infos = results.filter(r => r.severity === 'info').length;

        return {
            passed: errors === 0,
            errors,
            warnings,
            infos,
            results
        };
    }

    /**
     * Extract @file:key string references from Lua content
     */
    static extractStringReferences(content: string): Array<{stfFile: string; key: string}> {
        const refs: Array<{stfFile: string; key: string}> = [];
        // Match @path/file:key pattern (Lua string references)
        const regex = /@([a-zA-Z0-9_\/]+):([a-zA-Z0-9_]+)/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            refs.push({ stfFile: match[1], key: match[2] });
        }
        return refs;
    }

    /**
     * Check if a string key exists in an STF file
     * Returns { exists: boolean, stfExists: boolean }
     */
    static checkStringExists(stfFile: string, key: string, workspaceRoot: string): { exists: boolean; stfExists: boolean } {
        // Check exported text files first (faster than parsing STF)
        const exportedPath = path.join(workspaceRoot, 'tre/export/working/string/en', stfFile + '.txt');
        if (fs.existsSync(exportedPath)) {
            try {
                const content = fs.readFileSync(exportedPath, 'utf8');
                // Exported format: "key: value" or "key\tvalue"
                const keyRegex = new RegExp(`^${key}[:\\t]`, 'm');
                return { exists: keyRegex.test(content), stfExists: true };
            } catch (e) {
                // Fall through to STF check
            }
        }

        // Check the combined all_strings.csv
        const allStringsPath = path.join(workspaceRoot, 'tre/export/working/string/all_strings.csv');
        if (fs.existsSync(allStringsPath)) {
            try {
                const content = fs.readFileSync(allStringsPath, 'utf8');
                // CSV format: file,key,value
                const searchPattern = `${stfFile},${key},`;
                return { exists: content.includes(searchPattern), stfExists: true };
            } catch (e) {
                // Fall through
            }
        }

        // Check if STF file exists in tre/working
        const stfPath = path.join(workspaceRoot, 'tre/working/string/en', stfFile + '.stf');
        const stfExists = fs.existsSync(stfPath);

        // If STF exists but we couldn't read exported version, assume string might exist
        // (we can't easily parse binary STF here)
        if (stfExists) {
            return { exists: true, stfExists: true };  // Assume exists if we can't verify
        }

        // Check infinity fallback
        const infinityStfPath = path.join(workspaceRoot, 'tre/infinity/string/en', stfFile + '.stf');
        const infinityExists = fs.existsSync(infinityStfPath);

        return { exists: infinityExists, stfExists: infinityExists };
    }

    /**
     * Find target object IFF file
     * Handles both with and without shared_ prefix
     */
    static findTargetObjectIff(templatePath: string, workspaceRoot: string): string | null {
        // templatePath is like "object/tangible/medicine/dw_adrenaline_stim.iff"
        // Actual file may be "shared_dw_adrenaline_stim.iff"

        const dir = path.dirname(templatePath);
        const filename = path.basename(templatePath);
        const sharedFilename = filename.startsWith('shared_') ? filename : 'shared_' + filename;

        // Try both the original path and with shared_ prefix
        const pathsToTry = [
            path.join(dir, sharedFilename),  // With shared_ prefix
            templatePath,                      // As-is
        ];

        for (const relPath of pathsToTry) {
            const candidates = [
                path.join(workspaceRoot, 'tre/working', relPath),
                path.join(workspaceRoot, 'tre/infinity', relPath),
                path.join(workspaceRoot, 'tre/vanilla', relPath),
            ];

            for (const candidate of candidates) {
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }

        return null;
    }

    /**
     * Find matching Lua file for an IFF schematic
     */
    static findMatchingLua(iffPath: string, workspaceRoot: string): string | null {
        const normalized = iffPath.replace(/\\/g, '/');
        const match = normalized.match(/object\/draft_schematic\/(.+)\.iff$/i);
        if (!match) return null;

        let relativePath = match[1].replace(/shared_/, '');

        const candidates = [
            path.join(workspaceRoot, 'infinity4.0.0/MMOCoreORB/bin/scripts/custom_scripts/object/draft_schematic', relativePath + '.lua'),
            path.join(workspaceRoot, 'infinity4.0.0/MMOCoreORB/bin/scripts/object/draft_schematic', relativePath + '.lua'),
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    /**
     * Find matching IFF file for a Lua schematic
     * If not in tre/working but exists in tre/infinity, copy it to working first
     */
    static findMatchingIff(luaPath: string, workspaceRoot: string): string | null {
        const normalized = luaPath.replace(/\\/g, '/');
        // Handle both scripts/object/ and custom_scripts/object/ paths
        const match = normalized.match(/(?:custom_scripts\/)?object\/draft_schematic\/(.+)\.lua$/i);
        if (!match) return null;

        const relativePath = match[1];
        // relativePath is like "chemistry/dw_adrenaline_stim"
        const dir = path.dirname(relativePath);
        const filename = path.basename(relativePath);
        const iffFileName = path.join(dir, 'shared_' + filename + '.iff');

        const workingPath = path.join(workspaceRoot, 'tre/working/object/draft_schematic', iffFileName);
        const infinityPath = path.join(workspaceRoot, 'tre/infinity/object/draft_schematic', iffFileName);
        const vanillaPath = path.join(workspaceRoot, 'tre/vanilla/object/draft_schematic', iffFileName);

        // Check working first
        if (fs.existsSync(workingPath)) {
            return workingPath;
        }

        // If in infinity but not working, copy to working
        if (fs.existsSync(infinityPath)) {
            try {
                // Ensure directory exists
                const workingDir = path.dirname(workingPath);
                fs.mkdirSync(workingDir, { recursive: true });
                // Copy file
                fs.copyFileSync(infinityPath, workingPath);
                return workingPath;
            } catch (e) {
                // Fall back to infinity path if copy fails
                return infinityPath;
            }
        }

        // Check vanilla as last resort
        if (fs.existsSync(vanillaPath)) {
            return vanillaPath;
        }

        return null;
    }

    /**
     * Find target template Lua file
     */
    static findTargetTemplate(templatePath: string, workspaceRoot: string): string | null {
        // templatePath is like "object/tangible/weapon/shared_pistol_westar31b.iff"
        // We need to find the Lua file

        const match = templatePath.match(/object\/(.+)\.iff$/i);
        if (!match) return null;

        // Remove "shared_" prefix and convert to Lua path
        const relativePath = match[1].replace(/shared_/g, '');

        const candidates = [
            path.join(workspaceRoot, 'infinity4.0.0/MMOCoreORB/bin/scripts/custom_scripts/object', relativePath + '.lua'),
            path.join(workspaceRoot, 'infinity4.0.0/MMOCoreORB/bin/scripts/object', relativePath + '.lua'),
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    /**
     * Parse a Lua draft schematic file
     */
    static parseLuaSchematic(luaPath: string): SchematicData {
        const content = fs.readFileSync(luaPath, 'utf8');

        const schematic: SchematicData = {
            customObjectName: this.extractLuaString(content, 'customObjectName') || '',
            craftingToolTab: this.extractLuaNumber(content, 'craftingToolTab') || 0,
            complexity: this.extractLuaNumber(content, 'complexity') || 0,
            size: this.extractLuaNumber(content, 'size') || 0,
            factoryCrateSize: this.extractLuaNumber(content, 'factoryCrateSize') || 0,
            xpType: this.extractLuaString(content, 'xpType') || '',
            xp: this.extractLuaNumber(content, 'xp') || 0,
            assemblySkill: this.extractLuaString(content, 'assemblySkill') || '',
            experimentingSkill: this.extractLuaString(content, 'experimentingSkill') || '',
            customizationSkill: this.extractLuaString(content, 'customizationSkill') || '',
            slots: [],
            targetTemplate: this.extractLuaString(content, 'targetTemplate') || ''
        };

        // Parse slot arrays
        const templateNames = this.extractLuaStringArray(content, 'ingredientTemplateNames');
        const titleNames = this.extractLuaStringArray(content, 'ingredientTitleNames');
        const slotTypes = this.extractLuaNumberArray(content, 'ingredientSlotType');
        const resourceTypes = this.extractLuaStringArray(content, 'resourceTypes');
        const quantities = this.extractLuaNumberArray(content, 'resourceQuantities');
        const contributions = this.extractLuaNumberArray(content, 'contribution');

        const slotCount = Math.max(
            templateNames.length,
            titleNames.length,
            slotTypes.length,
            resourceTypes.length,
            quantities.length
        );

        for (let i = 0; i < slotCount; i++) {
            schematic.slots.push({
                templateName: templateNames[i] || '',
                titleName: titleNames[i] || '',
                slotType: slotTypes[i] || 0,
                resourceType: resourceTypes[i] || '',
                quantity: quantities[i] || 1,
                contribution: contributions[i] || 100
            });
        }

        return schematic;
    }

    /**
     * Parse a target template Lua file for experimental properties
     */
    static parseTargetTemplate(luaPath: string): TargetTemplateData {
        const content = fs.readFileSync(luaPath, 'utf8');

        const numberExperimentalProperties = this.extractLuaNumberArray(content, 'numberExperimentalProperties');
        const experimentalProperties = this.extractLuaStringArray(content, 'experimentalProperties');
        const experimentalWeights = this.extractLuaNumberArray(content, 'experimentalWeights');
        const experimentalGroupTitles = this.extractLuaStringArray(content, 'experimentalGroupTitles');
        const experimentalSubGroupTitles = this.extractLuaStringArray(content, 'experimentalSubGroupTitles');
        const experimentalMin = this.extractLuaNumberArray(content, 'experimentalMin');
        const experimentalMax = this.extractLuaNumberArray(content, 'experimentalMax');
        const experimentalPrecision = this.extractLuaNumberArray(content, 'experimentalPrecision');
        const experimentalCombineType = this.extractLuaNumberArray(content, 'experimentalCombineType');

        // Calculate attribute weights from the grouped properties
        const attributeWeights: AttributeWeights[] = [];
        const usedResourceStats = new Set<string>();

        let propIndex = 0;
        for (let attrIdx = 0; attrIdx < numberExperimentalProperties.length; attrIdx++) {
            const numProps = numberExperimentalProperties[attrIdx];
            const attrName = experimentalSubGroupTitles[attrIdx] || '';
            const groupName = experimentalGroupTitles[attrIdx] || '';

            // Skip placeholder attributes
            if (attrName === 'null' || attrName === '' || groupName === 'null') {
                propIndex += numProps;
                continue;
            }

            // Collect resource weights for this attribute
            const resourceWeights: ResourceWeightInfo[] = [];
            let totalWeight = 0;

            for (let i = 0; i < numProps; i++) {
                const stat = experimentalProperties[propIndex + i];
                const weight = experimentalWeights[propIndex + i] || 1;

                if (stat && stat !== 'XX' && stat !== 'null' && stat !== '') {
                    resourceWeights.push({ stat, weight, percentage: 0 });
                    totalWeight += weight;
                    usedResourceStats.add(stat);
                }
            }

            // Calculate percentages
            for (const rw of resourceWeights) {
                rw.percentage = totalWeight > 0 ? Math.round((rw.weight / totalWeight) * 100) : 0;
            }

            if (resourceWeights.length > 0) {
                attributeWeights.push({
                    attribute: attrName,
                    group: groupName,
                    resourceWeights
                });
            }

            propIndex += numProps;
        }

        // Detect object type from path and attributes
        let objectType = this.detectObjectType(luaPath);
        if (objectType === 'unknown') {
            const attrNames = attributeWeights.map(aw => aw.attribute);
            objectType = this.detectObjectTypeFromAttributes(attrNames);
        }

        // Parse explicit blue frog defaults from file
        const explicitDefaults = this.parseBlueFrogDefaults(content);
        const explicitKeys = Object.keys(explicitDefaults);

        // Track which values are inferred
        const blueFrogInferred = new Set<string>();

        // If no explicit values, infer from object type and experimental ranges
        let blueFrogDefaults: BlueFrogDefaults;
        if (explicitKeys.length === 0) {
            // Fully infer defaults
            blueFrogDefaults = this.inferBlueFrogDefaults(
                luaPath,
                attributeWeights,
                experimentalMin,
                experimentalMax,
                experimentalSubGroupTitles
            );
            // Mark all inferred values
            for (const key of Object.keys(blueFrogDefaults)) {
                blueFrogInferred.add(key);
            }
        } else {
            // Use explicit values, but we can still show what COULD be inferred for empty fields
            blueFrogDefaults = explicitDefaults;
        }

        return {
            numberExperimentalProperties,
            experimentalProperties,
            experimentalWeights,
            experimentalGroupTitles,
            experimentalSubGroupTitles,
            experimentalMin,
            experimentalMax,
            experimentalPrecision,
            experimentalCombineType,
            attributeWeights,
            usedResourceStats: Array.from(usedResourceStats),
            blueFrogDefaults,
            blueFrogInferred,
            objectType
        };
    }

    /**
     * Parse blue frog default values from target template
     */
    static parseBlueFrogDefaults(content: string): BlueFrogDefaults {
        const defaults: BlueFrogDefaults = {};

        // Medicine properties
        const useCount = this.extractLuaNumber(content, 'useCount');
        if (useCount !== null) defaults.useCount = useCount;

        const effectiveness = this.extractLuaNumber(content, 'effectiveness');
        if (effectiveness !== null) defaults.effectiveness = effectiveness;

        const duration = this.extractLuaNumber(content, 'duration');
        if (duration !== null) defaults.duration = duration;

        const medicineUse = this.extractLuaNumber(content, 'medicineUse');
        if (medicineUse !== null) defaults.medicineUse = medicineUse;

        // Weapon properties
        const minDamage = this.extractLuaNumber(content, 'minDamage');
        if (minDamage !== null) defaults.minDamage = minDamage;

        const maxDamage = this.extractLuaNumber(content, 'maxDamage');
        if (maxDamage !== null) defaults.maxDamage = maxDamage;

        const attackSpeed = this.extractLuaNumber(content, 'attackSpeed');
        if (attackSpeed !== null) defaults.attackSpeed = attackSpeed;

        const healthAttackCost = this.extractLuaNumber(content, 'healthAttackCost');
        if (healthAttackCost !== null) defaults.healthAttackCost = healthAttackCost;

        const actionAttackCost = this.extractLuaNumber(content, 'actionAttackCost');
        if (actionAttackCost !== null) defaults.actionAttackCost = actionAttackCost;

        const mindAttackCost = this.extractLuaNumber(content, 'mindAttackCost');
        if (mindAttackCost !== null) defaults.mindAttackCost = mindAttackCost;

        const woundsRatio = this.extractLuaNumber(content, 'woundsRatio');
        if (woundsRatio !== null) defaults.woundsRatio = woundsRatio;

        // Armor properties
        const armorRating = this.extractLuaNumber(content, 'armorRating');
        if (armorRating !== null) defaults.armorRating = armorRating;

        const kinetic = this.extractLuaNumber(content, 'kinetic');
        if (kinetic !== null) defaults.kinetic = kinetic;

        const energy = this.extractLuaNumber(content, 'energy');
        if (energy !== null) defaults.energy = energy;

        const electricity = this.extractLuaNumber(content, 'electricity');
        if (electricity !== null) defaults.electricity = electricity;

        const stun = this.extractLuaNumber(content, 'stun');
        if (stun !== null) defaults.stun = stun;

        const blast = this.extractLuaNumber(content, 'blast');
        if (blast !== null) defaults.blast = blast;

        const heat = this.extractLuaNumber(content, 'heat');
        if (heat !== null) defaults.heat = heat;

        const cold = this.extractLuaNumber(content, 'cold');
        if (cold !== null) defaults.cold = cold;

        const acid = this.extractLuaNumber(content, 'acid');
        if (acid !== null) defaults.acid = acid;

        const lightSaber = this.extractLuaNumber(content, 'lightSaber');
        if (lightSaber !== null) defaults.lightSaber = lightSaber;

        return defaults;
    }

    // ========================================================================
    // OBJECT TYPE DETECTION & BLUE FROG INFERENCE
    // ========================================================================

    /**
     * Detect object type from target template path
     */
    static detectObjectType(templatePath: string | null): ObjectType {
        if (!templatePath) return 'unknown';

        const normalized = templatePath.toLowerCase().replace(/\\/g, '/');

        // Check path patterns
        if (normalized.includes('/medicine/') || normalized.includes('/pharmaceutical/')) {
            return 'medicine';
        }
        if (normalized.includes('/weapon/')) {
            return 'weapon';
        }
        if (normalized.includes('/armor/') || normalized.includes('/wearables/armor')) {
            return 'armor';
        }
        if (normalized.includes('/food/') || normalized.includes('/drink/')) {
            return 'food';
        }
        if (normalized.includes('/component/')) {
            return 'component';
        }

        return 'unknown';
    }

    /**
     * Detect object type from experimental attributes
     */
    static detectObjectTypeFromAttributes(attributeNames: string[]): ObjectType {
        const attrs = attributeNames.map(a => a.toLowerCase());

        // Medicine indicators
        if (attrs.some(a => ['power', 'charges'].includes(a))) {
            return 'medicine';
        }

        // Weapon indicators
        if (attrs.some(a => ['mindamage', 'maxdamage', 'attackspeed', 'woundchance'].includes(a))) {
            return 'weapon';
        }

        // Armor indicators
        if (attrs.some(a => ['kinetic', 'energy', 'electricity', 'blast', 'heat', 'cold', 'acid'].includes(a))) {
            return 'armor';
        }

        return 'unknown';
    }

    /**
     * Infer Blue Frog defaults based on object type and experimental attributes
     */
    static inferBlueFrogDefaults(
        templatePath: string | null,
        attributeWeights: AttributeWeights[],
        experimentalMin: number[],
        experimentalMax: number[],
        experimentalSubGroupTitles: string[]
    ): BlueFrogDefaults {
        const defaults: BlueFrogDefaults = {};

        // Detect object type - try path first, then attributes
        let objectType = this.detectObjectType(templatePath);
        if (objectType === 'unknown') {
            const attrNames = attributeWeights.map(aw => aw.attribute);
            objectType = this.detectObjectTypeFromAttributes(attrNames);
        }

        // Get base defaults for this object type
        const baseDefaults = BLUEFROG_DEFAULTS_BY_TYPE[objectType] || {};

        // Start with base defaults
        Object.assign(defaults, baseDefaults);

        // Override with values derived from experimental ranges
        // Use the minimum value as the Blue Frog default (represents non-crafted baseline)
        for (let i = 0; i < experimentalSubGroupTitles.length; i++) {
            const expAttr = experimentalSubGroupTitles[i]?.toLowerCase();
            if (!expAttr || expAttr === 'null') continue;

            const blueFrogProp = EXPERIMENTAL_BLUEFROG_MAP[expAttr];
            if (blueFrogProp && experimentalMin[i] !== undefined) {
                (defaults as any)[blueFrogProp] = experimentalMin[i];
            }
        }

        return defaults;
    }

    // ========================================================================
    // LUA PARSING HELPERS
    // ========================================================================

    private static extractLuaString(content: string, key: string): string | null {
        const regex = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'm');
        const match = content.match(regex);
        return match ? match[1] : null;
    }

    private static extractLuaNumber(content: string, key: string): number | null {
        const regex = new RegExp(`${key}\\s*=\\s*(-?\\d+\\.?\\d*)`, 'm');
        const match = content.match(regex);
        return match ? parseFloat(match[1]) : null;
    }

    private static extractLuaStringArray(content: string, key: string): string[] {
        const regex = new RegExp(`${key}\\s*=\\s*\\{([^}]*)\\}`, 'm');
        const match = content.match(regex);
        if (!match) return [];

        const items: string[] = [];
        const stringRegex = /"([^"]*)"/g;
        let stringMatch;
        while ((stringMatch = stringRegex.exec(match[1])) !== null) {
            items.push(stringMatch[1]);
        }

        return items;
    }

    private static extractLuaNumberArray(content: string, key: string): number[] {
        const regex = new RegExp(`${key}\\s*=\\s*\\{([^}]*)\\}`, 'm');
        const match = content.match(regex);
        if (!match) return [];

        const items: number[] = [];
        const numberRegex = /(-?\d+\.?\d*)/g;
        let numberMatch;
        while ((numberMatch = numberRegex.exec(match[1])) !== null) {
            // Skip numbers that are part of hex codes or other non-array values
            items.push(parseFloat(numberMatch[1]));
        }

        return items;
    }
}
