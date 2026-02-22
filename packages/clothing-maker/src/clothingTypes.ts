/**
 * Clothing type definitions and default stat templates
 */

export interface ClothingType {
    name: string;
    folder: string;
    defaultStats: ClothingStats;
    craftingTab: number;
    ingredientSlots: IngredientSlot[];
}

export interface ClothingStats {
    // Common properties
    sockets: number;
    hitpoints: number;

    // Optional armor properties
    isArmor?: boolean;
    healthEncumbrance?: number;
    actionEncumbrance?: number;
    mindEncumbrance?: number;
    kinetic?: number;
    energy?: number;
    electricity?: number;
    stun?: number;
    blast?: number;
    heat?: number;
    cold?: number;
    acid?: number;
}

export interface IngredientSlot {
    title: string;
    resourceType: string;
    quantity: number;
    contribution: number;
}

/** Standard clothing types with sensible defaults */
export const CLOTHING_TYPES: Record<string, ClothingType> = {
    boots: {
        name: 'Boots',
        folder: 'object/tangible/wearables/boots',
        craftingTab: 8,
        defaultStats: {
            sockets: 0,
            hitpoints: 1000,
        },
        ingredientSlots: [
            { title: 'boots', resourceType: 'hide', quantity: 20, contribution: 100 },
            { title: 'binding_and_hardware', resourceType: 'petrochem_inert', quantity: 10, contribution: 100 },
            { title: 'sole', resourceType: 'petrochem_inert', quantity: 15, contribution: 100 },
        ],
    },
    gloves: {
        name: 'Gloves',
        folder: 'object/tangible/wearables/gloves',
        craftingTab: 8,
        defaultStats: {
            sockets: 0,
            hitpoints: 1000,
        },
        ingredientSlots: [
            { title: 'body', resourceType: 'hide', quantity: 15, contribution: 100 },
            { title: 'binding_and_hardware', resourceType: 'petrochem_inert', quantity: 8, contribution: 100 },
        ],
    },
    pants: {
        name: 'Pants',
        folder: 'object/tangible/wearables/pants',
        craftingTab: 8,
        defaultStats: {
            sockets: 0,
            hitpoints: 1000,
        },
        ingredientSlots: [
            { title: 'body', resourceType: 'hide', quantity: 25, contribution: 100 },
            { title: 'binding_and_hardware', resourceType: 'petrochem_inert', quantity: 12, contribution: 100 },
        ],
    },
    shirt: {
        name: 'Shirt',
        folder: 'object/tangible/wearables/shirt',
        craftingTab: 8,
        defaultStats: {
            sockets: 0,
            hitpoints: 1000,
        },
        ingredientSlots: [
            { title: 'body', resourceType: 'hide', quantity: 20, contribution: 100 },
            { title: 'binding_and_hardware', resourceType: 'petrochem_inert', quantity: 10, contribution: 100 },
        ],
    },
    vest: {
        name: 'Vest',
        folder: 'object/tangible/wearables/vest',
        craftingTab: 8,
        defaultStats: {
            sockets: 0,
            hitpoints: 1000,
        },
        ingredientSlots: [
            { title: 'body', resourceType: 'hide', quantity: 18, contribution: 100 },
            { title: 'binding_and_hardware', resourceType: 'petrochem_inert', quantity: 9, contribution: 100 },
        ],
    },
    robe: {
        name: 'Robe',
        folder: 'object/tangible/wearables/robe',
        craftingTab: 8,
        defaultStats: {
            sockets: 0,
            hitpoints: 1000,
        },
        ingredientSlots: [
            { title: 'body', resourceType: 'hide', quantity: 30, contribution: 100 },
            { title: 'binding_and_hardware', resourceType: 'petrochem_inert', quantity: 15, contribution: 100 },
        ],
    },
    dress: {
        name: 'Dress',
        folder: 'object/tangible/wearables/dress',
        craftingTab: 8,
        defaultStats: {
            sockets: 0,
            hitpoints: 1000,
        },
        ingredientSlots: [
            { title: 'body', resourceType: 'hide', quantity: 25, contribution: 100 },
            { title: 'binding_and_hardware', resourceType: 'petrochem_inert', quantity: 12, contribution: 100 },
        ],
    },
    hat: {
        name: 'Hat',
        folder: 'object/tangible/wearables/hat',
        craftingTab: 8,
        defaultStats: {
            sockets: 0,
            hitpoints: 1000,
        },
        ingredientSlots: [
            { title: 'body', resourceType: 'hide', quantity: 12, contribution: 100 },
            { title: 'binding_and_hardware', resourceType: 'petrochem_inert', quantity: 6, contribution: 100 },
        ],
    },
    bandolier: {
        name: 'Bandolier',
        folder: 'object/tangible/wearables/bandolier',
        craftingTab: 8,
        defaultStats: {
            sockets: 0,
            hitpoints: 1000,
        },
        ingredientSlots: [
            { title: 'body', resourceType: 'hide', quantity: 15, contribution: 100 },
            { title: 'binding_and_hardware', resourceType: 'petrochem_inert', quantity: 8, contribution: 100 },
        ],
    },
    jacket: {
        name: 'Jacket',
        folder: 'object/tangible/wearables/jacket',
        craftingTab: 8,
        defaultStats: {
            sockets: 0,
            hitpoints: 1000,
        },
        ingredientSlots: [
            { title: 'body', resourceType: 'hide', quantity: 22, contribution: 100 },
            { title: 'binding_and_hardware', resourceType: 'petrochem_inert', quantity: 11, contribution: 100 },
        ],
    },
};

/** Default experimentation properties for basic clothing */
export const DEFAULT_EXPERIMENTATION = {
    properties: ['XX', 'XX', 'XX', 'XX'],
    weights: [1, 1, 1, 1],
    groupTitles: ['null', 'null', 'null', 'null'],
    subGroupTitles: ['null', 'null', 'sockets', 'hitpoints'],
    min: [0, 0, 0, 1000],
    max: [0, 0, 0, 1000],
    precision: [0, 0, 0, 0],
    combineType: [0, 0, 4, 4],
};

/** Available crafting skills */
export const CRAFTING_SKILLS = [
    'crafting_tailor_novice',
    'crafting_tailor_master',
    'crafting_armorsmith_novice',
    'crafting_armorsmith_master',
] as const;

/** Available customization color slots */
export const CUSTOMIZATION_SLOTS = {
    single: {
        options: [2],
        stringNames: ['/private/index_color_1'],
        defaults: [19],
    },
    dual: {
        options: [2, 2],
        stringNames: ['/private/index_color_1', '/private/index_color_2'],
        defaults: [19, 19],
    },
};
