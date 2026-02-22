/**
 * Self-contained FLR (Floor Mesh) parser.
 *
 * Reads directly from raw file bytes — no dependency on @swgemu/core.
 * Handles versions 0003, 0005, and 0006 including PGRF path graphs.
 *
 * IFF structure layer: FORM tags and chunk sizes are big-endian (IFF standard).
 * FLR payload layer: All ints and floats within chunk data are little-endian
 * (engine3 uses native memcpy on x86_64).
 */

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface FlrVertex {
    x: number;
    y: number;
    z: number;
}

export interface FlrTriangle {
    corner1: number;
    corner2: number;
    corner3: number;
    index: number;
    nindex1: number;
    nindex2: number;
    nindex3: number;
    normal: { x: number; y: number; z: number };
    edgeType1: number;
    edgeType2: number;
    edgeType3: number;
    fallthrough: boolean;
    partTag: number;
    portalId1: number;
    portalId2: number;
    portalId3: number;
}

export const enum PathNodeType {
    CellPortal           = 0,
    CellWaypoint         = 1,
    CellPOI              = 2,
    BuildingEntrance     = 3,
    BuildingCell         = 4,
    BuildingPortal       = 5,
    CityBuildingEntrance = 6,
    CityWaypoint         = 7,
    CityPOI              = 8,
    CityBuilding         = 9,
    CityEntrance         = 10,
    BuildingCellPart     = 11,
    Invalid              = 12,
}

export const PATH_NODE_TYPE_NAMES: Record<number, string> = {
    0:  'CellPortal',
    1:  'CellWaypoint',
    2:  'CellPOI',
    3:  'BuildingEntrance',
    4:  'BuildingCell',
    5:  'BuildingPortal',
    6:  'CityBuildingEntrance',
    7:  'CityWaypoint',
    8:  'CityPOI',
    9:  'CityBuilding',
    10: 'CityEntrance',
    11: 'BuildingCellPart',
    12: 'Invalid',
};

export const enum PathGraphType {
    Cell     = 0,
    Building = 1,
    City     = 2,
    None     = 3,
}

export const PATH_GRAPH_TYPE_NAMES: Record<number, string> = {
    0: 'Cell',
    1: 'Building',
    2: 'City',
    3: 'None',
};

export interface FlrPathNode {
    id: number;
    var2: number;
    globalGraphNodeID: number;
    type: number;
    x: number;
    z: number;
    y: number;
    radius: number;
}

export interface FlrPathEdge {
    from: number;
    to: number;
    laneWidthRight: number;
    laneWidthLeft: number;
}

export interface FlrPathGraph {
    graphType: number;
    nodes: FlrPathNode[];
    edges: FlrPathEdge[];
    edgeCounts: number[];
    edgeStarts: number[];
}

export interface FlrData {
    version: string;
    vertices: FlrVertex[];
    triangles: FlrTriangle[];
    pathGraph: FlrPathGraph | null;
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };
}

// ---------------------------------------------------------------------------
// Minimal IFF chunk walker
// ---------------------------------------------------------------------------

interface IFFChunk {
    tag: string;
    isForm: boolean;
    formTag?: string;
    dataOffset: number;   // offset of payload start in file buffer
    dataLength: number;    // length of payload
    children?: IFFChunk[];
}

