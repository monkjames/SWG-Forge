/**
 * Walkway Builder — generates the complete object chain for a walkway tile variant.
 *
 * Per variant:
 *   TRE: LAY + SFP (shared) + 4 IFFs + CRC entries + STF entries
 *   Lua: 5 templates + 9 registration appends
 *
 * The 5-layer chain:
 *   Building → Deed → Draft Schematic → Loot Schematic → Loot Item
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    parseIFF, serializeIFF,
    parseCRCTable, serializeCRCTable, addCRCEntries,
    parseSTF, serializeSTF, addSTFEntries,
    serializeLAY, createWalkwayLAY, createCircleLAY,
    generateSFP, serializeSFP,
} from '@swgemu/core';
import type {
    LAYData, ShaderFamily, LAYAffector, LAYBoundary,
} from '@swgemu/core';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type WalkwayShape = 'square' | 'circle' | 'rectangle' | 'sidewalk' | 'scurve' | 'scurve_r';

export type WalkwayEffect =
    | 'texture_only'
    | 'texture_flatten'
    | 'flatten_only'
    | 'flora_clear'
    | 'flora_flatten';

export interface WalkwayConfig {
    shape: WalkwayShape;
    size: number;               // primary dimension in meters (bounding box for scurve)
    width?: number;             // rectangle/sidewalk width, scurve path width
    height?: number;            // rectangle/sidewalk height
    texture: string;            // texture key (e.g. 'duracrete')
    effect: WalkwayEffect;
    featheringType: number;     // 0=linear, 1=x², 2=sqrt, 3=smoothstep
    featheringAmount: number;   // 0.0–1.0
    displayName: string;        // human-readable name
}

export interface FileOutput {
    path: string;
    content: string;
}

export interface BinaryFileOutput {
    path: string;
    data: Uint8Array;
}

export interface GeneratedWalkway {
    name: string;                   // e.g. 'walkway_square_32_duracrete'
    sfpKey: string;                 // e.g. 'walkway_square_32'

    // TRE binary files
    layFile: BinaryFileOutput;
    sfpFile: BinaryFileOutput;
    buildingIFF: BinaryFileOutput;
    deedIFF: BinaryFileOutput;
    schematicIFF: BinaryFileOutput;
    lootSchematicIFF: BinaryFileOutput;

    // Lua template files
    buildingLua: FileOutput;
    deedLua: FileOutput;
    schematicLua: FileOutput;
    lootSchematicLua: FileOutput;
    lootItemLua: FileOutput;

    // Registration appends (content to append to existing files)
    buildingObjectsLua: FileOutput;
    buildingServerObjectsLua: FileOutput;
    deedObjectsLua: FileOutput;
    deedServerObjectsLua: FileOutput;
    schematicObjectsLua: FileOutput;
    schematicServerObjectsLua: FileOutput;
    lootSchematicObjectsLua: FileOutput;
    lootSchematicServerObjectsLua: FileOutput;
    lootItemServerObjectsLua: FileOutput;

    // Post-gen data
    crcPaths: string[];
    stfEntries: { file: string; key: string; value: string }[];
}

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

export const SHAPES: { value: WalkwayShape; label: string }[] = [
    { value: 'square', label: 'Square' },
    { value: 'circle', label: 'Circle' },
    { value: 'rectangle', label: 'Rectangle' },
    { value: 'sidewalk', label: 'Sidewalk' },
    { value: 'scurve', label: 'S-Curve (Right)' },
    { value: 'scurve_r', label: 'S-Curve (Left)' },
];

export const SIZES: Record<WalkwayShape, { value: number; label: string; width?: number; height?: number }[]> = {
    square: [
        { value: 32, label: '32m' },
        { value: 48, label: '48m' },
        { value: 64, label: '64m' },
        { value: 96, label: '96m' },
        { value: 128, label: '128m' },
    ],
    circle: [
        { value: 32, label: '32m diameter' },
        { value: 48, label: '48m diameter' },
        { value: 64, label: '64m diameter' },
        { value: 96, label: '96m diameter' },
    ],
    rectangle: [
        { value: 32, label: '32x64m', width: 32, height: 64 },
        { value: 48, label: '48x96m', width: 48, height: 96 },
        { value: 64, label: '64x128m', width: 64, height: 128 },
    ],
    sidewalk: [
        { value: 4, label: '4x16m', width: 4, height: 16 },
        { value: 4, label: '4x32m', width: 4, height: 32 },
        { value: 4, label: '4x64m', width: 4, height: 64 },
        { value: 8, label: '8x32m', width: 8, height: 32 },
        { value: 8, label: '8x64m', width: 8, height: 64 },
        { value: 12, label: '12x48m', width: 12, height: 48 },
        { value: 12, label: '12x96m', width: 12, height: 96 },
    ],
    scurve: [
        { value: 16, label: '16m box, 4m path', width: 4, height: 16 },
        { value: 16, label: '16m box, 8m path', width: 8, height: 16 },
        { value: 32, label: '32m box, 4m path', width: 4, height: 32 },
        { value: 32, label: '32m box, 8m path', width: 8, height: 32 },
    ],
    scurve_r: [
        { value: 16, label: '16m box, 4m path', width: 4, height: 16 },
        { value: 16, label: '16m box, 8m path', width: 8, height: 16 },
        { value: 32, label: '32m box, 4m path', width: 4, height: 32 },
        { value: 32, label: '32m box, 8m path', width: 8, height: 32 },
    ],
};

export interface TextureInfo {
    key: string;
    label: string;
    shader: string;          // SWG shader file path
    rarity: string;          // 'common' | 'uncommon' | 'rare'
}

export const TEXTURES: TextureInfo[] = [
    { key: 'duracrete',         label: 'Duracrete',              shader: 'terrain/naboo_cobblestone.sht',       rarity: 'common' },
    { key: 'duracrete_dark',    label: 'Duracrete (Dark)',       shader: 'terrain/corellia_cobblestone.sht',    rarity: 'common' },
    { key: 'duracrete_weath',   label: 'Duracrete (Weathered)', shader: 'terrain/tatooine_cobblestone.sht',    rarity: 'common' },
    { key: 'marble_white',      label: 'Marble (White)',         shader: 'terrain/naboo_marble.sht',            rarity: 'uncommon' },
    { key: 'marble_black',      label: 'Marble (Black)',         shader: 'terrain/dathomir_rock.sht',           rarity: 'uncommon' },
    { key: 'marble_veined',     label: 'Marble (Veined)',        shader: 'terrain/naboo_rock.sht',              rarity: 'uncommon' },
    { key: 'flagstone',         label: 'Flagstone',              shader: 'terrain/corellia_rock.sht',           rarity: 'common' },
    { key: 'flagstone_mossy',   label: 'Flagstone (Mossy)',      shader: 'terrain/yavin4_rock.sht',             rarity: 'uncommon' },
    { key: 'sand_compact',      label: 'Sand (Compacted)',       shader: 'terrain/tatooine_sand.sht',           rarity: 'common' },
    { key: 'cobblestone',       label: 'Cobblestone',            shader: 'terrain/lok_cobblestone.sht',         rarity: 'common' },
    { key: 'metal_grating',     label: 'Metal Grating',         shader: 'terrain/endor_rock.sht',              rarity: 'uncommon' },
    { key: 'wood_planks',       label: 'Wooden Planks',          shader: 'terrain/kashyyyk_wooden.sht',         rarity: 'uncommon' },
    { key: 'grass_turf',        label: 'Grass (Maintained)',     shader: 'terrain/naboo_grass.sht',             rarity: 'common' },
    { key: 'permacrete',        label: 'Permacrete',             shader: 'terrain/talus_cobblestone.sht',       rarity: 'common' },
    { key: 'gravel',            label: 'Gravel',                 shader: 'terrain/rori_rock.sht',               rarity: 'common' },
    { key: 'tile_decorative',   label: 'Tile (Decorative)',      shader: 'terrain/naboo_tile.sht',              rarity: 'rare' },
    { key: 'brick',             label: 'Brick',                  shader: 'terrain/corellia_rock2.sht',          rarity: 'common' },
    { key: 'sandstone',         label: 'Sandstone',              shader: 'terrain/tatooine_rock.sht',           rarity: 'common' },
    { key: 'obsidian',          label: 'Obsidian',               shader: 'terrain/mustafar_rock.sht',           rarity: 'rare' },
    { key: 'snow_packed',       label: 'Snow (Packed)',          shader: 'terrain/hoth_snow.sht',               rarity: 'rare' },
];

export const EFFECTS: { value: WalkwayEffect; label: string }[] = [
    { value: 'texture_flatten', label: 'Texture + Flatten (Recommended)' },
    { value: 'texture_only',    label: 'Texture Only' },
    { value: 'flatten_only',    label: 'Flatten Only' },
    { value: 'flora_clear',     label: 'Flora Clear' },
    { value: 'flora_flatten',   label: 'Flora + Flatten' },
];

// ═══════════════════════════════════════════════════════════════════
// Naming helpers
// ═══════════════════════════════════════════════════════════════════

export function getWalkwayName(config: WalkwayConfig): string {
    const shape = config.shape;
    if (shape === 'rectangle' || shape === 'sidewalk') {
        const w = config.width || config.size;
        const h = config.height || config.size * 2;
        return `walkway_${shape}_${w}x${h}_${config.texture}`;
    }
    if (shape === 'scurve' || shape === 'scurve_r') {
        const pathW = config.width || 4;
        return `walkway_${shape}_${config.size}w${pathW}_${config.texture}`;
    }
    return `walkway_${shape}_${config.size}_${config.texture}`;
}

export function getSfpKey(config: WalkwayConfig): string {
    const shape = config.shape;
    if (shape === 'rectangle' || shape === 'sidewalk') {
        const w = config.width || config.size;
        const h = config.height || config.size * 2;
        return `walkway_${shape}_${w}x${h}`;
    }
    if (shape === 'scurve' || shape === 'scurve_r') {
        // Both chiralities share the same SFP footprint (same bounding box)
        const pathW = config.width || 4;
        return `walkway_scurve_${config.size}w${pathW}`;
    }
    return `walkway_${shape}_${config.size}`;
}

function getDimensions(config: WalkwayConfig): { width: number; height: number } {
    if (config.shape === 'rectangle' || config.shape === 'sidewalk') {
        return {
            width: config.width || config.size,
            height: config.height || config.size * 2,
        };
    }
    if (config.shape === 'scurve' || config.shape === 'scurve_r') {
        return { width: config.size, height: config.size };
    }
    return { width: config.size, height: config.size };
}

// ═══════════════════════════════════════════════════════════════════
// IFF cloning — parse, replace strings in chunk data, re-serialize
// ═══════════════════════════════════════════════════════════════════

interface StringReplacement {
    oldString: string;
    newString: string;
}

function cloneIFFSafe(data: Uint8Array, replacements: StringReplacement[]): Uint8Array {
    const root = parseIFF(data);

    function replaceInBuffer(buf: Uint8Array): Uint8Array {
        let result = Buffer.from(buf);
        for (const rep of replacements) {
            const search = Buffer.from(rep.oldString, 'binary');
            const replace = Buffer.from(rep.newString, 'binary');
            let pos = 0;
            while (true) {
                const idx = result.indexOf(search, pos);
                if (idx === -1) break;
                const newBuf = Buffer.alloc(result.length - search.length + replace.length);
                result.copy(newBuf, 0, 0, idx);
                replace.copy(newBuf, idx);
                result.copy(newBuf, idx + replace.length, idx + search.length);
                result = newBuf;
                pos = idx + replace.length;
            }
        }
        return new Uint8Array(result);
    }

    function walkAndReplace(node: any): void {
        if (node.data) {
            node.data = replaceInBuffer(node.data);
        }
        if (node.children) {
            for (const child of node.children) {
                walkAndReplace(child);
            }
        }
    }

    walkAndReplace(root);
    return serializeIFF(root);
}

// ═══════════════════════════════════════════════════════════════════
// TRE file generators
// ═══════════════════════════════════════════════════════════════════

function generateLAYFile(config: WalkwayConfig): Uint8Array {
    const texture = TEXTURES.find(t => t.key === config.texture);
    const shaderFile = texture?.shader;

    const needsTexture = config.effect === 'texture_only' || config.effect === 'texture_flatten';
    const needsFlatten = config.effect === 'texture_flatten' || config.effect === 'flatten_only' || config.effect === 'flora_flatten';
    const needsFlora = config.effect === 'flora_clear' || config.effect === 'flora_flatten';

    const dims = getDimensions(config);

    if (config.shape === 'circle') {
        const lay = createCircleLAY({
            radius: config.size / 2,
            flatten: needsFlatten,
            shaderFileName: needsTexture ? shaderFile : undefined,
            shaderFamilyName: needsTexture ? (texture?.label || 'Walkway') : undefined,
            removeFlora: needsFlora,
            featheringType: config.featheringType,
            featheringAmount: config.featheringAmount,
            description: config.displayName,
        });
        return serializeLAY(lay);
    }

    if (config.shape === 'scurve' || config.shape === 'scurve_r') {
        const lay = createSCurveLAY({
            boxSize: config.size,
            pathWidth: config.width || 4,
            mirror: config.shape === 'scurve_r',
            flatten: needsFlatten,
            shaderFileName: needsTexture ? shaderFile : undefined,
            shaderFamilyName: needsTexture ? (texture?.label || 'S-Curve') : undefined,
            removeFlora: needsFlora,
            featheringType: config.featheringType,
            featheringAmount: config.featheringAmount,
            description: config.displayName,
        });
        return serializeLAY(lay);
    }

    const lay = createWalkwayLAY({
        width: dims.width,
        height: dims.height,
        flatten: needsFlatten,
        shaderFileName: needsTexture ? shaderFile : undefined,
        shaderFamilyName: needsTexture ? (texture?.label || 'Walkway') : undefined,
        removeFlora: needsFlora,
        featheringType: config.featheringType,
        featheringAmount: config.featheringAmount,
        description: config.displayName,
    });
    return serializeLAY(lay);
}

/**
 * Create a LAY file with a polyline boundary tracing an S-curve.
 * The S enters at bottom-center, curves right, crosses, curves left, exits top-center.
 */
