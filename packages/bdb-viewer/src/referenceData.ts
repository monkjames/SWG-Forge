import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseCRCTable, calculateCRC } from '@swgemu/core';

export interface ReferenceData {
    crcTable: Map<number, string>;       // CRC → template path
    zoneNames: Map<number, string>;      // zone CRC → planet name
    oidTableNames: Map<number, string>;  // table ID → database name
}

// SWG zone names (ground + space + dungeons)
const ZONE_NAME_LIST: string[] = [
    'corellia', 'dantooine', 'dathomir', 'endor', 'lok',
    'naboo', 'rori', 'talus', 'tatooine', 'yavin4',
    'tutorial',
    'space_corellia', 'space_dantooine', 'space_dathomir',
    'space_endor', 'space_lok', 'space_naboo',
    'space_tatooine', 'space_yavin4',
    'space_heavy', 'space_light',
    'space_nova_orion',
    'dungeon1', 'dungeon2',
    // Infinity customs
    'hoth',
];

// OID table IDs — assigned sequentially by engine3 DatabaseManager on startup
// Order from ObjectManager::loadDatabases() in ObjectManager.cpp:128-151
const OID_TABLE_NAMES: Map<number, string> = new Map([
    [0, 'clientobjects'],
    [1, 'sceneobjects'],
    [2, 'playerstructures'],
    [3, 'buffs'],
    [4, 'missionobjectives'],
    [5, 'missionobservers'],
    [6, 'cityregions'],
    [7, 'guilds'],
    [8, 'spawnareas'],
    [9, 'spawnobservers'],
    [10, 'aiobservers'],
    [11, 'events'],
    [12, 'questdata'],
    [13, 'surveys'],
    [14, 'accounts'],
    [15, 'pendingmail'],
    [16, 'credits'],
    [17, 'navareas'],
    [18, 'frsdata'],
    [19, 'frsmanager'],
    [20, 'resourcespawns'],
    [21, 'playerbounties'],
    [22, 'mail'],
    [23, 'chatrooms'],
]);

/**
 * Load reference data for field annotations.
 * Searches for CRC string table IFF in well-known workspace locations.
 * Returns empty maps on failure (graceful degradation).
 */
export async function loadReferenceData(dbPath: string): Promise<ReferenceData> {
    const crcTable = await loadCRCTable(dbPath);
    const zoneNames = buildZoneNameMap();
    return { crcTable, zoneNames, oidTableNames: OID_TABLE_NAMES };
}

/**
 * Search for and load CRC string table IFF.
 * Looks in tre/working/ and tre/infinity/ relative to workspace root.
 */
async function loadCRCTable(dbPath: string): Promise<Map<number, string>> {
    const searchPaths = getCRCTableSearchPaths(dbPath);
    for (const p of searchPaths) {
        try {
            const data = fs.readFileSync(p);
            const table = parseCRCTable(new Uint8Array(data));
            const map = new Map<number, string>();
            for (const entry of table.entries) {
                map.set(entry.crc >>> 0, entry.path);
            }
            return map;
        } catch {
            // Try next path
        }
    }
    return new Map();
}

function getCRCTableSearchPaths(dbPath: string): string[] {
    const paths: string[] = [];
    const crcRelPath = path.join('tre', 'working', 'misc', 'object_template_crc_string_table.iff');
    const crcRelPathInfinity = path.join('tre', 'infinity', 'misc', 'object_template_crc_string_table.iff');

    // Search from workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        for (const folder of workspaceFolders) {
            paths.push(path.join(folder.uri.fsPath, crcRelPath));
            paths.push(path.join(folder.uri.fsPath, crcRelPathInfinity));
        }
    }

    // Search from db file's directory (walk up looking for tre/)
    let dir = path.dirname(dbPath);
    for (let i = 0; i < 10; i++) {
        const tryPath = path.join(dir, crcRelPath);
        if (fs.existsSync(path.join(dir, 'tre'))) {
            paths.push(tryPath);
            paths.push(path.join(dir, crcRelPathInfinity));
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) { break; }
        dir = parent;
    }

    return paths;
}

