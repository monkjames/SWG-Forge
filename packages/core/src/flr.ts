/**
 * FLR (Floor) File Parser for SWG
 *
 * Floor files define walkable navigation meshes for building cells.
 * Contains vertices and triangles that define the floor geometry.
 */

import { parseIFF, serializeIFF, findForm, findChunk, IFFNode } from './iff';

export interface FloorVertex {
    x: number;
    y: number;
    z: number;
}

export interface FloorTriangle {
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

export interface FloorData {
    version: string;
    verts: FloorVertex[];
    tris: FloorTriangle[];
    bounds: {
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
        minZ: number;
        maxZ: number;
    };
}

/**
 * Parse a FLR (floor) file from binary data
 */
export function parseFLR(data: Uint8Array): FloorData {
    const root = parseIFF(data);

    // Expect FORM FLOR at root
    if (root.type !== 'form' || root.formName !== 'FLOR') {
        throw new Error(`Expected FORM FLOR, got ${root.type} ${root.formName}`);
    }

    // Get version form (0005 or 0006)
    const versionForm = root.children?.[0];
    if (!versionForm || versionForm.type !== 'form') {
        throw new Error('Missing version form in FLR');
    }

    const version = versionForm.formName || 'UNKNOWN';
    if (version !== '0005' && version !== '0006') {
        console.warn(`Unknown FLR version: ${version}`);
    }

    // Parse VERT chunk
    const verts = parseVertices(versionForm);

    // Parse TRIS chunk
    const tris = parseTriangles(versionForm);

    // Calculate bounds from vertices
    const bounds = calculateBounds(verts);

    return {
        version,
        verts,
        tris,
        bounds
    };
}

function parseVertices(versionForm: any): FloorVertex[] {
    const verts: FloorVertex[] = [];

    const vertChunk = findChunk(versionForm, 'VERT');
    if (!vertChunk?.data) {
        return verts;
    }

    try {
        const data = vertChunk.data;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;

        // Read vertex count
        if (offset + 4 > data.length) return verts;
        const vertCount = view.getInt32(offset, false);
        offset += 4;

        // Read vertices (each is 12 bytes: 3 floats)
        for (let i = 0; i < vertCount && offset + 12 <= data.length; i++) {
            verts.push({
                x: view.getFloat32(offset, true),
                y: view.getFloat32(offset + 4, true),
                z: view.getFloat32(offset + 8, true)
            });
            offset += 12;
        }
    } catch (error) {
        console.warn('Error parsing floor vertices:', error);
    }

    return verts;
}

function parseTriangles(versionForm: any): FloorTriangle[] {
    const tris: FloorTriangle[] = [];

    const trisChunk = findChunk(versionForm, 'TRIS');
    if (!trisChunk?.data) {
        return tris;
    }

    try {
        const data = trisChunk.data;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;

        // Read triangle count
        if (offset + 4 > data.length) return tris;
        const triCount = view.getInt32(offset, false);
        offset += 4;

        // Each triangle is 60 bytes in version 0002 format
        // Field order per Python reference (swg_types.py FloorTri.read_0002):
        // corner1/2/3, index, nindex1/2/3, normal(3 floats), edgeType1/2/3,
        // fallthrough, partTag, portalId1/2/3
        for (let i = 0; i < triCount && offset + 60 <= data.length; i++) {
            tris.push({
                corner1: view.getInt32(offset, false),
                corner2: view.getInt32(offset + 4, false),
                corner3: view.getInt32(offset + 8, false),
                index: view.getInt32(offset + 12, false),
                nindex1: view.getInt32(offset + 16, false),
                nindex2: view.getInt32(offset + 20, false),
                nindex3: view.getInt32(offset + 24, false),
                normal: {
                    x: view.getFloat32(offset + 28, true),
                    y: view.getFloat32(offset + 32, true),
                    z: view.getFloat32(offset + 36, true)
                },
                edgeType1: view.getUint8(offset + 40),
                edgeType2: view.getUint8(offset + 41),
                edgeType3: view.getUint8(offset + 42),
                fallthrough: view.getUint8(offset + 43) !== 0,
                partTag: view.getInt32(offset + 44, false),
                portalId1: view.getInt32(offset + 48, false),
                portalId2: view.getInt32(offset + 52, false),
                portalId3: view.getInt32(offset + 56, false),
            });
            offset += 60;
        }
    } catch (error) {
        console.warn('Error parsing floor triangles:', error);
    }

    return tris;
}

function calculateBounds(verts: FloorVertex[]): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
} {
    if (verts.length === 0) {
        return { minX: -20, maxX: 20, minY: -20, maxY: 20, minZ: 0, maxZ: 0 };
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const vert of verts) {
        if (vert.x < minX) minX = vert.x;
        if (vert.x > maxX) maxX = vert.x;
        if (vert.y < minY) minY = vert.y;
        if (vert.y > maxY) maxY = vert.y;
        if (vert.z < minZ) minZ = vert.z;
        if (vert.z > maxZ) maxZ = vert.z;
    }

    return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * Get simplified bounds for spawning (adds padding to floor bounds)
 */
export function getSpawnBounds(floorData: FloorData): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    z: number;
} {
    const padding = 1.0; // 1 meter padding from walls

    return {
        minX: floorData.bounds.minX + padding,
        maxX: floorData.bounds.maxX - padding,
        minY: floorData.bounds.minY + padding,
        maxY: floorData.bounds.maxY - padding,
        z: floorData.bounds.minZ // Use floor height (typically negative, e.g., -12.00)
    };
}

