/**
 * Type definitions for Building NPC Planner
 */

export interface PatrolWaypoint {
    id: string;
    x: number;          // world X
    y: number;          // world Y (maps to Z in-game)
    z: number;          // height (default 0)
    waitTime: number;   // seconds to pause at this waypoint
}

export interface PatrolPath {
    id: string;
    name: string;
    cellIndex: number;
    waypoints: PatrolWaypoint[];
    mode: 'loop' | 'pingpong';
    color: string;
}

export interface SpawnPoint {
    id: string;
    x: number;
    y: number;
    z: number;
    heading: number;
    mobileTemplate: string;
    tier: number;
    respawnTime?: number; // seconds
    patrolPathId?: string; // links spawn to a patrol path
}

export interface CellSpawnData {
    cellIndex: number;
    cellName: string;
    spawns: SpawnPoint[];
    patrolPaths?: PatrolPath[];
}

export interface ProjectData {
    version: string;
    screenplayName: string;
    pobPath: string;
    cells: CellSpawnData[];
    metadata: {
        created: string;
        modified: string;
        totalSpawns: number;
    };
}

export const COMMON_MOBILE_TEMPLATES = [
    'stormtrooper',
    'stormtrooper_squad_leader',
    'stormtrooper_commando',
    'dark_trooper',
    'blacksun_guard',
    'blacksun_assassin',
    'blacksun_ace',
    'death_watch_wraith',
    'death_watch_ghost',
    'death_watch_battle_droid',
    'tusken_raider',
    'tusken_chief',
    'tusken_king',
    'nightsister_elder',
    'nightsister_spell_weaver',
    'rancor',
    'rancor_bull',
    'krayt_dragon',
    'krayt_dragon_grand',
    'canyon_krayt_dragon',
];

export const PATH_COLORS = [
    '#00CCFF', '#FF6600', '#66FF33', '#FF33CC',
    '#FFCC00', '#33FFCC', '#CC66FF', '#FF3366',
];

export const RESPAWN_PRESETS = [
    { label: '30 seconds (Testing)', value: 30 },
    { label: '1 minute', value: 60 },
    { label: '2 minutes', value: 120 },
    { label: '5 minutes (Default)', value: 300 },
    { label: '10 minutes', value: 600 },
    { label: '15 minutes', value: 900 },
    { label: '30 minutes', value: 1800 },
];
