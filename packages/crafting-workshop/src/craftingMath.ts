/**
 * Crafting Math - Ported from SWGEmu C++ code
 *
 * References:
 * - SharedLabratory.cpp (formulas)
 * - ResourceLabratory.cpp (assembly/experimentation)
 * - CraftingValues.cpp (value calculation)
 * - CraftingManagerImplementation.cpp (skill checks)
 */

// ============================================================================
// CONSTANTS
// ============================================================================

export enum AssemblyResult {
    CRITICALFAILURE = 0,
    BARELYSUCCESSFUL = 1,
    OK = 2,
    MARGINALSUCCESS = 3,
    SUCCESS = 4,
    MODERATESUCCESS = 5,
    GOODSUCCESS = 6,
    GREATSUCCESS = 7,
    AMAZINGSUCCESS = 8
}

export enum SlotType {
    RESOURCESLOT = 0,
    IDENTICALSLOT = 1,
    MIXEDSLOT = 2,
    OPTIONALIDENTICALSLOT = 3,
    OPTIONALMIXEDSLOT = 4
}

export enum CombineType {
    RESOURCECOMBINE = 0,
    LINEARCOMBINE = 1,
    PERCENTAGECOMBINE = 2,
    BITSETCOMBINE = 3,
    OVERRIDECOMBINE = 4,
    LIMITEDCOMBINE = 5
}

// Resource property codes
export const ResourceProperty = {
    CR: 0x01,  // Cold Resistance
    CD: 0x02,  // Conductivity
    DR: 0x03,  // Decay Resistance
    HR: 0x04,  // Heat Resistance
    FL: 0x05,  // Flavor
    MA: 0x06,  // Malleability
    PE: 0x07,  // Potential Energy
    OQ: 0x08,  // Overall Quality
    SR: 0x09,  // Shock Resistance
    UT: 0x0A,  // Unit Toughness
} as const;

export const PropertyNames: Record<string, string> = {
    'CR': 'Cold Resistance',
    'CD': 'Conductivity',
    'DR': 'Decay Resistance',
    'HR': 'Heat Resistance',
    'FL': 'Flavor',
    'MA': 'Malleability',
    'PE': 'Potential Energy',
    'OQ': 'Overall Quality',
    'SR': 'Shock Resistance',
    'UT': 'Unit Toughness',
};

// ============================================================================
// DATA STRUCTURES
// ============================================================================

export interface ResourceStats {
    CR?: number;
    CD?: number;
    DR?: number;
    HR?: number;
    FL?: number;
    MA?: number;
    PE?: number;
    OQ?: number;
    SR?: number;
    UT?: number;
}

export interface ComponentStats {
    [attributeName: string]: number;
}

export interface IngredientSlot {
    name: string;
    slotType: SlotType;
    quantity: number;
    contribution: number;  // 0.0 to 1.0
    // Filled ingredient data
    resource?: ResourceStats;
    component?: ComponentStats;
}

export interface ExperimentalProperty {
    attribute: string;
    group: string;
    subGroup?: string;
    min: number;
    max: number;
    precision: number;
    combineType: CombineType;
    weight: number;
}

export interface ResourceWeight {
    attribute: string;
    group: string;
    weights: Record<string, number>;  // e.g., {OQ: 0.5, SR: 0.3, UT: 0.2}
}

export interface CraftingAttribute {
    name: string;
    group: string;
    min: number;
    max: number;
    currentValue: number;
    currentPercentage: number;
    maxPercentage: number;
    precision: number;
    combineType: CombineType;
}

export interface CraftingSession {
    schematicName: string;
    slots: IngredientSlot[];
    resourceWeights: ResourceWeight[];
    experimentalProperties: ExperimentalProperty[];
    attributes: Map<string, CraftingAttribute>;
    assemblySkill: number;
    experimentationSkill: number;
    toolEffectiveness: number;  // -15 to +15
}

