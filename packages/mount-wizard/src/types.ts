/**
 * Shared types for the Mount Wizard extension
 */

export type MountType = 'creature' | 'speeder';

/** Parsed data from a mobile .lua template */
export interface MobileTemplate {
    /** Creature variable name (e.g., "kaadu") */
    creatureName: string;
    /** File path of the .lua file */
    filePath: string;
    /** Current taming chance (0 if missing) */
    tamingChance: number;
    /** Current control device template path (empty if missing) */
    controlDeviceTemplate: string;
    /** IFF object template paths from templates = {...} */
    objectTemplates: string[];
    /** Ferocity value */
    ferocity: number;
    /** Creature bitmask flags as raw string */
    creatureBitmask: string;
    /** Object name string reference */
    objectName: string;
    /** Mob type constant (e.g., MOB_HERBIVORE, MOB_NPC) */
    mobType: string;
}

/**
 * Hardpoint data for a saddle
 *
 * HPTS binary layout:
 *   bool, byte, string (name), string (parent joint),
 *   float ox, float oy, float oz, float ow,  ← rider facing direction (quaternion)
 *   float r/l, float u/d, float f/b           ← saddle position offset
 *
 * The quaternion controls which direction the rider faces.
 * Forward-facing: ox=0, oy=0, oz=0, ow=1 (identity)
 * 90-degree rotated: ox=0.707107, oy=0, oz=0, ow=0.707107
 *
 * The position offsets (r/l, u/d, f/b) control saddle placement
 * and typically require trial-and-error to get right.
 */
export interface SaddleHardpoint {
    name: string;           // Always "saddle" for mounts
    parentJoint: string;    // e.g., "root", "shoulder", "spine1", "spine2"
    /** Rider facing direction: [ox, oy, oz, ow] */
    quaternion: [number, number, number, number];
    /** Saddle position offset: [right/left, up/down, forward/back] */
    position: [number, number, number];
}

/** Info about an MGN file and its current HPTS status */
export interface MgnFileInfo {
    /** Relative path from TRE root (e.g., "appearance/mesh/kaadu_hue_l0.mgn") */
    relativePath: string;
    /** Absolute path to the file */
    absolutePath: string;
    /** Source location: 'working', 'vanilla', 'infinity' */
    source: 'working' | 'vanilla' | 'infinity';
    /** Whether this file already has an HPTS block */
    hasHpts: boolean;
    /** Existing hardpoints if any */
    hardpoints: SaddleHardpoint[];
}

/** Resolved appearance chain for a creature */
export interface AppearanceChain {
    /** SAT file path */
    satPath: string;
    /** LMG file path */
    lmgPath: string;
    /** All MGN LOD files */
    mgnFiles: MgnFileInfo[];
    /** Appearance filename from the object template (e.g., "appearance/kaadu_hue.sat") */
    appearanceFilename: string;
    /** Current slot descriptor */
    slotDescriptorFilename: string;
}

/** Known mount reference data for the "Copy from" dropdown */
export interface MountReference {
    name: string;
    parentJoint: string;
    position: [number, number, number];
    quaternion: [number, number, number, number];
}

/** All known vanilla mount hardpoint references */
export const MOUNT_REFERENCES: MountReference[] = [
    { name: 'kaadu', parentJoint: 'root', position: [0.0, 0.109180, 0.131364], quaternion: [1, 0, 0, 0] },
    { name: 'bol', parentJoint: 'shoulder', position: [0.0, 0.432, -0.153], quaternion: [1, 0, 0, 0] },
    { name: 'dewback', parentJoint: 'shoulder', position: [0.0, 0.249, -0.142], quaternion: [1, 0, 0, 0] },
    { name: 'cu_pa', parentJoint: 'root', position: [0.0, 0.180, 0.221], quaternion: [1, 0, 0, 0] },
    { name: 'falumpaset', parentJoint: 'spine2', position: [-0.176, -0.266, 0.0], quaternion: [0.707107, 0, 0, 0.707107] },
    { name: 'bantha', parentJoint: 'spine1', position: [0.022, -0.399, 0.0], quaternion: [0.707107, 0, 0, 0.707107] },
    { name: 'carrion_spat', parentJoint: 'root', position: [0.0, 0.166, 0.070], quaternion: [1, 0, 0, 0] },
    { name: 'brackaset', parentJoint: 'spine2', position: [-0.422, -0.278, 0.0], quaternion: [0.707107, 0, 0, 0.707107] },
];

/** User's form input for creating a mount */
export interface MountWizardConfig {
    mountType: MountType;
    tamingChance: number;
    hardpoint: SaddleHardpoint;
    runSpeed: number;
    gallopMultiplier: number;
    gallopDuration: number;
    gallopCooldown: number;
    saddleType: 'existing' | 'new';
    existingSaddleName: string;
    controlDeviceName: string;
    cloneFromDevice: string;
    /** Which MGN files to modify (all checked by default) */
    selectedMgnFiles: string[];
    scaleMin: number;
    scaleMax: number;
}

/** A single file change to be applied */
export interface FileChange {
    /** Absolute file path */
    filePath: string;
    /** Short display path */
    displayPath: string;
    /** What kind of change */
    changeType: 'modify' | 'create' | 'copy_and_modify';
    /** Human-readable description of changes */
    description: string;
    /** Category for grouping in the preview */
    category: 'lua' | 'tre';
}

/** Validation result for a mount check */
export interface ValidationResult {
    label: string;
    status: 'ok' | 'missing' | 'warning';
    detail: string;
    filePath?: string;
}