function buildZoneNameMap(): Map<number, string> {
    const map = new Map<number, string>();
    for (const name of ZONE_NAME_LIST) {
        const crc = calculateCRC(name);
        map.set(crc >>> 0, name);
    }
    return map;
}

/**
 * Annotate a single field value with human-readable reference info.
 * Returns annotation string or undefined if no annotation applies.
 */
export function annotateField(
    fieldName: string,
    fieldType: string,
    decoded: string,
    ref: ReferenceData
): string | undefined {
    // CRC fields — unsigned int fields whose name contains "CRC"
    if (fieldType === 'unsigned int' || fieldType === 'uint32') {
        if (fieldName.toLowerCase().includes('crc')) {
            return annotateCRC(decoded, fieldName, ref);
        }
        // gameObjectType is also a CRC-like field
        if (fieldName === 'SceneObject.gameObjectType') {
            return annotateGameObjectType(decoded);
        }
    }

    // OID reference fields
    if (fieldType.startsWith('ManagedReference<') || fieldType.startsWith('ManagedWeakReference<')) {
        return annotateOID(decoded, ref);
    }

    // unsigned long long that look like OIDs (specific known fields)
    if (fieldType === 'unsigned long long' && decoded.startsWith('0x') && decoded.length > 4) {
        // Fields like deedObjectID, ownerID etc. that store OIDs as raw uint64
        if (fieldName.toLowerCase().includes('id') || fieldName.toLowerCase().includes('oid')) {
            return annotateOID(decoded, ref);
        }
    }

    return undefined;
}

function annotateCRC(decoded: string, fieldName: string, ref: ReferenceData): string | undefined {
    const val = parseHexOrDec(decoded);
    if (val === undefined || val === 0) { return undefined; }

    // Check zone CRC first (zone-specific fields)
    if (fieldName.toLowerCase().includes('zone')) {
        const zoneName = ref.zoneNames.get(val >>> 0);
        if (zoneName) { return zoneName; }
    }

    // Check CRC string table (template paths)
    const templatePath = ref.crcTable.get(val >>> 0);
    if (templatePath) { return templatePath; }

    // Check zone names as fallback for any CRC field
    const zoneName = ref.zoneNames.get(val >>> 0);
    if (zoneName) { return zoneName; }

    return undefined;
}

function annotateOID(decoded: string, ref: ReferenceData): string | undefined {
    if (decoded === 'null' || decoded === '0') { return undefined; }
    if (!decoded.startsWith('0x')) { return undefined; }

    try {
        const val = BigInt(decoded);
        if (val === 0n) { return undefined; }
        const tableId = Number((val >> 48n) & 0xFFFFn);
        const counter = val & 0x0000FFFFFFFFFFFFn;
        const tableName = ref.oidTableNames.get(tableId);
        if (tableName) {
            return '[' + tableName + ' #' + counter.toString() + ']';
        }
        return '[table' + tableId + ' #' + counter.toString() + ']';
    } catch {
        return undefined;
    }
}

function annotateGameObjectType(decoded: string): string | undefined {
    // Game object type constants (from SharedObjectTemplate.h)
    const val = parseHexOrDec(decoded);
    if (val === undefined) { return undefined; }
    const GOT_NAMES: Record<number, string> = {
        0x2: 'tangible',
        0x4: 'creature',
        0x8: 'vehicle',
        0x100: 'building',
        0x200: 'installation',
        0x400: 'weapon',
        0x800: 'armor',
        0x2000000: 'ship',
    };
    return GOT_NAMES[val] || undefined;
}

function parseHexOrDec(s: string): number | undefined {
    if (s.startsWith('0x') || s.startsWith('0X')) {
        const val = parseInt(s.substring(2), 16);
        return isNaN(val) ? undefined : val;
    }
    const val = parseInt(s, 10);
    return isNaN(val) ? undefined : val;
}