// ============================================================================
// CORE FORMULAS (from SharedLabratory.cpp)
// ============================================================================

/**
 * Calculate weighted average of resource stats across all slots
 * From: SharedLabratory.cpp:73-142
 *
 * Formula: Σ(stat_i × quantity_i) / Σ(quantity_i)
 */
export function calculateWeightedAverage(
    slots: IngredientSlot[],
    propertyCode: string
): number {
    let weightedSum = 0;
    let totalQuantity = 0;

    for (const slot of slots) {
        if (!slot.resource) continue;

        const stat = slot.resource[propertyCode as keyof ResourceStats];
        if (stat === undefined || stat === 0) continue;

        weightedSum += stat * slot.quantity;
        totalQuantity += slot.quantity;
    }

    if (totalQuantity === 0) return 0;
    return weightedSum / totalQuantity;
}

/**
 * Calculate assembly percentage from weighted resource value
 * From: SharedLabratory.cpp:68-72
 *
 * Formula: value * (0.000015 * value + 0.015) * 0.01
 * Expanded: 0.0000000015v² + 0.0000015v
 */
export function calculateAssemblyPercentage(weightedValue: number): number {
    return weightedValue * (0.000015 * weightedValue + 0.015) * 0.01;
}

/**
 * Calculate max percentage from weighted sum
 * From: ResourceLabratory.cpp:93
 *
 * Formula: (weightedSum / 10.0) * 0.01
 */
export function calculateMaxPercentage(weightedSum: number): number {
    return (weightedSum / 10.0) * 0.01;
}

/**
 * Calculate assembly success modifier
 * From: SharedLabratory.cpp:59-66
 *
 * AMAZINGSUCCESS = 1.05
 * Others = 1.1 - (result * 0.1)
 */
export function calculateAssemblyModifier(result: AssemblyResult): number {
    if (result === AssemblyResult.AMAZINGSUCCESS) {
        return 1.05;
    }
    return 1.1 - (result * 0.1);
}

/**
 * Calculate experimentation modifier per attempt
 * From: SharedLabratory.cpp:21-58
 */
export function calculateExperimentationModifier(
    result: AssemblyResult,
    pointsAttempted: number
): number {
    let baseModifier: number;

    switch (result) {
        case AssemblyResult.AMAZINGSUCCESS:
            baseModifier = 0.08;
            break;
        case AssemblyResult.GREATSUCCESS:
            baseModifier = 0.07;
            break;
        case AssemblyResult.GOODSUCCESS:
            baseModifier = 0.055;
            break;
        case AssemblyResult.MODERATESUCCESS:
            baseModifier = 0.015;
            break;
        case AssemblyResult.SUCCESS:
            baseModifier = 0.01;
            break;
        case AssemblyResult.MARGINALSUCCESS:
            baseModifier = 0.00;
            break;
        case AssemblyResult.OK:
            baseModifier = -0.04;
            break;
        case AssemblyResult.BARELYSUCCESSFUL:
            baseModifier = -0.07;
            break;
        case AssemblyResult.CRITICALFAILURE:
            baseModifier = -0.08;
            break;
        default:
            baseModifier = 0;
    }

    return baseModifier * pointsAttempted;
}

/**
 * Convert percentage to actual value
 * From: CraftingValues.cpp:63-109
 */
export function percentageToValue(
    percentage: number,
    min: number,
    max: number
): number {
    if (max >= min) {
        return (percentage * (max - min)) + min;
    } else {
        // Inverted range (higher percentage = lower value)
        return ((1.0 - percentage) * (min - max)) + max;
    }
}

/**
 * Calculate failure rate for experimentation
 * From: CraftingManagerImplementation.cpp:43-56
 *
 * Formula: 50 + (MA - 500) / 40 + expSkill/10 - 5 * pointsUsed
 */
