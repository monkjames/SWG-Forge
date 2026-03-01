// Tier flag bitmask constants (from scripts/managers/planet/regions.lua)
export const SPAWNAREA = 0x000001;
export const NOSPAWNAREA = 0x000002;
export const WORLDSPAWNAREA = 0x000004;
export const NOWORLDSPAWNAREA = 0x000008;
export const NOBUILDZONEAREA = 0x000010;
export const CAMPINGAREA = 0x000020;
export const CITY = 0x000040;
export const NAVAREA = 0x000080;
export const NAMEDREGION = 0x000100;
export const LOCKEDAREA = 0x000200;
export const NOCOMBATAREA = 0x000400;
export const NODUELAREA = 0x000800;
export const PVPAREA = 0x001000;

export type RegionShape =
    | { type: 'circle'; radius: number }
    | { type: 'rectangle'; x2: number; y2: number }
    | { type: 'ring'; innerRadius: number; outerRadius: number };

export interface SpawnRegion {
    name: string;
    x: number;
    y: number;
    shape: RegionShape;
    tier: number;
    isSpawnArea: boolean;
    isNoSpawnArea: boolean;
    isWorldSpawn: boolean;
    isCity: boolean;
    isNoWorldSpawn: boolean;
    isNoBuildZone: boolean;
    isNamedRegion: boolean;
    spawnGroups: string[];
    maxSpawnLimit: number;
    sourceFile: string;
    sourceLine: number;
}

export interface LairSpawnEntry {
    lairTemplateName: string;
    spawnLimit: number;
    minDifficulty: number;
    maxDifficulty: number;
    weighting: number;
    size: number;
}

export interface SpawnGroup {
    name: string;
    lairSpawns: LairSpawnEntry[];
    sourceFile: string;
    isCustom: boolean;
}

export interface LairTemplate {
    name: string;
    mobiles: { name: string; weight: number }[];
    bossMobiles: { name: string; count: number }[];
    bossMobileChance: number;
    spawnLimit: number;
    sourceFile: string;
}

export interface LootEntry {
    group: string;
    chance: number;
}

export interface CreatureDefinition {
    name: string;
    objectName: string;
    level: number;
    damageMin: number;
    damageMax: number;
    baseXp: number;
    baseHAM: number;
    armor: number;
    faction: string;
    tamingChance: number;      // 0.0-1.0, >0 = tameable ("babies" filter)
    mobType: number;           // 1=herbivore, 2=carnivore, 3=NPC
    socialGroup: string;       // e.g. "dire_cat", "corsec"
    ferocity: number;          // aggression level 0-10
    creatureBitmask: number;   // PACK, HERD, KILLER, STALKER, BABY, etc.
    lootGroups: LootEntry[][];
    sourceFile: string;
    sourcePlanet: string;
}

export interface SpawnWarning {
    type: 'cross-planet' | 'empty-group' | 'missing-lair' | 'missing-creature' | 'zero-weight';
    message: string;
    regionName?: string;
    sourceFile?: string;
    details?: string;
}

export interface PlanetData {
    planetName: string;
    regions: SpawnRegion[];
    spawnGroups: Map<string, SpawnGroup>;
    lairTemplates: Map<string, LairTemplate>;
    creatures: Map<string, CreatureDefinition>;
    missingCreatures: CreatureDefinition[];
    warnings: SpawnWarning[];
    staticSpawns: ScreenplaySpawnGroup[];
}

// ── Static Spawns ─────────────────────────────────────────────────

export interface StaticSpawnEntry {
    template: string;
    x: number;
    z: number;       // height
    y: number;
    heading: number;
    cellId: number;   // 0 = world, non-zero = interior
    line: number;     // source line
}

export interface ScreenplaySpawnGroup {
    name: string;
    sourceFile: string;
    category: string;   // cave, city, poi, static, dungeon, custom
    spawns: StaticSpawnEntry[];
    worldSpawnCount: number;
    interiorSpawnCount: number;
}

// Serializable version for webview transport (Maps → plain objects)
export interface PlanetDataJSON {
    planetName: string;
    regions: SpawnRegion[];
    spawnGroups: { [key: string]: SpawnGroup };
    lairTemplates: { [key: string]: LairTemplate };
    creatures: { [key: string]: CreatureDefinition };
    missingCreatures: CreatureDefinition[];
    warnings: SpawnWarning[];
    staticSpawns: ScreenplaySpawnGroup[];
}