// ============================================================================
// Serialization
// ============================================================================

function makeChunk(tag: string, data: Uint8Array): IFFNode {
    return { type: 'chunk', tag, data, offset: 0, size: data.length };
}

function makeForm(formName: string, children: IFFNode[]): IFFNode {
    return { type: 'form', tag: 'FORM', formName, children, offset: 0, size: 0 };
}

/**
 * Serialize FloorData to binary FLR format (version 0006)
 */
export function serializeFLR(floor: FloorData): Uint8Array {
    // VERT chunk: count(int32 BE) + vertices (3 floats LE each)
    const vertSize = 4 + floor.verts.length * 12;
    const vertBuf = new ArrayBuffer(vertSize);
    const vertView = new DataView(vertBuf);
    vertView.setInt32(0, floor.verts.length, false);
    let vOff = 4;
    for (const v of floor.verts) {
        vertView.setFloat32(vOff, v.x, true); vOff += 4;
        vertView.setFloat32(vOff, v.y, true); vOff += 4;
        vertView.setFloat32(vOff, v.z, true); vOff += 4;
    }

    // TRIS chunk: count(int32 BE) + triangles (60 bytes each)
    const trisSize = 4 + floor.tris.length * 60;
    const trisBuf = new ArrayBuffer(trisSize);
    const trisView = new DataView(trisBuf);
    trisView.setInt32(0, floor.tris.length, false);
    let tOff = 4;
    for (const tri of floor.tris) {
        trisView.setInt32(tOff, tri.corner1, false); tOff += 4;
        trisView.setInt32(tOff, tri.corner2, false); tOff += 4;
        trisView.setInt32(tOff, tri.corner3, false); tOff += 4;
        trisView.setInt32(tOff, tri.index, false); tOff += 4;
        trisView.setInt32(tOff, tri.nindex1, false); tOff += 4;
        trisView.setInt32(tOff, tri.nindex2, false); tOff += 4;
        trisView.setInt32(tOff, tri.nindex3, false); tOff += 4;
        trisView.setFloat32(tOff, tri.normal.x, true); tOff += 4;
        trisView.setFloat32(tOff, tri.normal.y, true); tOff += 4;
        trisView.setFloat32(tOff, tri.normal.z, true); tOff += 4;
        trisView.setUint8(tOff, tri.edgeType1); tOff += 1;
        trisView.setUint8(tOff, tri.edgeType2); tOff += 1;
        trisView.setUint8(tOff, tri.edgeType3); tOff += 1;
        trisView.setUint8(tOff, tri.fallthrough ? 1 : 0); tOff += 1;
        trisView.setInt32(tOff, tri.partTag, false); tOff += 4;
        trisView.setInt32(tOff, tri.portalId1, false); tOff += 4;
        trisView.setInt32(tOff, tri.portalId2, false); tOff += 4;
        trisView.setInt32(tOff, tri.portalId3, false); tOff += 4;
    }

    // BEDG chunk: border edges (triangle edges with no neighbor)
    const borderEdges: { tri: number; edge: number; crossable: boolean }[] = [];
    for (let i = 0; i < floor.tris.length; i++) {
        const tri = floor.tris[i];
        if (tri.nindex1 === -1) {
            borderEdges.push({ tri: i, edge: 0, crossable: tri.edgeType1 !== 0 });
        }
        if (tri.nindex2 === -1) {
            borderEdges.push({ tri: i, edge: 1, crossable: tri.edgeType2 !== 0 });
        }
        if (tri.nindex3 === -1) {
            borderEdges.push({ tri: i, edge: 2, crossable: tri.edgeType3 !== 0 });
        }
    }

    const bedgSize = 4 + borderEdges.length * 9;
    const bedgBuf = new ArrayBuffer(bedgSize);
    const bedgView = new DataView(bedgBuf);
    bedgView.setInt32(0, borderEdges.length, false);
    let bOff = 4;
    for (const be of borderEdges) {
        bedgView.setInt32(bOff, be.tri, false); bOff += 4;
        bedgView.setInt32(bOff, be.edge, false); bOff += 4;
        bedgView.setUint8(bOff, be.crossable ? 1 : 0); bOff += 1;
    }

    const versionChildren: IFFNode[] = [
        makeChunk('VERT', new Uint8Array(vertBuf)),
        makeChunk('TRIS', new Uint8Array(trisBuf)),
        makeChunk('BEDG', new Uint8Array(bedgBuf)),
    ];

    const root = makeForm('FLOR', [makeForm('0006', versionChildren)]);
    return serializeIFF(root);
}