export function calculateFailureRate(
    malleability: number,
    experimentationSkill: number,
    pointsUsed: number
): number {
    return Math.round(
        50.0 +
        (malleability - 500.0) / 40.0 +
        experimentationSkill / 10.0 -
        5.0 * pointsUsed
    );
}

// ============================================================================
// ASSEMBLY SIMULATION
// ============================================================================

/**
 * Roll for assembly success
 * From: SharedLabratory.cpp:143-217
 */
export function rollAssemblySuccess(
    assemblySkill: number,
    toolEffectiveness: number,
    luck: number = Math.random() * 100
): AssemblyResult {
    const assemblyPoints = assemblySkill / 10.0;
    const toolModifier = 1.0 + (toolEffectiveness / 100.0);

    const assemblyRoll = toolModifier * (luck + (assemblyPoints * 5));

    if (assemblyRoll > 80) return AssemblyResult.AMAZINGSUCCESS;
    if (assemblyRoll > 70) return AssemblyResult.GREATSUCCESS;
    if (assemblyRoll > 60) return AssemblyResult.GOODSUCCESS;
    if (assemblyRoll > 50) return AssemblyResult.MODERATESUCCESS;
    if (assemblyRoll > 40) return AssemblyResult.SUCCESS;
    if (assemblyRoll > 30) return AssemblyResult.MARGINALSUCCESS;
    if (assemblyRoll > 20) return AssemblyResult.OK;
    return AssemblyResult.BARELYSUCCESSFUL;
}

/**
 * Calculate initial crafting values after assembly
 * This is the main assembly calculation
 */
export function calculateInitialValues(
    session: CraftingSession,
    assemblyResult: AssemblyResult
): void {
    const assemblyModifier = calculateAssemblyModifier(assemblyResult);

    // Process each resource weight (maps resource properties to attributes)
    for (const rw of session.resourceWeights) {
        // Calculate weighted sum from all contributing properties
        let weightedSum = 0;

        for (const [propCode, weight] of Object.entries(rw.weights)) {
            const avgValue = calculateWeightedAverage(session.slots, propCode);
            weightedSum += avgValue * weight;
        }

        if (weightedSum <= 0) continue;

        // Calculate percentages
        const maxPct = calculateMaxPercentage(weightedSum);
        const currentPct = calculateAssemblyPercentage(weightedSum) * assemblyModifier;

        // Find or create the attribute
        let attr = session.attributes.get(rw.attribute);
        if (!attr) {
            // Get experimental property definition
            const expProp = session.experimentalProperties.find(
                p => p.attribute === rw.attribute
            );
            if (!expProp) continue;

            attr = {
                name: rw.attribute,
                group: expProp.group,
                min: expProp.min,
                max: expProp.max,
                currentValue: 0,
                currentPercentage: 0,
                maxPercentage: 0,
                precision: expProp.precision,
                combineType: expProp.combineType
            };
            session.attributes.set(rw.attribute, attr);
        }

        // Set percentage values
        attr.currentPercentage = Math.min(currentPct, maxPct);
        attr.maxPercentage = maxPct;

        // Calculate actual value
        attr.currentValue = percentageToValue(
            attr.currentPercentage,
            attr.min,
            attr.max
        );
    }

    // Apply component contributions
    applyComponentStats(session);
}

/**
 * Apply component stats to crafting values
 * From: ResourceLabratory.cpp:164-370
 */