function createSCurveLAY(options: {
    boxSize: number;
    pathWidth: number;
    mirror?: boolean;           // true = reversed S (curves left first)
    flatten: boolean;
    shaderFileName?: string;
    shaderFamilyName?: string;
    removeFlora?: boolean;
    featheringType?: number;
    featheringAmount?: number;
    description?: string;
}): LAYData {
    const half = options.boxSize / 2;
    const desc = options.description || 'S-Curve Walkway';
    const featherType = options.featheringType ?? 3;
    const featherAmt = options.featheringAmount ?? 0.25;

    // S-curve amplitude: how far left/right it swings
    // Scale to ~40% of the half-box so the path stays within bounds
    const amp = half * 0.4;

    // Mirror flips the x-coordinates to reverse the S chirality
    // Standard S: curves right first, then left
    // Mirrored S: curves left first, then right
    const m = options.mirror ? -1 : 1;

    // Generate S-curve vertices: bottom to top, 6 control points
    // The polyline interpolates between these with lineWidth for the road width
    const vertices = [
        { x: 0,        y: -half },         // bottom center (entry)
        { x:  amp * m, y: -half * 0.5 },   // curve right (or left if mirrored)
        { x:  amp * m, y: -half * 0.1 },   // hold near center
        { x: -amp * m, y:  half * 0.1 },   // cross to opposite side
        { x: -amp * m, y:  half * 0.5 },   // hold
        { x: 0,        y:  half },          // top center (exit)
    ];

    const shaderFamilies: ShaderFamily[] = [];
    const affectors: LAYAffector[] = [];

    if (options.shaderFileName) {
        const familyId = 1;
        shaderFamilies.push({
            familyId,
            familyName: options.shaderFamilyName || 'S-Curve',
            fileName: options.shaderFileName,
            red: 128, green: 128, blue: 128,
            var7: 0,
            weight: 1.0,
            children: [],
        });
        affectors.push({
            affectorType: 'ASCN',
            enabled: true,
            description: 'AffectorShaderConstant',
            familyId,
            featheringType: featherType,
            featheringAmount: featherAmt,
        });
    }

    if (options.flatten) {
        affectors.push({
            affectorType: 'AHCN',
            enabled: true,
            description: 'AffectorHeightConstant',
            operationType: 0,
            height: 0,
        });
    }

    if (options.removeFlora) {
        affectors.push({
            affectorType: 'AFSN',
            enabled: true,
            description: 'AffectorFloraNonCollidableConstant',
            familyId: 1, var2: 1, flag: 1,
            featheringType: 0, featheringAmount: 1.0,
        });
        affectors.push({
            affectorType: 'AFSC',
            enabled: true,
            description: 'AffectorFloraCollidableConstant',
            familyId: 1, var2: 1, flag: 1,
            featheringType: 0, featheringAmount: 1.0,
        });
    }

    const boundary: LAYBoundary = {
        type: 'BPLN',
        enabled: true,
        description: 'BoundaryPolyline',
        vertices,
        featheringType: featherType,
        featheringAmount: featherAmt,
        lineWidth: options.pathWidth,
    };

    return {
        shaderFamilies,
        floraFamilies: [],
        radialFamilies: [],
        environmentEntries: [],
        mapFamilies: [],
        groupVersions: { sgrp: '0006', fgrp: '0008', rgrp: '0003', egrp: '0002', mgrp: '0000' },
        layers: [{
            enabled: true,
            description: desc,
            boundariesFlag: 0,
            filterFlag: 0,
            var3: 1,
            var4: '',
            boundaries: [boundary],
            affectors,
            filters: [],
            children: [],
        }],
    };
}

