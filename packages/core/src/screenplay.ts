/**
 * Screenplay coordinate data parser for SWGEmu Lua screenplays.
 *
 * Extracts all coordinate-based data from screenplay Lua source:
 *   - spawnMobile() calls — NPC/creature spawns
 *   - spawnSceneObject() calls — objects, terminals, turrets
 *   - spawnActiveArea() calls — trigger zones
 *   - Table-driven spawn arrays — POI mobiles, city NPCs
 *
 * This is a pure parser (no filesystem/vscode dependency). Feed it Lua
 * source text, get back structured coordinate data. Caching and filesystem
 * scanning are handled by consumers (extensions).
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** A single spawnMobile() call */
export interface SpawnMobileEntry {
    kind: 'mobile';
    planet: string;
    template: string;
    level: number;
    x: number;
    z: number;   // height
    y: number;
    heading: number;
    cellId: number;
    line: number;
}

/** A single spawnSceneObject() call */
export interface SpawnObjectEntry {
    kind: 'object';
    planet: string;
    template: string;   // IFF path
    x: number;
    z: number;
    y: number;
    cellId: number;
    heading: number;
    line: number;
}

/** A single spawnActiveArea() call */
export interface SpawnAreaEntry {
    kind: 'area';
    planet: string;
    template: string;
    x: number;
    z: number;
    y: number;
    radius: number;
    cellId: number;
    line: number;
}

/** A patrol waypoint from a patrol route table */
export interface PatrolWaypoint {
    x: number;
    z: number;
    y: number;
}

/** A patrol route (city NPC patrol path) */
export interface PatrolRoute {
    kind: 'patrol';
    routeId: string;
    waypoints: PatrolWaypoint[];
    line: number;
}

/** Union of all coordinate-based entries */
export type CoordinateEntry = SpawnMobileEntry | SpawnObjectEntry | SpawnAreaEntry | PatrolRoute;

/** Parsed screenplay file result */
export interface ScreenplayFile {
    /** Human-readable name derived from filename */
    name: string;
    /** Full filesystem path */
    filePath: string;
    /** Category inferred from directory path */
    category: ScreenplayCategory;
    /** Planets referenced by this screenplay */
    planets: string[];
    /** All coordinate entries found */
    entries: CoordinateEntry[];
    /** File modification time (for delta caching) */
    mtime: number;
}

export type ScreenplayCategory = 'cave' | 'city' | 'poi' | 'static' | 'dungeon' | 'custom' | 'themepark' | 'event' | 'other';

/** Index entry — lightweight summary for the master index */
export interface ScreenplayIndexEntry {
    name: string;
    filePath: string;
    category: ScreenplayCategory;
    planets: string[];
    mobileCount: number;
    objectCount: number;
    areaCount: number;
    worldSpawnCount: number;
    interiorSpawnCount: number;
    mtime: number;
}

/** Full cached data for a single screenplay file */
export interface ScreenplayCacheEntry {
    index: ScreenplayIndexEntry;
    entries: CoordinateEntry[];
}

/** The full serializable index */
export interface ScreenplayIndexData {
    version: number;
    buildTimestamp: number;
    files: { [filePath: string]: ScreenplayCacheEntry };
}

// ── Parser ───────────────────────────────────────────────────────────────────

const CURRENT_VERSION = 1;

/**
 * Parse a single Lua screenplay file and extract all coordinate data.
 *
 * @param content   Lua source text
 * @param filePath  Full path to the file (used for name derivation)
 * @param mtime     File modification timestamp
 * @returns Parsed screenplay data, or null if no coordinate data found
 */
export function parseScreenplay(content: string, filePath: string, mtime: number): ScreenplayFile | null {
    const entries: CoordinateEntry[] = [];
    const planets = new Set<string>();

    // Parse direct function calls
    parseMobileCalls(content, entries, planets);
    parseObjectCalls(content, entries, planets);
    parseAreaCalls(content, entries, planets);

    // Parse table-driven spawn patterns
    parseTableSpawns(content, entries, planets);

    if (entries.length === 0) return null;

    const name = deriveScreenplayName(filePath);
    const category = inferCategory(filePath);

    return {
        name,
        filePath,
        category,
        planets: Array.from(planets).sort(),
        entries,
        mtime,
    };
}

/**
 * Build a lightweight index entry from a full screenplay parse.
 */