export function applyComponentStats(session: CraftingSession): void {
    for (const slot of session.slots) {
        if (!slot.component || slot.slotType === SlotType.RESOURCESLOT) continue;

        for (const [attrName, attrValue] of Object.entries(slot.component)) {
            const contribution = slot.contribution;
            const contributedValue = attrValue * contribution;

            let attr = session.attributes.get(attrName);
            if (!attr) {
                // Component adds new attribute
                attr = {
                    name: attrName,
                    group: 'component',
                    min: 0,
                    max: contributedValue,
                    currentValue: contributedValue,
                    currentPercentage: 1.0,
                    maxPercentage: 1.0,
                    precision: 0,
                    combineType: CombineType.LINEARCOMBINE
                };
                session.attributes.set(attrName, attr);
                continue;
            }

            // Apply based on combine type
            switch (attr.combineType) {
                case CombineType.LINEARCOMBINE:
                    attr.currentValue += contributedValue;
                    attr.min += contributedValue;
                    attr.max += contributedValue;
                    break;

                case CombineType.PERCENTAGECOMBINE:
                    attr.currentValue += contributedValue;
                    attr.min += contributedValue;
                    attr.max += contributedValue;
                    break;

                case CombineType.BITSETCOMBINE:
                    attr.currentValue = Math.floor(attr.currentValue) | Math.floor(contributedValue);
                    break;

                case CombineType.OVERRIDECOMBINE:
                    // Do nothing - schematic values take precedence
                    break;

                case CombineType.LIMITEDCOMBINE:
                    attr.currentValue += contributedValue;
                    attr.currentValue = Math.max(attr.min, Math.min(attr.max, attr.currentValue));
                    break;
            }
        }
    }
}

// ============================================================================
// EXPERIMENTATION SIMULATION
// ============================================================================

/**
 * Roll for experimentation success
 * From: CraftingManagerImplementation.cpp:63-141
 */
export function rollExperimentationSuccess(
    experimentationSkill: number,
    toolEffectiveness: number,
    luck: number = Math.random() * 100
): AssemblyResult {
    const expPoints = experimentationSkill / 10.0;
    const toolModifier = 1.0 + (toolEffectiveness / 100.0);

    const expRoll = toolModifier * (luck + (expPoints * 4));

    if (expRoll > 80) return AssemblyResult.AMAZINGSUCCESS;
    if (expRoll > 70) return AssemblyResult.GREATSUCCESS;
    if (expRoll > 60) return AssemblyResult.GOODSUCCESS;
    if (expRoll > 50) return AssemblyResult.MODERATESUCCESS;
    if (expRoll > 40) return AssemblyResult.SUCCESS;
    if (expRoll > 30) return AssemblyResult.MARGINALSUCCESS;
    if (expRoll > 20) return AssemblyResult.OK;
    if (expRoll > 10) return AssemblyResult.BARELYSUCCESSFUL;
    return AssemblyResult.CRITICALFAILURE;
}

/**
 * Apply experimentation to a group of attributes
 * From: ResourceLabratory.cpp:120-158
 */
export function applyExperimentation(
    session: CraftingSession,
    groupName: string,
    pointsUsed: number,
    result: AssemblyResult
): void {
    const modifier = calculateExperimentationModifier(result, pointsUsed);

    // Update all attributes in the experimented group
    for (const attr of session.attributes.values()) {
        if (attr.group !== groupName) continue;

        let newPct = attr.currentPercentage + modifier;

        // Clamp to [0, maxPercentage]
        newPct = Math.max(0, Math.min(attr.maxPercentage, newPct));

        attr.currentPercentage = newPct;

        // Recalculate actual value
        attr.currentValue = percentageToValue(newPct, attr.min, attr.max);
    }
}

// ============================================================================
// SIMULATION HELPERS
// ============================================================================

/**
 * Create a new crafting session
 */
export function createSession(
    schematicName: string,
    slots: IngredientSlot[],
    resourceWeights: ResourceWeight[],
    experimentalProperties: ExperimentalProperty[],
    assemblySkill: number = 100,
    experimentationSkill: number = 100,
    toolEffectiveness: number = 0
): CraftingSession {
    return {
        schematicName,
        slots,
        resourceWeights,
        experimentalProperties,
        attributes: new Map(),
        assemblySkill,
        experimentationSkill,
        toolEffectiveness
    };
}

/**
 * Run a complete crafting simulation
 */