function generateSFPFile(config: WalkwayConfig): Uint8Array {
    const dims = getDimensions(config);
    const sfp = generateSFP(dims.width, dims.height, 4);
    return serializeSFP(sfp);
}

// ═══════════════════════════════════════════════════════════════════
// Source IFF finder
// ═══════════════════════════════════════════════════════════════════

function findSourceIFF(wsRoot: string, relPath: string): Uint8Array | null {
    const paths = [
        path.join(wsRoot, 'tre/vanilla', relPath),
        path.join(wsRoot, 'tre/infinity', relPath),
        path.join(wsRoot, 'tre/working', relPath),
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            return new Uint8Array(fs.readFileSync(p));
        }
    }
    return null;
}

// Source IFF templates to clone from
const SOURCE_BUILDING_IFF = 'object/building/player/city/shared_garden_corellia_sml_01.iff';
const SOURCE_DEED_IFF = 'object/tangible/deed/city_deed/shared_garden_corellia_sml_01_deed.iff';
const SOURCE_SCHEMATIC_IFF = 'object/draft_schematic/structure/city/shared_garden_small.iff';
const SOURCE_LOOT_SCHEM_IFF = 'object/tangible/loot/loot_schematic/shared_agitator_motor_schematic.iff';

// STF key in the source IFFs (the part we replace)
const SOURCE_BUILDING_KEY = 'garden_corellia_sml_01';
const SOURCE_DEED_KEY = 'garden_corellia_sml_01';
const SOURCE_SCHEMATIC_KEY = 'garden_small';
const SOURCE_LOOT_SCHEM_KEY = 'agitator_motor_schematic';