function readTag(buf: Buffer, off: number): string {
    return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

/**
 * Parse an IFF node (FORM or CHUNK) starting at `offset`.
 * Returns the parsed node and the number of bytes consumed.
 */
function parseIFFNode(buf: Buffer, offset: number): { node: IFFChunk; consumed: number } {
    if (offset + 8 > buf.length) {
        throw new Error('Unexpected end of IFF data');
    }

    const tag = readTag(buf, offset);
    const size = buf.readUInt32BE(offset + 4); // IFF sizes are always BE

    if (tag === 'FORM') {
        if (offset + 12 > buf.length) {
            throw new Error('FORM too short for formTag');
        }
        const formTag = readTag(buf, offset + 8);
        const children: IFFChunk[] = [];
        let childOff = offset + 12;
        const endOff = offset + 8 + size;

        while (childOff < endOff && childOff + 8 <= buf.length) {
            const { node: child, consumed } = parseIFFNode(buf, childOff);
            children.push(child);
            childOff += consumed;
        }

        return {
            node: {
                tag: 'FORM',
                isForm: true,
                formTag,
                dataOffset: offset + 12,
                dataLength: size - 4,
                children,
            },
            consumed: 8 + size,
        };
    } else {
        // Regular chunk
        return {
            node: {
                tag,
                isForm: false,
                dataOffset: offset + 8,
                dataLength: size,
            },
            consumed: 8 + size,
        };
    }
}

function findChild(parent: IFFChunk, tag: string, isForm: boolean, formTag?: string): IFFChunk | undefined {
    if (!parent.children) { return undefined; }
    return parent.children.find(c => {
        if (isForm) {
            return c.isForm && c.formTag === formTag;
        }
        return !c.isForm && c.tag === tag;
    });
}

// ---------------------------------------------------------------------------
// FLR parsing
// ---------------------------------------------------------------------------

export function parseFLR(fileData: Buffer): FlrData {
    const { node: root } = parseIFFNode(fileData, 0);

    if (!root.isForm || root.formTag !== 'FLOR') {
        throw new Error(`Expected FORM FLOR, got ${root.tag} ${root.formTag || ''}`);
    }

    // Version form is the first child
    const versionForm = root.children?.[0];
    if (!versionForm || !versionForm.isForm) {
        throw new Error('Missing version form in FLR');
    }

    const version = versionForm.formTag || '????';
    const hasCountPrefix = version === '0006';

    const vertices = parseVertices(fileData, versionForm, hasCountPrefix);
    const triangles = parseTriangles(fileData, versionForm, hasCountPrefix);
    const pathGraph = parsePGRF(fileData, versionForm);
    const bounds = calculateBounds(vertices);

    return { version, vertices, triangles, pathGraph, bounds };
}

function parseVertices(buf: Buffer, versionForm: IFFChunk, hasCountPrefix: boolean): FlrVertex[] {
    const chunk = findChild(versionForm, 'VERT', false);
    if (!chunk) { return []; }

    const verts: FlrVertex[] = [];
    let off = chunk.dataOffset;
    const end = chunk.dataOffset + chunk.dataLength;

    let count: number;
    if (hasCountPrefix) {
        if (off + 4 > end) { return verts; }
        count = buf.readInt32LE(off);
        off += 4;
    } else {
        count = Math.floor((end - off) / 12);
    }

    for (let i = 0; i < count && off + 12 <= end; i++) {
        verts.push({
            x: buf.readFloatLE(off),
            y: buf.readFloatLE(off + 4),
            z: buf.readFloatLE(off + 8),
        });
        off += 12;
    }

    return verts;
}

function parseTriangles(buf: Buffer, versionForm: IFFChunk, hasCountPrefix: boolean): FlrTriangle[] {
    const chunk = findChild(versionForm, 'TRIS', false);
    if (!chunk) { return []; }

    const tris: FlrTriangle[] = [];
    let off = chunk.dataOffset;
    const end = chunk.dataOffset + chunk.dataLength;

    let count: number;
    if (hasCountPrefix) {
        if (off + 4 > end) { return tris; }
        count = buf.readInt32LE(off);
        off += 4;
    } else {
        count = Math.floor((end - off) / 60);
    }

    for (let i = 0; i < count && off + 60 <= end; i++) {
        tris.push({
            corner1:     buf.readInt32LE(off),
            corner2:     buf.readInt32LE(off + 4),
            corner3:     buf.readInt32LE(off + 8),
            index:       buf.readInt32LE(off + 12),
            nindex1:     buf.readInt32LE(off + 16),
            nindex2:     buf.readInt32LE(off + 20),
            nindex3:     buf.readInt32LE(off + 24),
            normal: {
                x: buf.readFloatLE(off + 28),
                y: buf.readFloatLE(off + 32),
                z: buf.readFloatLE(off + 36),
            },
            edgeType1:   buf.readUInt8(off + 40),
            edgeType2:   buf.readUInt8(off + 41),
            edgeType3:   buf.readUInt8(off + 42),
            fallthrough: buf.readUInt8(off + 43) !== 0,
            partTag:     buf.readInt32LE(off + 44),
            portalId1:   buf.readInt32LE(off + 48),
            portalId2:   buf.readInt32LE(off + 52),
            portalId3:   buf.readInt32LE(off + 56),
        });
        off += 60;
    }

    return tris;
}

function parsePGRF(buf: Buffer, versionForm: IFFChunk): FlrPathGraph | null {
    // PGRF is a FORM child of the version form (v0005/v0006 only)
    const pgrfForm = findChild(versionForm, 'FORM', true, 'PGRF');
    if (!pgrfForm) { return null; }

    // Inside PGRF is FORM 0001
    const innerForm = findChild(pgrfForm, 'FORM', true, '0001');
    if (!innerForm) { return null; }

    // META chunk: int32 graphType
    let graphType = 0;
    const metaChunk = findChild(innerForm, 'META', false);
    if (metaChunk && metaChunk.dataLength >= 4) {
        graphType = buf.readInt32LE(metaChunk.dataOffset);
    }

    // PNOD chunk: int32 count + N × 32-byte path nodes
    const nodes: FlrPathNode[] = [];
    const pnodChunk = findChild(innerForm, 'PNOD', false);
    if (pnodChunk && pnodChunk.dataLength >= 4) {
        let off = pnodChunk.dataOffset;
        const end = pnodChunk.dataOffset + pnodChunk.dataLength;
        const count = buf.readInt32LE(off);
        off += 4;

        for (let i = 0; i < count && off + 32 <= end; i++) {
            let radius = buf.readFloatLE(off + 28);
            if (radius === 0) { radius = 0.5; }
            nodes.push({
                id:                buf.readInt32LE(off),
                var2:              buf.readInt32LE(off + 4),
                globalGraphNodeID: buf.readInt32LE(off + 8),
                type:              buf.readInt32LE(off + 12),
                x:                 buf.readFloatLE(off + 16),
                z:                 buf.readFloatLE(off + 20),
                y:                 buf.readFloatLE(off + 24),
                radius,
            });
            off += 32;
        }
    }

    // PEDG chunk: int32 count + N × 16-byte path edges
    const edges: FlrPathEdge[] = [];
    const pedgChunk = findChild(innerForm, 'PEDG', false);
    if (pedgChunk && pedgChunk.dataLength >= 4) {
        let off = pedgChunk.dataOffset;
        const end = pedgChunk.dataOffset + pedgChunk.dataLength;
        const count = buf.readInt32LE(off);
        off += 4;

        for (let i = 0; i < count && off + 16 <= end; i++) {
            edges.push({
                from:           buf.readInt32LE(off),
                to:             buf.readInt32LE(off + 4),
                laneWidthRight: buf.readFloatLE(off + 8),
                laneWidthLeft:  buf.readFloatLE(off + 12),
            });
            off += 16;
        }
    }

    // ECNT chunk: int32 count + N × int32
    const edgeCounts: number[] = [];
    const ecntChunk = findChild(innerForm, 'ECNT', false);
    if (ecntChunk && ecntChunk.dataLength >= 4) {
        let off = ecntChunk.dataOffset;
        const end = ecntChunk.dataOffset + ecntChunk.dataLength;
        const count = buf.readInt32LE(off);
        off += 4;
        for (let i = 0; i < count && off + 4 <= end; i++) {
            edgeCounts.push(buf.readInt32LE(off));
            off += 4;
        }
    }

    // ESTR chunk: int32 count + N × int32
    const edgeStarts: number[] = [];
    const estrChunk = findChild(innerForm, 'ESTR', false);
    if (estrChunk && estrChunk.dataLength >= 4) {
        let off = estrChunk.dataOffset;
        const end = estrChunk.dataOffset + estrChunk.dataLength;
        const count = buf.readInt32LE(off);
        off += 4;
        for (let i = 0; i < count && off + 4 <= end; i++) {
            edgeStarts.push(buf.readInt32LE(off));
            off += 4;
        }
    }

    return { graphType, nodes, edges, edgeCounts, edgeStarts };
}

function calculateBounds(verts: FlrVertex[]): FlrData['bounds'] {
    if (verts.length === 0) {
        return { minX: -10, maxX: 10, minZ: -10, maxZ: 10, minY: 0, maxY: 0 };
    }

    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const v of verts) {
        if (v.x < minX) { minX = v.x; }
        if (v.x > maxX) { maxX = v.x; }
        if (v.z < minZ) { minZ = v.z; }
        if (v.z > maxZ) { maxZ = v.z; }
        if (v.y < minY) { minY = v.y; }
        if (v.y > maxY) { maxY = v.y; }
    }

    return { minX, maxX, minZ, maxZ, minY, maxY };
}