export function simulateCrafting(
    session: CraftingSession,
    experimentationAttempts: Array<{group: string; points: number}> = []
): {
    assemblyResult: AssemblyResult;
    experimentResults: Array<{group: string; result: AssemblyResult; points: number}>;
    finalAttributes: Map<string, CraftingAttribute>;
} {
    // Assembly phase
    const assemblyResult = rollAssemblySuccess(
        session.assemblySkill,
        session.toolEffectiveness
    );

    calculateInitialValues(session, assemblyResult);

    // Experimentation phase
    const experimentResults: Array<{group: string; result: AssemblyResult; points: number}> = [];

    for (const attempt of experimentationAttempts) {
        const result = rollExperimentationSuccess(
            session.experimentationSkill,
            session.toolEffectiveness
        );

        applyExperimentation(session, attempt.group, attempt.points, result);

        experimentResults.push({
            group: attempt.group,
            result,
            points: attempt.points
        });
    }

    return {
        assemblyResult,
        experimentResults,
        finalAttributes: session.attributes
    };
}

/**
 * Format result enum to string
 */
export function resultToString(result: AssemblyResult): string {
    const names = [
        'Critical Failure',
        'Barely Successful',
        'OK',
        'Marginal Success',
        'Success',
        'Moderate Success',
        'Good Success',
        'Great Success',
        'Amazing Success'
    ];
    return names[result] || 'Unknown';
}

/**
 * Format attribute value with precision
 */
export function formatValue(value: number, precision: number): string {
    return value.toFixed(precision);
}

// ============================================================================
// EXPERIMENTATION ROW HELPERS
// ============================================================================

export interface ExperimentationRow {
    group: string;              // experimentalGroupTitle (e.g., "exp_damage")
    attributes: string[];       // Attributes in this group (e.g., ["mindamage", "maxdamage"])
    maxPercentage: number;      // Average maxPercentage for attributes in this group
    bubbleCount: number;        // Number of bubbles (0-10)
    currentPercentage: number;  // Average current percentage
}

/**
 * Calculate the number of experimentation bubbles from maxPercentage
 * From: ManufactureSchematicObjectDeltaMessage7.h:171-190
 *
 * Client displays maxPercentage as bubbles: floor(maxPercentage * 10)
 * Capped at 10 bubbles maximum
 */
export function calculateBubbleCount(maxPercentage: number): number {
    return Math.min(10, Math.floor(maxPercentage * 10));
}

/**
 * Get experimentation rows from a crafting session
 * Groups attributes by their experimentalGroupTitle
 * Each row represents one "line" in the experimentation UI
 */
export function getExperimentationRows(session: CraftingSession): ExperimentationRow[] {
    const rows: Map<string, ExperimentationRow> = new Map();

    // Group attributes by their experiment group
    for (const attr of session.attributes.values()) {
        // Skip filler/null groups
        if (!attr.group || attr.group === 'null') continue;

        let row = rows.get(attr.group);
        if (!row) {
            row = {
                group: attr.group,
                attributes: [],
                maxPercentage: 0,
                bubbleCount: 0,
                currentPercentage: 0
            };
            rows.set(attr.group, row);
        }

        row.attributes.push(attr.name);
    }

    // Calculate averages for each row (this mirrors getMaxVisiblePercentage in C++)
    for (const row of rows.values()) {
        let totalMax = 0;
        let totalCurrent = 0;
        let count = 0;

        for (const attrName of row.attributes) {
            const attr = session.attributes.get(attrName);
            if (!attr) continue;

            // Only count attributes with varying min/max (not fillers)
            if (attr.min !== attr.max && attr.maxPercentage <= 1.0) {
                totalMax += attr.maxPercentage;
                totalCurrent += attr.currentPercentage;
                count++;
            }
        }

        if (count > 0) {
            row.maxPercentage = totalMax / count;
            row.currentPercentage = totalCurrent / count;
        }

        row.bubbleCount = calculateBubbleCount(row.maxPercentage);
    }

    return Array.from(rows.values());
}
