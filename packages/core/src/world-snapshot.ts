/**
 * World Snapshot (.ws) parser for SWG
 *
 * Parses WSNP IFF files to build a cell-ID → world-position lookup table.
 * The primary use case is resolving interior spawn coordinates: screenplay
 * spawns inside cells (cellId != 0) use coordinates relative to the building,
 * and this map lets callers place them at the building's world position instead.
 *
 * Binary layout per NODE DATA chunk (52 bytes LE):
 *   uint32 objectID
 *   uint32 parentID        (0 = world root, else parent objectID)
 *   uint32 nameID          (index into OTNL template list)
 *   uint32 cellid          (cell number within building)
 *   float  qw, qx, qy, qz (rotation quaternion)
 *   float  x, z, y         (position — note z/y swap)
 *   float  gameObjectType
 *   uint32 unknown
 *
 * Hierarchy: buildings are root NODEs with parentID=0; cells are child NODEs
 * with parentID = building's objectID.
 */

export interface CellPositionEntry {
    /** The cell's objectID (used as cellId in spawnMobile) */
    cellObjectId: number;
    /** Parent building objectID */
    buildingObjectId: number;
    /** Building world X */
    worldX: number;
    /** Building world Y (SWG Y = horizontal plane) */
    worldY: number;
    /** Building template path from OTNL */
    buildingTemplate: string;
}

export interface WorldSnapshotSummary {
    /** Map from cellObjectId → building world position */
    cellPositions: Map<number, CellPositionEntry>;
    /** Total nodes parsed */
    nodeCount: number;
    /** Total buildings found */
    buildingCount: number;
    /** Total cells mapped */
    cellCount: number;
}

/**
 * Parse a .ws binary buffer and return a cell→building position map.
 *
 * This is a linear scan optimized for speed: it finds all 52-byte DATA chunks,
 * builds the parent→position index in one pass, then resolves cells in a second pass.
 */
export function parseWorldSnapshot(data: Uint8Array): WorldSnapshotSummary {
    // ── Pass 0: parse the OTNL template name list ──────────────────
    const templates = parseOTNL(data);

    // ── Pass 1: extract all nodes from DATA chunks ─────────────────
    interface RawNode {
        objectID: number;
        parentID: number;
        nameID: number;
        cellid: number;
        x: number;
        z: number;
        y: number;
    }

    const nodes: RawNode[] = [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;
    const end = data.length - 60; // need at least 8 header + 52 data

    while (pos < end) {
        // Look for "DATA" tag followed by size 0x00000034 (52) in big-endian
        if (data[pos] === 0x44 &&       // 'D'
            data[pos + 1] === 0x41 &&   // 'A'
            data[pos + 2] === 0x54 &&   // 'T'
            data[pos + 3] === 0x41 &&   // 'A'
            data[pos + 4] === 0x00 &&
            data[pos + 5] === 0x00 &&
            data[pos + 6] === 0x00 &&
            data[pos + 7] === 0x34) {   // size = 52

            const o = pos + 8;
            nodes.push({
                objectID:  view.getUint32(o,      true),
                parentID:  view.getUint32(o + 4,  true),
                nameID:    view.getUint32(o + 8,  true),
                cellid:    view.getUint32(o + 12, true),
                x:         view.getFloat32(o + 32, true),
                z:         view.getFloat32(o + 36, true),
                y:         view.getFloat32(o + 40, true),
            });
            pos += 60; // skip past this chunk
        } else {
            pos++;
        }
    }

    // ── Pass 2: index buildings (parentID === 0, template starts with object/building or object/static/structure) ──
    const buildingPos = new Map<number, { x: number; y: number; template: string }>();
    let buildingCount = 0;

    for (const n of nodes) {
        if (n.parentID !== 0) continue;
        const tmpl = templates[n.nameID] || '';
        // Buildings, caves (static/structure), and any other container that holds cells
        // We index ALL root-level objects since some caves are under unusual paths.
        // The cell resolution pass will only match if cells actually reference this parent.
        buildingPos.set(n.objectID, { x: n.x, y: n.y, template: tmpl });
        if (tmpl.startsWith('object/building/') || tmpl.includes('/structure/')) {
            buildingCount++;
        }
    }

    // ── Pass 3: find cells and resolve to parent building position ──
    const cellPositions = new Map<number, CellPositionEntry>();

    for (const n of nodes) {
        if (n.parentID === 0) continue;  // skip root objects
        const tmpl = templates[n.nameID] || '';
        if (!tmpl.includes('/cell/')) continue; // only cell objects

        const parent = buildingPos.get(n.parentID);
        if (!parent) continue; // orphan cell — shouldn't happen

        cellPositions.set(n.objectID, {
            cellObjectId: n.objectID,
            buildingObjectId: n.parentID,
            worldX: parent.x,
            worldY: parent.y,
            buildingTemplate: parent.template,
        });
    }

    return {
        cellPositions,
        nodeCount: nodes.length,
        buildingCount,
        cellCount: cellPositions.size,
    };
}

/**
 * Serialize cell position data to a plain JSON-safe object for webview transport.
 */
export function cellPositionsToJSON(summary: WorldSnapshotSummary): { [cellId: string]: { x: number; y: number; template: string } } {
    const out: { [cellId: string]: { x: number; y: number; template: string } } = {};
    for (const [cellId, entry] of summary.cellPositions) {
        out[String(cellId)] = { x: entry.worldX, y: entry.worldY, template: entry.buildingTemplate };
    }
    return out;
}

// ── Internal helpers ───────────────────────────────────────────────

function parseOTNL(data: Uint8Array): string[] {
    // Find "OTNL" tag
    const otnlPos = findTag(data, 0x4F, 0x54, 0x4E, 0x4C); // 'O','T','N','L'
    if (otnlPos === -1) return [];

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const chunkSize = view.getUint32(otnlPos + 4, false); // size is big-endian in IFF
    const count = view.getUint32(otnlPos + 8, true);       // count is little-endian
    const end = otnlPos + 8 + chunkSize;

    const templates: string[] = [];
    let pos = otnlPos + 12; // past tag(4) + size(4) + count(4)

    while (pos < end && templates.length < count) {
        const start = pos;
        while (pos < end && data[pos] !== 0) pos++;
        templates.push(new TextDecoder().decode(data.subarray(start, pos)));
        pos++; // skip null terminator
    }

    return templates;
}

function findTag(data: Uint8Array, b0: number, b1: number, b2: number, b3: number): number {
    for (let i = 0; i < data.length - 4; i++) {
        if (data[i] === b0 && data[i + 1] === b1 && data[i + 2] === b2 && data[i + 3] === b3) {
            return i;
        }
    }
    return -1;
}