export function buildIndexEntry(sp: ScreenplayFile): ScreenplayIndexEntry {
    let mobileCount = 0, objectCount = 0, areaCount = 0;
    let worldCount = 0, interiorCount = 0;

    for (const e of sp.entries) {
        if (e.kind === 'mobile') {
            mobileCount++;
            if (e.cellId === 0) worldCount++; else interiorCount++;
        } else if (e.kind === 'object') {
            objectCount++;
            if (e.cellId === 0) worldCount++; else interiorCount++;
        } else if (e.kind === 'area') {
            areaCount++;
            if (e.cellId === 0) worldCount++; else interiorCount++;
        }
    }

    return {
        name: sp.name,
        filePath: sp.filePath,
        category: sp.category,
        planets: sp.planets,
        mobileCount,
        objectCount,
        areaCount,
        worldSpawnCount: worldCount,
        interiorSpawnCount: interiorCount,
        mtime: sp.mtime,
    };
}

/**
 * Create an empty index.
 */
export function createEmptyIndex(): ScreenplayIndexData {
    return { version: CURRENT_VERSION, buildTimestamp: Date.now(), files: {} };
}

/**
 * Query the index for entries matching a planet.
 */
export function queryByPlanet(index: ScreenplayIndexData, planet: string): ScreenplayCacheEntry[] {
    const results: ScreenplayCacheEntry[] = [];
    for (const key of Object.keys(index.files)) {
        const entry = index.files[key];
        if (entry.index.planets.includes(planet)) {
            results.push(entry);
        }
    }
    return results;
}

/**
 * Query the index for entries matching a category.
 */
export function queryByCategory(index: ScreenplayIndexData, category: ScreenplayCategory): ScreenplayCacheEntry[] {
    const results: ScreenplayCacheEntry[] = [];
    for (const key of Object.keys(index.files)) {
        const entry = index.files[key];
        if (entry.index.category === category) {
            results.push(entry);
        }
    }
    return results;
}

/**
 * Get all unique mobile templates across the index.
 */
export function getAllMobileTemplates(index: ScreenplayIndexData, planet?: string): string[] {
    const templates = new Set<string>();
    for (const key of Object.keys(index.files)) {
        const entry = index.files[key];
        if (planet && !entry.index.planets.includes(planet)) continue;
        for (const e of entry.entries) {
            if (e.kind === 'mobile') templates.add(e.template);
        }
    }
    return Array.from(templates).sort();
}

// ── Valid SWG planets ────────────────────────────────────────────────────────

const VALID_PLANETS = new Set([
    'corellia', 'dantooine', 'dathomir', 'endor', 'lok', 'naboo', 'rori',
    'talus', 'tatooine', 'yavin4',
    // Expansions
    'kashyyyk', 'kashyyyk_dead_forest', 'kashyyyk_hunting', 'kashyyyk_main',
    'mustafar',
    // JTL space zones
    'space_corellia', 'space_dantooine', 'space_dathomir', 'space_endor',
    'space_lok', 'space_naboo', 'space_tatooine', 'space_yavin4',
    'space_heavy', 'space_light', 'space_nova_orion',
    // Addon zones
    'etyyy', 'adventure1', 'adventure2',
    'dungeon1', 'dungeon2',
    'hoth',
]);

function isValidPlanet(name: string): boolean {
    return VALID_PLANETS.has(name);
}

// ── Internal parsers ─────────────────────────────────────────────────────────

/**
 * Parse spawnMobile("planet", "template", level, x, z, y, heading, cellId) calls
 */
function parseMobileCalls(content: string, out: CoordinateEntry[], planets: Set<string>): void {
    const lines = content.split('\n');
    const re = /spawnMobile\s*\(\s*(?:"([^"]+)"|self\.planet|([a-zA-Z_]\w*))\s*,\s*"([^"]+)"\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\)/;

    // Resolve self.planet if present
    const selfPlanet = extractSelfPlanet(content);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('--')) continue;

        const m = line.match(re);
        if (!m) continue;

        const planet = m[1] || selfPlanet || m[2] || '';
        if (!planet || !isValidPlanet(planet)) continue;

        planets.add(planet);
        out.push({
            kind: 'mobile',
            planet,
            template: m[3].trim(),
            level: parseFloat(m[4]) || 0,
            x: parseFloat(m[5]) || 0,
            z: parseFloat(m[6]) || 0,
            y: parseFloat(m[7]) || 0,
            heading: parseFloat(m[8]) || 0,
            cellId: parseInt(m[9]) || 0,
            line: i + 1,
        });
    }
}

/**
 * Parse spawnSceneObject("planet", "template", x, z, y, cellId, heading_rad) calls
 */