// ═══════════════════════════════════════════════════════════════════
// Lua generators
// ═══════════════════════════════════════════════════════════════════

function generateBuildingLua(name: string, config: WalkwayConfig): string {
    const dims = getDimensions(config);
    const sfpKey = getSfpKey(config);
    const lengthWidth = Math.max(1, Math.ceil(Math.max(dims.width, dims.height) / 8));

    return [
        `object_building_player_city_${name} = object_building_player_city_shared_${name}:new {`,
        `\tlotSize = 0,`,
        `\tbaseMaintenanceRate = 0,`,
        `\tallowedZones = {"dantooine", "lok", "tatooine", "naboo", "rori", "corellia", "talus"},`,
        `\tlength = ${lengthWidth},`,
        `\twidth = ${lengthWidth},`,
        `\tcityRankRequired = 1,`,
        `\tcityMaintenanceBase = 500,`,
        `\tabilityRequired = "place_walkway",`,
        `\tgroundZoneComponent = "StructureZoneComponent",`,
        `\tdataObjectComponent = "DecorationDataComponent",`,
        `\tterrainModificationFileName = "terrain/${name}.lay",`,
        `\tstructureFootprintFileName = "footprint/${sfpKey}.sfp",`,
        `\tchildObjects = {`,
        `\t\t{templateFile = "object/tangible/terminal/terminal_player_structure_nosnap_mini.iff", x = 0, z = 0, y = 0, ox = 0, oy = 0, oz = 0, ow = 1, cellid = -1, containmentType = -1}`,
        `\t}`,
        `}`,
        ``,
        `ObjectTemplates:addTemplate(object_building_player_city_${name}, "object/building/player/city/${name}.iff")`,
        ``,
    ].join('\n');
}

