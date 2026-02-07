/**
 * Art Workshop Types
 */

export type ArtCategory = 'painting' | 'rug' | 'banner' | 'tapestry';

export type PaintingSize = 'square_tiny' | 'square_small' | 'square_medium' | 'square_large' | 'tall' | 'wide' | 'frameless';

export type RugShape = 'rectangle_large' | 'rectangle_medium' | 'rectangle_small' | 'oval_large' | 'oval_medium' | 'round_large';

export type BannerStyle = 'style1' | 'style2';

export type ArtSubtype = PaintingSize | RugShape | BannerStyle | 'standard';

export interface ArtTypeConfig {
    category: ArtCategory;
    subtype: ArtSubtype;
    label: string;
    /** Expected DDS width */
    expectedWidth: number;
    /** Expected DDS height */
    expectedHeight: number;
    /** Template mesh filename (in vanilla TRE) */
    templateMesh: string;
    /** Whether this is animated (SAT chain) vs static (APT chain) */
    animated: boolean;
    /** Subfolder name in art_workshop staging */
    stagingFolder: string;
    /** Object IFF path prefix in TRE */
    objectPath: string;
}

/** All supported art types and their configurations */
export const ART_TYPE_CONFIGS: ArtTypeConfig[] = [
    // Paintings
    { category: 'painting', subtype: 'square_tiny',   label: 'Painting - Square Tiny',    expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_all_painting_square_sm_s01', animated: false, stagingFolder: 'paintings/square_tiny',   objectPath: 'object/tangible/painting' },
    { category: 'painting', subtype: 'square_small',  label: 'Painting - Square Small',   expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_all_painting_square_sm_s02', animated: false, stagingFolder: 'paintings/square_small',  objectPath: 'object/tangible/painting' },
    { category: 'painting', subtype: 'square_medium', label: 'Painting - Square Medium',  expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_all_painting_square_sm_s03', animated: false, stagingFolder: 'paintings/square_medium', objectPath: 'object/tangible/painting' },
    { category: 'painting', subtype: 'square_large',  label: 'Painting - Square Large',   expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_all_painting_square_lg_s01', animated: false, stagingFolder: 'paintings/square_large',  objectPath: 'object/tangible/painting' },
    { category: 'painting', subtype: 'tall',           label: 'Painting - Tall',           expectedWidth: 128, expectedHeight: 256, templateMesh: 'frn_all_painting_tall_s01',      animated: false, stagingFolder: 'paintings/tall',           objectPath: 'object/tangible/painting' },
    { category: 'painting', subtype: 'wide',           label: 'Painting - Wide',           expectedWidth: 256, expectedHeight: 128, templateMesh: 'frn_all_painting_agrilat_lg',    animated: false, stagingFolder: 'paintings/wide',           objectPath: 'object/tangible/painting' },
    { category: 'painting', subtype: 'frameless',      label: 'Painting - Frameless',      expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_all_painting_square_lg_s01', animated: false, stagingFolder: 'paintings/frameless',      objectPath: 'object/tangible/painting' },

    // Rugs
    { category: 'rug', subtype: 'rectangle_large',  label: 'Rug - Rectangle Large',  expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_all_rug_rectangle_lg_s01', animated: false, stagingFolder: 'rugs/rectangle_large',  objectPath: 'object/tangible/painting' },
    { category: 'rug', subtype: 'rectangle_medium', label: 'Rug - Rectangle Medium', expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_all_rug_rectangle_m_s01',  animated: false, stagingFolder: 'rugs/rectangle_medium', objectPath: 'object/tangible/painting' },
    { category: 'rug', subtype: 'rectangle_small',  label: 'Rug - Rectangle Small',  expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_all_rug_rectangle_sm_s02', animated: false, stagingFolder: 'rugs/rectangle_small',  objectPath: 'object/tangible/painting' },
    { category: 'rug', subtype: 'oval_large',       label: 'Rug - Oval Large',       expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_mdrn_rug_oval_lg_s01',    animated: false, stagingFolder: 'rugs/oval_large',       objectPath: 'object/tangible/painting' },
    { category: 'rug', subtype: 'oval_medium',      label: 'Rug - Oval Medium',      expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_mdrn_rug_oval_m_s02',     animated: false, stagingFolder: 'rugs/oval_medium',      objectPath: 'object/tangible/painting' },
    { category: 'rug', subtype: 'round_large',      label: 'Rug - Round Large',      expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_mdrn_rug_rnd_lg_s01',     animated: false, stagingFolder: 'rugs/round_large',      objectPath: 'object/tangible/painting' },

    // Banners
    { category: 'banner', subtype: 'style1', label: 'Banner - Style 1', expectedWidth: 256, expectedHeight: 256, templateMesh: 'banner1', animated: true, stagingFolder: 'banners/style1', objectPath: 'object/tangible/painting' },
    { category: 'banner', subtype: 'style2', label: 'Banner - Style 2', expectedWidth: 256, expectedHeight: 256, templateMesh: 'banner2', animated: true, stagingFolder: 'banners/style2', objectPath: 'object/tangible/painting' },

    // Tapestries
    { category: 'tapestry', subtype: 'standard', label: 'Tapestry', expectedWidth: 256, expectedHeight: 256, templateMesh: 'frn_all_tapestry_impl', animated: false, stagingFolder: 'tapestries', objectPath: 'object/tangible/painting' },
];

export interface StagedItem {
    /** DDS filename without extension */
    baseName: string;
    /** Full path to DDS file in staging */
    ddsPath: string;
    /** Art type configuration */
    typeConfig: ArtTypeConfig;
    /** User-provided display name (defaults to humanized filename) */
    displayName: string;
    /** User-provided description */
    description: string;
    /** Generated internal name (art_ prefix + sanitized baseName) */
    internalName: string;
    /** Whether this item is selected for generation */
    selected: boolean;
    /** DDS file dimensions if readable */
    ddsWidth?: number;
    ddsHeight?: number;
    /** Validation warnings */
    warnings: string[];
}

export interface LootGroup {
    /** Group name (used for Lua template name) */
    name: string;
    /** Internal names of items in this group */
    items: string[];
}

export interface GenerationConfig {
    items: StagedItem[];
    lootGroups: LootGroup[];
}

export interface FileOperation {
    type: 'create' | 'modify';
    path: string;
    description: string;
}

export interface GenerationResult {
    success: boolean;
    operations: FileOperation[];
    errors: string[];
}

/** Paths relative to workspace root */
export const PATHS = {
    STAGING_ROOT: 'art_workshop',
    TRE_WORKING: 'tre/working',
    TRE_VANILLA: 'tre/vanilla',
    TRE_INFINITY: 'tre/infinity',
    SCRIPTS_BASE: 'infinity4.0.0/MMOCoreORB/bin/scripts',
    CUSTOM_SCRIPTS: 'infinity4.0.0/MMOCoreORB/bin/scripts/custom_scripts',
    CRC_TABLE: 'tre/working/misc/object_template_crc_string_table.iff',
    STF_NAME: 'tre/working/string/en/art_n.stf',
    STF_DESC: 'tre/working/string/en/art_d.stf',
} as const;