function parseObjectCalls(content: string, out: CoordinateEntry[], planets: Set<string>): void {
    const lines = content.split('\n');
    const re = /spawnSceneObject\s*\(\s*(?:"([^"]+)"|([a-zA-Z_]\w*))\s*,\s*"([^"]+)"\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]*)\)/;

    const selfPlanet = extractSelfPlanet(content);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('--')) continue;

        const m = line.match(re);
        if (!m) continue;

        const planet = m[1] || selfPlanet || '';
        if (!planet || !isValidPlanet(planet)) continue;

        planets.add(planet);
        out.push({
            kind: 'object',
            planet,
            template: m[3].trim(),
            x: parseFloat(m[4]) || 0,
            z: parseFloat(m[5]) || 0,
            y: parseFloat(m[6]) || 0,
            cellId: parseInt(m[7]) || 0,
            heading: parseFloat(m[8]) || 0,
            line: i + 1,
        });
    }
}

/**
 * Parse spawnActiveArea("planet", "template", x, z, y, radius, cellId) calls
 */
function parseAreaCalls(content: string, out: CoordinateEntry[], planets: Set<string>): void {
    const lines = content.split('\n');
    const re = /spawnActiveArea\s*\(\s*(?:"([^"]+)"|([a-zA-Z_]\w*))\s*,\s*"([^"]+)"\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\)/;

    const selfPlanet = extractSelfPlanet(content);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('--')) continue;

        const m = line.match(re);
        if (!m) continue;

        const planet = m[1] || selfPlanet || '';
        if (!planet || !isValidPlanet(planet)) continue;

        planets.add(planet);
        out.push({
            kind: 'area',
            planet,
            template: m[3].trim(),
            x: parseFloat(m[4]) || 0,
            z: parseFloat(m[5]) || 0,
            y: parseFloat(m[6]) || 0,
            radius: parseFloat(m[7]) || 0,
            cellId: parseInt(m[8]) || 0,
            line: i + 1,
        });
    }
}

/**
 * Parse table-driven spawn patterns:
 * mobiles = { {"template", level, x, z, y, heading, cellId}, ... }
 */
function parseTableSpawns(content: string, out: CoordinateEntry[], planets: Set<string>): void {
    const selfPlanet = extractSelfPlanet(content);
    const zonePlanet = extractZonePlanet(content);
    const planet = selfPlanet || zonePlanet || '';

    if (!planet || !isValidPlanet(planet)) return;

    const lines = content.split('\n');
    // 7-element tuple: {"template", level, x, z, y, heading, cellId}
    const re7 = /\{\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(\d+)\s*\}/;

    // Track which lines already have direct spawnMobile calls (to avoid duplicates)
    const directCallLines = new Set<number>();
    for (const e of out) {
        directCallLines.add(e.line);
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('--')) continue;
        if (directCallLines.has(i + 1)) continue;

        const m = line.match(re7);
        if (!m) continue;

        const template = m[1];
        // Heuristic: mobile template names are lowercase with underscores
        if (!/^[a-z][a-z0-9_]*$/.test(template)) continue;

        const x = parseFloat(m[3]) || 0;
        const y = parseFloat(m[5]) || 0;
        // Sanity: world coords within SWG map bounds
        const cellId = parseInt(m[7]) || 0;
        if (cellId === 0 && (Math.abs(x) > 9000 || Math.abs(y) > 9000)) continue;

        planets.add(planet);
        out.push({
            kind: 'mobile',
            planet,
            template,
            level: parseInt(m[2]) || 0,
            x,
            z: parseFloat(m[4]) || 0,
            y,
            heading: parseFloat(m[6]) || 0,
            cellId,
            line: i + 1,
        });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractSelfPlanet(content: string): string {
    const m = content.match(/planet\s*=\s*"([^"]+)"/);
    return m ? m[1] : '';
}

function extractZonePlanet(content: string): string {
    const m = content.match(/isZoneEnabled\s*\(\s*"([^"]+)"\s*\)/);
    return m ? m[1] : '';
}

function deriveScreenplayName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const base = parts[parts.length - 1].replace(/\.lua$/, '');
    return base.replace(/_/g, ' ');
}

function inferCategory(filePath: string): ScreenplayCategory {
    const lower = filePath.toLowerCase().replace(/\\/g, '/');
    if (lower.includes('/caves/') || lower.includes('/cave/')) return 'cave';
    if (lower.includes('/cities/') || lower.includes('/city/')) return 'city';
    if (lower.includes('/poi/')) return 'poi';
    if (lower.includes('/static_spawns/')) return 'static';
    if (lower.includes('/dungeon/')) return 'dungeon';
    if (lower.includes('/themepark/')) return 'themepark';
    if (lower.includes('/events/') || lower.includes('/gcw/')) return 'event';
    if (lower.includes('/custom_scripts/') || lower.includes('/custom_content/')) return 'custom';
    return 'other';
}