function generateDeedLua(name: string): string {
    return [
        `object_tangible_deed_city_deed_${name}_deed = object_tangible_deed_city_deed_shared_${name}_deed:new {`,
        `\ttemplateType = STRUCTUREDEED,`,
        `\tplaceStructureComponent = "PlaceDecorationComponent",`,
        `\tgameObjectType = 8388609,`,
        `\tgeneratedObjectTemplate = "object/building/player/city/${name}.iff",`,
        ``,
        `\tnumberExperimentalProperties = {1, 1, 1},`,
        `\texperimentalProperties = {"XX", "XX", "XX"},`,
        `\texperimentalWeights = {1, 1, 1},`,
        `\texperimentalGroupTitles = {"null", "null", "null"},`,
        `\texperimentalSubGroupTitles = {"null", "null", "hitpoints"},`,
        `\texperimentalMin = {0, 0, 35000},`,
        `\texperimentalMax = {0, 0, 75000},`,
        `\texperimentalPrecision = {0, 0, 0},`,
        `\texperimentalCombineType = {0, 0, 4},`,
        `}`,
        ``,
        `ObjectTemplates:addTemplate(object_tangible_deed_city_deed_${name}_deed, "object/tangible/deed/city_deed/${name}_deed.iff")`,
        ``,
    ].join('\n');
}

function generateSchematicLua(name: string, displayName: string): string {
    return [
        `object_draft_schematic_structure_city_${name}_schem = object_draft_schematic_structure_city_shared_${name}_schem:new {`,
        `\ttemplateType = DRAFTSCHEMATIC,`,
        ``,
        `\tcustomObjectName = "Deed for: ${displayName}",`,
        ``,
        `\tcraftingToolTab = 1024,`,
        `\tcomplexity = 1,`,
        `\tsize = 2,`,
        `\tfactoryCrateSize = 5000,`,
        `\tfactoryCrateType = "object/factory/factory_crate_installation.iff",`,
        ``,
        `\txpType = "crafting_structure_general",`,
        `\txp = 2000,`,
        ``,
        `\tassemblySkill = "structure_assembly",`,
        `\texperimentingSkill = "structure_experimentation",`,
        `\tcustomizationSkill = "structure_customization",`,
        ``,
        `\tcustomizationOptions = {},`,
        `\tcustomizationStringNames = {},`,
        `\tcustomizationDefaults = {},`,
        ``,
        `\tingredientTemplateNames = {"craft_structure_ingredients_n", "craft_structure_ingredients_n"},`,
        `\tingredientTitleNames = {"artistic_medium", "decorative_trim"},`,
        `\tingredientSlotType = {0, 0},`,
        `\tresourceTypes = {"ore", "gemstone"},`,
        `\tresourceQuantities = {2000, 1000},`,
        `\tcontribution = {100, 100},`,
        ``,
        `\ttargetTemplate = "object/tangible/deed/city_deed/${name}_deed.iff",`,
        `\tadditionalTemplates = {}`,
        `}`,
        ``,
        `ObjectTemplates:addTemplate(object_draft_schematic_structure_city_${name}_schem, "object/draft_schematic/structure/city/${name}_schem.iff")`,
        ``,
    ].join('\n');
}

function generateLootSchematicLua(name: string): string {
    return [
        `object_tangible_loot_loot_schematic_${name}_loot_schem = object_tangible_loot_loot_schematic_shared_${name}_loot_schem:new {`,
        `\ttemplateType = LOOTSCHEMATIC,`,
        `\tobjectMenuComponent = "LootSchematicMenuComponent",`,
        `\tattributeListComponent = "LootSchematicAttributeListComponent",`,
        `\trequiredSkill = "crafting_architect_master",`,
        `\ttargetDraftSchematic = "object/draft_schematic/structure/city/${name}_schem.iff",`,
        `\ttargetUseCount = 1,`,
        `}`,
        ``,
        `ObjectTemplates:addTemplate(object_tangible_loot_loot_schematic_${name}_loot_schem, "object/tangible/loot/loot_schematic/${name}_loot_schem.iff")`,
        ``,
    ].join('\n');
}

function generateLootItemLua(name: string): string {
    return [
        `${name} = {`,
        `\tminimumLevel = 0,`,
        `\tmaximumLevel = -1,`,
        `\tcustomObjectName = "",`,
        `\tdirectObjectTemplate = "object/tangible/loot/loot_schematic/${name}_loot_schem.iff",`,
        `\tcraftingValues = {},`,
        `\tcustomizationStringNames = {},`,
        `\tcustomizationValues = {}`,
        `}`,
        ``,
        `addLootItemTemplate("${name}", ${name})`,
        ``,
    ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// Registration snippet generators
// ═══════════════════════════════════════════════════════════════════

function buildingObjectsEntry(name: string): string {
    return [
        ``,
        `object_building_player_city_shared_${name} = SharedBuildingObjectTemplate:new {`,
        `\tclientTemplateFileName = "object/building/player/city/shared_${name}.iff"`,
        `}`,
        `ObjectTemplates:addClientTemplate(object_building_player_city_shared_${name}, "object/building/player/city/shared_${name}.iff")`,
    ].join('\n');
}

function deedObjectsEntry(name: string): string {
    return [
        ``,
        `object_tangible_deed_city_deed_shared_${name}_deed = SharedTangibleObjectTemplate:new {`,
        `\tclientTemplateFileName = "object/tangible/deed/city_deed/shared_${name}_deed.iff"`,
        `}`,
        `ObjectTemplates:addClientTemplate(object_tangible_deed_city_deed_shared_${name}_deed, "object/tangible/deed/city_deed/shared_${name}_deed.iff")`,
    ].join('\n');
}

function schematicObjectsEntry(name: string): string {
    return [
        ``,
        `object_draft_schematic_structure_city_shared_${name}_schem = SharedDraftSchematicObjectTemplate:new {`,
        `\tclientTemplateFileName = "object/draft_schematic/structure/city/shared_${name}_schem.iff"`,
        `}`,
        `ObjectTemplates:addClientTemplate(object_draft_schematic_structure_city_shared_${name}_schem, "object/draft_schematic/structure/city/shared_${name}_schem.iff")`,
    ].join('\n');
}

function lootSchematicObjectsEntry(name: string): string {
    return [
        ``,
        `object_tangible_loot_loot_schematic_shared_${name}_loot_schem = SharedTangibleObjectTemplate:new {`,
        `\tclientTemplateFileName = "object/tangible/loot/loot_schematic/shared_${name}_loot_schem.iff"`,
        `}`,
        `ObjectTemplates:addClientTemplate(object_tangible_loot_loot_schematic_shared_${name}_loot_schem, "object/tangible/loot/loot_schematic/shared_${name}_loot_schem.iff")`,
    ].join('\n');
}

function serverObjectsInclude(relPath: string): string {
    return `includeFile("../custom_scripts/${relPath}")`;
}

// ═══════════════════════════════════════════════════════════════════
// Main generator
// ═══════════════════════════════════════════════════════════════════

export function generateWalkway(config: WalkwayConfig, wsRoot: string): GeneratedWalkway {
    const name = getWalkwayName(config);
    const sfpKey = getSfpKey(config);

    // ── TRE: LAY file ──
    const layData = generateLAYFile(config);

    // ── TRE: SFP file ──
    const sfpData = generateSFPFile(config);

    // ── TRE: Clone IFFs ──
    const srcBuilding = findSourceIFF(wsRoot, SOURCE_BUILDING_IFF);
    const srcDeed = findSourceIFF(wsRoot, SOURCE_DEED_IFF);
    const srcSchematic = findSourceIFF(wsRoot, SOURCE_SCHEMATIC_IFF);
    const srcLootSchem = findSourceIFF(wsRoot, SOURCE_LOOT_SCHEM_IFF);

    let buildingIFFData: Uint8Array;
    let deedIFFData: Uint8Array;
    let schematicIFFData: Uint8Array;
    let lootSchematicIFFData: Uint8Array;

    if (srcBuilding) {
        buildingIFFData = cloneIFFSafe(srcBuilding, [
            { oldString: '\x00\x01' + SOURCE_BUILDING_KEY + '\x00', newString: '\x00\x01' + name + '\x00' },
        ]);
    } else {
        buildingIFFData = new Uint8Array(0);
    }

    if (srcDeed) {
        deedIFFData = cloneIFFSafe(srcDeed, [
            { oldString: '\x00\x01' + SOURCE_DEED_KEY + '\x00', newString: '\x00\x01' + name + '\x00' },
        ]);
    } else {
        deedIFFData = new Uint8Array(0);
    }

    if (srcSchematic) {
        schematicIFFData = cloneIFFSafe(srcSchematic, [
            { oldString: '\x00\x01' + SOURCE_SCHEMATIC_KEY + '\x00', newString: '\x00\x01' + name + '_schem\x00' },
        ]);
    } else {
        schematicIFFData = new Uint8Array(0);
    }

    if (srcLootSchem) {
        lootSchematicIFFData = cloneIFFSafe(srcLootSchem, [
            { oldString: '\x00\x01' + SOURCE_LOOT_SCHEM_KEY + '\x00', newString: '\x00\x01' + name + '_loot_schem\x00' },
        ]);
    } else {
        lootSchematicIFFData = new Uint8Array(0);
    }

    // ── Lua paths ──
    const csBase = 'custom_scripts/object';
    const lootBase = 'custom_scripts/loot';

    // ── CRC paths ──
    const crcPaths = [
        `object/building/player/city/shared_${name}.iff`,
        `object/tangible/deed/city_deed/shared_${name}_deed.iff`,
        `object/draft_schematic/structure/city/shared_${name}_schem.iff`,
        `object/tangible/loot/loot_schematic/shared_${name}_loot_schem.iff`,
    ];

    // ── STF entries ──
    const stfEntries = [
        { file: 'string/en/city_n.stf', key: name, value: config.displayName },
        { file: 'string/en/city_d.stf', key: name, value: `A ${config.displayName.toLowerCase()} walkway tile.` },
        { file: 'string/en/city_n.stf', key: name + '_deed', value: `Deed for: ${config.displayName}` },
        { file: 'string/en/city_d.stf', key: name + '_deed', value: `A deed for a ${config.displayName.toLowerCase()} walkway tile.` },
    ];

    return {
        name,
        sfpKey,

        layFile: { path: `terrain/${name}.lay`, data: layData },
        sfpFile: { path: `footprint/${sfpKey}.sfp`, data: sfpData },
        buildingIFF: { path: `object/building/player/city/shared_${name}.iff`, data: buildingIFFData },
        deedIFF: { path: `object/tangible/deed/city_deed/shared_${name}_deed.iff`, data: deedIFFData },
        schematicIFF: { path: `object/draft_schematic/structure/city/shared_${name}_schem.iff`, data: schematicIFFData },
        lootSchematicIFF: { path: `object/tangible/loot/loot_schematic/shared_${name}_loot_schem.iff`, data: lootSchematicIFFData },

        buildingLua: {
            path: `${csBase}/building/player/city/${name}.lua`,
            content: generateBuildingLua(name, config),
        },
        deedLua: {
            path: `${csBase}/tangible/deed/city_deed/${name}_deed.lua`,
            content: generateDeedLua(name),
        },
        schematicLua: {
            path: `${csBase}/draft_schematic/structure/city/${name}_schem.lua`,
            content: generateSchematicLua(name, config.displayName),
        },
        lootSchematicLua: {
            path: `${csBase}/tangible/loot/loot_schematic/${name}_loot_schem.lua`,
            content: generateLootSchematicLua(name),
        },
        lootItemLua: {
            path: `${lootBase}/items/loot_schematic/structure/${name}.lua`,
            content: generateLootItemLua(name),
        },

        buildingObjectsLua: {
            path: `${csBase}/building/player/objects.lua`,
            content: buildingObjectsEntry(name),
        },
        buildingServerObjectsLua: {
            path: `${csBase}/building/player/serverobjects.lua`,
            content: serverObjectsInclude(`object/building/player/city/${name}.lua`),
        },
        deedObjectsLua: {
            path: `${csBase}/tangible/deed/city_deed/objects.lua`,
            content: deedObjectsEntry(name),
        },
        deedServerObjectsLua: {
            path: `${csBase}/tangible/deed/city_deed/serverobjects.lua`,
            content: serverObjectsInclude(`object/tangible/deed/city_deed/${name}_deed.lua`),
        },
        schematicObjectsLua: {
            path: `${csBase}/draft_schematic/structure/city/objects.lua`,
            content: schematicObjectsEntry(name),
        },
        schematicServerObjectsLua: {
            path: `${csBase}/draft_schematic/structure/city/serverobjects.lua`,
            content: serverObjectsInclude(`object/draft_schematic/structure/city/${name}_schem.lua`),
        },
        lootSchematicObjectsLua: {
            path: `${csBase}/tangible/loot/loot_schematic/objects.lua`,
            content: lootSchematicObjectsEntry(name),
        },
        lootSchematicServerObjectsLua: {
            path: `${csBase}/tangible/loot/loot_schematic/serverobjects.lua`,
            content: serverObjectsInclude(`object/tangible/loot/loot_schematic/${name}_loot_schem.lua`),
        },
        lootItemServerObjectsLua: {
            path: `${lootBase}/items/loot_schematic/structure/serverobjects.lua`,
            content: serverObjectsInclude(`loot/items/loot_schematic/structure/${name}.lua`),
        },

        crcPaths,
        stfEntries,
    };
}

// ═══════════════════════════════════════════════════════════════════
// Batch generator — all textures for one shape+size
// ═══════════════════════════════════════════════════════════════════

export function generateBatch(
    shape: WalkwayShape,
    size: number,
    effect: WalkwayEffect,
    featheringType: number,
    featheringAmount: number,
    wsRoot: string,
    width?: number,
    height?: number,
): GeneratedWalkway[] {
    return TEXTURES.map(tex => {
        const displayName = `${tex.label} ${shape.charAt(0).toUpperCase() + shape.slice(1)} ${size}m`;
        return generateWalkway({
            shape,
            size,
            width,
            height,
            texture: tex.key,
            effect,
            featheringType,
            featheringAmount,
            displayName,
        }, wsRoot);
    });
}

// ═══════════════════════════════════════════════════════════════════
// File writer — writes all generated files to disk
// ═══════════════════════════════════════════════════════════════════

function ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function readOrCreate(filePath: string): string {
    ensureDir(filePath);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', 'utf8');
        return '';
    }
    return fs.readFileSync(filePath, 'utf8');
}

export interface WriteResult {
    written: number;
    appended: number;
    skipped: number;
    errors: string[];
    files: string[];
}

export function writeWalkwayFiles(
    result: GeneratedWalkway,
    wsRoot: string,
): WriteResult {
    const treBase = path.join(wsRoot, 'tre/working');
    const luaBase = path.join(wsRoot, 'infinity_jtl/MMOCoreORB/bin/scripts');
    const stats: WriteResult = { written: 0, appended: 0, skipped: 0, errors: [], files: [] };

    // ── Write TRE binary files ──
    const binFiles = [
        result.layFile,
        result.sfpFile,
        result.buildingIFF,
        result.deedIFF,
        result.schematicIFF,
        result.lootSchematicIFF,
    ];
    for (const f of binFiles) {
        if (f.data.length === 0) {
            stats.errors.push(`Skipped ${f.path} — source IFF not found`);
            stats.skipped++;
            continue;
        }
        const fullPath = path.join(treBase, f.path);
        ensureDir(fullPath);
        fs.writeFileSync(fullPath, f.data);
        stats.written++;
        stats.files.push(f.path);
    }

    // ── Write Lua template files ──
    const luaFiles = [
        result.buildingLua,
        result.deedLua,
        result.schematicLua,
        result.lootSchematicLua,
        result.lootItemLua,
    ];
    for (const f of luaFiles) {
        const fullPath = path.join(luaBase, f.path);
        ensureDir(fullPath);
        fs.writeFileSync(fullPath, f.content, 'utf8');
        stats.written++;
        stats.files.push(f.path);
    }

    // ── Append to registration files (deduplicate) ──
    const appendFiles = [
        result.buildingObjectsLua,
        result.buildingServerObjectsLua,
        result.deedObjectsLua,
        result.deedServerObjectsLua,
        result.schematicObjectsLua,
        result.schematicServerObjectsLua,
        result.lootSchematicObjectsLua,
        result.lootSchematicServerObjectsLua,
        result.lootItemServerObjectsLua,
    ];
    for (const f of appendFiles) {
        const fullPath = path.join(luaBase, f.path);
        const existing = readOrCreate(fullPath);
        // Check if content (trimmed) is already present
        const trimmed = f.content.trim();
        if (existing.includes(trimmed)) {
            stats.skipped++;
            continue;
        }
        fs.appendFileSync(fullPath, '\n' + f.content + '\n', 'utf8');
        stats.appended++;
        stats.files.push(f.path + ' (appended)');
    }

    return stats;
}

// ═══════════════════════════════════════════════════════════════════
// Post-gen: CRC registration
// ═══════════════════════════════════════════════════════════════════

export function registerCRC(wsRoot: string, crcPaths: string[]): { success: boolean; message: string } {
    const treBase = path.join(wsRoot, 'tre/working');
    const crcRelPath = 'misc/object_template_crc_string_table.iff';
    const crcFullPath = path.join(treBase, crcRelPath);

    // Seed from vanilla/infinity if not in working
    if (!fs.existsSync(crcFullPath)) {
        const vanillaPath = path.join(wsRoot, 'tre/vanilla', crcRelPath);
        const infinityPath = path.join(wsRoot, 'tre/infinity', crcRelPath);
        const src = fs.existsSync(vanillaPath) ? vanillaPath : fs.existsSync(infinityPath) ? infinityPath : null;
        if (!src) return { success: false, message: 'CRC table not found in vanilla or infinity' };
        ensureDir(crcFullPath);
        fs.copyFileSync(src, crcFullPath);
    }

    const data = new Uint8Array(fs.readFileSync(crcFullPath));
    const table = parseCRCTable(data);
    addCRCEntries(table, crcPaths);
    fs.writeFileSync(crcFullPath, serializeCRCTable(table));

    return { success: true, message: `Added ${crcPaths.length} CRC entries` };
}

// ═══════════════════════════════════════════════════════════════════
// Post-gen: STF string registration
// ═══════════════════════════════════════════════════════════════════

export function registerSTF(
    wsRoot: string,
    entries: { file: string; key: string; value: string }[],
): { success: boolean; message: string } {
    const treBase = path.join(wsRoot, 'tre/working');
    const grouped: Record<string, { key: string; value: string }[]> = {};

    for (const e of entries) {
        if (!grouped[e.file]) grouped[e.file] = [];
        grouped[e.file].push({ key: e.key, value: e.value });
    }

    let totalAdded = 0;
    for (const [relPath, items] of Object.entries(grouped)) {
        const fullPath = path.join(treBase, relPath);

        // Seed if needed
        if (!fs.existsSync(fullPath)) {
            const vanillaPath = path.join(wsRoot, 'tre/vanilla', relPath);
            const infinityPath = path.join(wsRoot, 'tre/infinity', relPath);
            const src = fs.existsSync(vanillaPath) ? vanillaPath : fs.existsSync(infinityPath) ? infinityPath : null;
            if (!src) continue;
            ensureDir(fullPath);
            fs.copyFileSync(src, fullPath);
        }

        const data = new Uint8Array(fs.readFileSync(fullPath));
        const stf = parseSTF(data);
        addSTFEntries(stf, items.map(i => ({ id: i.key, value: i.value })));
        fs.writeFileSync(fullPath, serializeSTF(stf));
        totalAdded += items.length;
    }

    return { success: true, message: `Added ${totalAdded} STF entries across ${Object.keys(grouped).length} files` };
}
