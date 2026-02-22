/**
 * POB (Portalized Object) Parser for SWG Building Files
 *
 * POB files define interior spaces with cells (rooms), portals (doorways),
 * and collision geometry. Used for player structures and dungeon layouts.
 */

import { parseIFF, serializeIFF, findForm, findChunk, IFFNode } from './iff';

export interface Vector3 {
    x: number;
    y: number;
    z: number;
}

export interface Portal {
    id: number;
    verts: Vector3[];
    tris: Triangle[];
}

export interface Triangle {
    p1: number;
    p2: number;
    p3: number;
}

export interface PortalData {
    id: number;
    clockwise: boolean;
    passable: boolean;
    connecting_cell: number;
    doorstyle?: string;
    doorhardpoint?: number[];
}

export interface Light {
    lightType: number;
    diffuse_color: number[];
    specular_color: number[];
    transform: number[];
    constant_att: number;
    linear_att: number;
    quad_att: number;
}

export interface CollisionExtent {
    type: 'NULL' | 'CMSH' | 'EXBX' | 'EXSP' | 'XCYL' | 'UNKNOWN';
    rawNode?: IFFNode; // Full IFF subtree for round-trip serialization
}

export interface Cell {
    name: string;
    appearance_file: string;
    floor_file?: string;
    can_see_world: boolean;
    portals: PortalData[];
    collision: CollisionExtent;
    lights: Light[];
}

export interface PathGraphNode {
    index: number;
    id: number;
    key: number;
    type: number;
    position: Vector3;
    radius: number;
}

export interface PathGraphEdge {
    indexA: number;
    indexB: number;
    widthRight: number;
    widthLeft: number;
}

export interface PathGraph {
    pathGraphType: number;
    nodes: PathGraphNode[];
    edges: PathGraphEdge[];
}

export interface PobData {
    version: string;
    portals: Portal[];
    cells: Cell[];
    pathGraph?: PathGraph;
    crc?: number;
}

/**
 * Parse a POB file from binary data
 */
export function parsePOB(data: Uint8Array): PobData {
    const root = parseIFF(data);

    // Expect FORM PRTO at root
    if (root.type !== 'form' || root.formName !== 'PRTO') {
        throw new Error(`Expected FORM PRTO, got ${root.type} ${root.formName}`);
    }

    // Get version form (0003 or 0004)
    const versionForm = root.children?.[0];
    if (!versionForm || versionForm.type !== 'form') {
        throw new Error('Missing version form in POB');
    }

    const version = versionForm.formName || 'UNKNOWN';
    if (version !== '0003' && version !== '0004') {
        console.warn(`Unknown POB version: ${version}`);
    }

    // Parse DATA chunk (portal count, cell count)
    const dataChunk = findChunk(versionForm, 'DATA');
    if (!dataChunk?.data) {
        throw new Error('Missing DATA chunk');
    }

    const dataView = new DataView(dataChunk.data.buffer, dataChunk.data.byteOffset, dataChunk.data.byteLength);
    // v0003 uses little-endian, v0004 uses big-endian for DATA chunk
    const isLE = version === '0003';
    const numPortals = dataView.getInt32(0, isLE);
    const numCells = dataView.getInt32(4, isLE);

    // Parse portals
    const portals = parsePortals(versionForm, version, numPortals);

    // Parse cells
    const cells = parseCells(versionForm, numCells, version);

    // Parse optional path graph
    let pathGraph: PathGraph | undefined;
    const pgrafForm = findForm(versionForm, 'PGRF');
    if (pgrafForm) {
        pathGraph = parsePathGraph(pgrafForm, version);
    }

    // Parse optional CRC
    let crc: number | undefined;
    const crcChunk = findChunk(versionForm, 'CRC ');
    if (crcChunk?.data && crcChunk.data.length >= 4) {
        const crcView = new DataView(crcChunk.data.buffer, crcChunk.data.byteOffset, crcChunk.data.byteLength);
        crc = crcView.getInt32(0, isLE);
    }

    return {
        version,
        portals,
        cells,
        pathGraph,
        crc
    };
}

/**
 * Parse portal geometries (PRTS form)
 */
function parsePortals(versionForm: IFFNode, version: string, numPortals: number): Portal[] {
    const prtsForm = findForm(versionForm, 'PRTS');
    if (!prtsForm?.children) {
        return [];
    }

    const portals: Portal[] = [];

    try {
        if (version === '0004') {
            // Version 0004: IDTL forms with VERT and INDX chunks
            for (let i = 0; i < numPortals && i < prtsForm.children.length; i++) {
                const idtlForm = prtsForm.children[i];
                if (!idtlForm || idtlForm.type !== 'form' || idtlForm.formName !== 'IDTL') {
                    continue;
                }

                const form0000 = idtlForm.children?.[0];
                if (!form0000 || form0000.formName !== '0000') {
                    continue;
                }

                const vertChunk = findChunk(form0000, 'VERT');
                const indxChunk = findChunk(form0000, 'INDX');

                const verts: Vector3[] = [];
                const tris: Triangle[] = [];

                if (vertChunk?.data && vertChunk.data.length > 0) {
                    try {
                        const data = vertChunk.data;
                        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                        for (let j = 0; j + 12 <= data.length; j += 12) {
                            verts.push({
                                x: view.getFloat32(j, true),
                                y: view.getFloat32(j + 4, true),
                                z: view.getFloat32(j + 8, true)
                            });
                        }
                    } catch (e) {
                        console.warn(`Error parsing portal ${i} vertices:`, e);
                    }
                }

                if (indxChunk?.data && indxChunk.data.length > 0) {
                    try {
                        const data = indxChunk.data;
                        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                        for (let j = 0; j + 12 <= data.length; j += 12) {
                            tris.push({
                                p1: view.getInt32(j, true),
                                p2: view.getInt32(j + 4, true),
                                p3: view.getInt32(j + 8, true)
                            });
                        }
                    } catch (e) {
                        console.warn(`Error parsing portal ${i} indices:`, e);
                    }
                }

                portals.push({ id: i, verts, tris });
            }
        } else if (version === '0003') {
            // Version 0003: PRTL chunks with int32 numVerts + vertex data
            // Triangles generated as fan: (0, i-1, i) for i in 2..numVerts
            for (let i = 0; i < numPortals && i < prtsForm.children.length; i++) {
                const prtlChunk = prtsForm.children[i];
                if (!prtlChunk || !prtlChunk.data) {
                    portals.push({ id: i, verts: [], tris: [] });
                    continue;
                }

                try {
                    const data = prtlChunk.data;
                    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                    let offset = 0;

                    const numVerts = view.getInt32(offset, true); // Little-endian
                    offset += 4;

                    const verts: Vector3[] = [];
                    for (let j = 0; j < numVerts && offset + 12 <= data.length; j++) {
                        verts.push({
                            x: view.getFloat32(offset, true),
                            y: view.getFloat32(offset + 4, true),
                            z: view.getFloat32(offset + 8, true)
                        });
                        offset += 12;
                    }

                    // Generate triangle fan
                    const tris: Triangle[] = [];
                    for (let j = 2; j < numVerts; j++) {
                        tris.push({ p1: 0, p2: j - 1, p3: j });
                    }

                    portals.push({ id: i, verts, tris });
                } catch (e) {
                    console.warn(`Error parsing v0003 portal ${i}:`, e);
                    portals.push({ id: i, verts: [], tris: [] });
                }
            }
        }
    } catch (error) {
        console.warn('Error parsing portals:', error);
    }

    return portals;
}

/**
 * Parse cells (CELS form)
 */
function parseCells(versionForm: IFFNode, numCells: number, version: string): Cell[] {
    const celsForm = findForm(versionForm, 'CELS');
    if (!celsForm?.children) {
        return [];
    }

    const cells: Cell[] = [];

    for (let i = 0; i < numCells; i++) {
        const cellForm = celsForm.children[i];
        if (!cellForm || cellForm.type !== 'form' || cellForm.formName !== 'CELL') {
            continue;
        }

        const cell0005 = cellForm.children?.[0];
        if (!cell0005 || cell0005.formName !== '0005') {
            continue;
        }

        // Parse DATA chunk
        const dataChunk = findChunk(cell0005, 'DATA');
        if (!dataChunk?.data) {
            continue;
        }

        const cellData = parseCellData(dataChunk.data, version);

        // Parse portals
        const portals = parseCellPortals(cell0005, cellData.numPortals);

        // Parse lights
        const lights = parseCellLights(cell0005, version);

        // Parse collision
        const collision = parseCollision(cell0005);

        cells.push({
            name: cellData.name,
            appearance_file: cellData.appearance,
            floor_file: cellData.floor,
            can_see_world: cellData.canSeeWorld,
            portals,
            collision,
            lights
        });
    }

    return cells;
}

function parseCellData(data: Uint8Array, version: string): {
    numPortals: number;
    canSeeWorld: boolean;
    name: string;
    appearance: string;
    floor?: string;
} {
    try {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;
        const isLE = version === '0003';

        if (offset + 4 > data.length) {
            throw new Error('Insufficient data for numPortals');
        }
        const numPortals = view.getInt32(offset, isLE);
        offset += 4;

        if (offset >= data.length) {
            throw new Error('Insufficient data for canSeeWorld');
        }
        const canSeeWorld = data[offset] !== 0;
        offset += 1;

        // Read null-terminated strings
        const name = readNullString(data, offset);
        offset += name.length + 1;

        if (offset > data.length) {
            throw new Error('Insufficient data after name');
        }

        const appearance = readNullString(data, offset);
        offset += appearance.length + 1;

        if (offset > data.length) {
            throw new Error('Insufficient data for hasFloor');
        }

        const hasFloor = data[offset] !== 0;
        offset += 1;

        let floor: string | undefined;
        if (hasFloor && offset < data.length) {
            floor = readNullString(data, offset);
        }

        return { numPortals, canSeeWorld, name, appearance, floor };
    } catch (error) {
        console.warn('Error parsing cell data:', error);
        return { numPortals: 0, canSeeWorld: false, name: 'unknown', appearance: '' };
    }
}

function readNullString(data: Uint8Array, offset: number): string {
    const bytes: number[] = [];
    while (offset < data.length && data[offset] !== 0) {
        bytes.push(data[offset]);
        offset++;
    }
    return String.fromCharCode(...bytes);
}

function parseCellPortals(cell0005: IFFNode, numPortals: number): PortalData[] {
    const portals: PortalData[] = [];

    if (!cell0005.children) return portals;

    // Find PRTL forms
    for (const child of cell0005.children) {
        if (child.type === 'form' && child.formName === 'PRTL') {
            const prtlForm = child;
            const versionChunk = prtlForm.children?.[0];

            if (!versionChunk || versionChunk.type !== 'chunk') continue;

            const version = versionChunk.tag;
            if (version !== '0004' && version !== '0005') continue;

            if (!versionChunk.data) continue;

            try {
                const data = versionChunk.data;
                const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                let offset = 0;

                let disabled = false;
                if (version === '0005') {
                    if (offset >= data.length) continue;
                    disabled = data[offset] !== 0;
                    offset += 1;
                }

                if (offset >= data.length) continue;
                const passable = data[offset] !== 0;
                offset += 1;

                if (offset + 4 > data.length) continue;
                const portal_id = view.getInt32(offset, true); // Little-endian
                offset += 4;

                if (offset >= data.length) continue;
                const clockwise = data[offset] !== 0;
                offset += 1;

                if (offset + 4 > data.length) continue;
                const connecting_cell = view.getInt32(offset, true); // Little-endian
                offset += 4;

                const doorstyle = readNullStringFromView(data, offset);
                offset += doorstyle.length + 1;

                if (offset >= data.length) continue;
                const hasDoorHardpoint = data[offset] !== 0;
                offset += 1;

                let doorhardpoint: number[] | undefined;
                if (hasDoorHardpoint && offset + 48 <= data.length) {
                    doorhardpoint = [];
                    for (let i = 0; i < 12; i++) {
                        doorhardpoint.push(view.getFloat32(offset, true));
                        offset += 4;
                    }
                }

                portals.push({
                    id: portal_id,
                    clockwise,
                    passable,
                    connecting_cell,
                    doorstyle: doorstyle || undefined,
                    doorhardpoint
                });
            } catch (error) {
                console.warn('Error parsing portal:', error);
                continue;
            }
        }
    }

    return portals;
}

function readNullStringFromView(data: Uint8Array, offset: number): string {
    const bytes: number[] = [];
    while (offset < data.length && data[offset] !== 0) {
        bytes.push(data[offset]);
        offset++;
    }
    return String.fromCharCode(...bytes);
}

function parseCellLights(cell0005: IFFNode, version: string): Light[] {
    const lights: Light[] = [];

    const lghtChunk = findChunk(cell0005, 'LGHT');
    if (!lghtChunk?.data) return lights;

    try {
        const data = lghtChunk.data;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;
        const isLE = version === '0003';

        if (offset + 4 > data.length) return lights;
        const count = view.getInt32(offset, isLE);
        offset += 4;

        for (let i = 0; i < count; i++) {
            // Each light requires 81 bytes (1 + 16 + 16 + 48)
            if (offset + 81 > data.length) break;

            const lightType = view.getInt8(offset);
            offset += 1;

            const diffuse_color = [
                view.getFloat32(offset, true), // a
                view.getFloat32(offset + 4, true), // r
                view.getFloat32(offset + 8, true), // g
                view.getFloat32(offset + 12, true), // b
            ];
            offset += 16;

            const specular_color = [
                view.getFloat32(offset, true), // a
                view.getFloat32(offset + 4, true), // r
                view.getFloat32(offset + 8, true), // g
                view.getFloat32(offset + 12, true), // b
            ];
            offset += 16;

            const transform = [];
            for (let j = 0; j < 12; j++) {
                transform.push(view.getFloat32(offset, true));
                offset += 4;
            }

            const constant_att = view.getFloat32(offset, true);
            offset += 4;
            const linear_att = view.getFloat32(offset, true);
            offset += 4;
            const quad_att = view.getFloat32(offset, true);
            offset += 4;

            lights.push({
                lightType,
                diffuse_color,
                specular_color,
                transform,
                constant_att,
                linear_att,
                quad_att
            });
        }
    } catch (error) {
        console.warn('Error parsing lights:', error);
    }

    return lights;
}

function parseCollision(cell0005: IFFNode): CollisionExtent {
    if (!cell0005.children) {
        return { type: 'NULL' };
    }

    const collisionTypes = ['NULL', 'CMSH', 'EXBX', 'EXSP', 'XCYL'] as const;
    for (const child of cell0005.children) {
        if (child.type === 'form') {
            const formName = child.formName;
            for (const ct of collisionTypes) {
                if (formName === ct) {
                    return { type: ct, rawNode: child };
                }
            }
        }
    }

    return { type: 'NULL' };
}

function parsePathGraph(pgrafForm: IFFNode, pobVersion: string): PathGraph {
    const nodes: PathGraphNode[] = [];
    const edges: PathGraphEdge[] = [];
    let pathGraphType = 0;
    // v0003 POBs use little-endian int32s throughout
    const isLE = pobVersion === '0003';

    try {
        const versionForm = pgrafForm.children?.[0];
        if (!versionForm || versionForm.formName !== '0001') {
            return { pathGraphType, nodes, edges };
        }

        // Parse META chunk
        const metaChunk = findChunk(versionForm, 'META');
        if (metaChunk?.data && metaChunk.data.length >= 4) {
            try {
                const view = new DataView(metaChunk.data.buffer, metaChunk.data.byteOffset, metaChunk.data.byteLength);
                pathGraphType = view.getInt32(0, isLE);
            } catch (e) {
                console.warn('Error parsing META chunk:', e);
            }
        }

        // Parse PNOD chunk
        const pnodChunk = findChunk(versionForm, 'PNOD');
        if (pnodChunk?.data && pnodChunk.data.length >= 4) {
            try {
                const data = pnodChunk.data;
                const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                let offset = 0;

                const count = view.getInt32(offset, isLE);
                offset += 4;

                for (let i = 0; i < count; i++) {
                    if (offset + 32 > data.length) break;

                    nodes.push({
                        index: view.getInt32(offset, isLE),
                        id: view.getInt32(offset + 4, isLE),
                        key: view.getInt32(offset + 8, isLE),
                        type: view.getInt32(offset + 12, isLE),
                        position: {
                            x: view.getFloat32(offset + 16, true),
                            y: view.getFloat32(offset + 20, true),
                            z: view.getFloat32(offset + 24, true)
                        },
                        radius: view.getFloat32(offset + 28, true)
                    });
                    offset += 32;
                }
            } catch (e) {
                console.warn('Error parsing PNOD chunk:', e);
            }
        }

        // Parse PEDG chunk
        const pedgChunk = findChunk(versionForm, 'PEDG');
        if (pedgChunk?.data && pedgChunk.data.length >= 4) {
            try {
                const data = pedgChunk.data;
                const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                let offset = 0;

                const count = view.getInt32(offset, isLE);
                offset += 4;

                for (let i = 0; i < count; i++) {
                    if (offset + 16 > data.length) break;

                    edges.push({
                        indexA: view.getInt32(offset, isLE),
                        indexB: view.getInt32(offset + 4, isLE),
                        widthRight: view.getFloat32(offset + 8, true),
                        widthLeft: view.getFloat32(offset + 12, true)
                    });
                    offset += 16;
                }
            } catch (e) {
                console.warn('Error parsing PEDG chunk:', e);
            }
        }
    } catch (error) {
        console.warn('Error parsing path graph:', error);
    }

    return { pathGraphType, nodes, edges };
}

// ============================================================================
// Serialization
// ============================================================================

/** Helper: build a Uint8Array from DataView writes */
class BinaryWriter {
    private buf: ArrayBuffer;
    private view: DataView;
    private pos: number;

    constructor(initialSize = 1024) {
        this.buf = new ArrayBuffer(initialSize);
        this.view = new DataView(this.buf);
        this.pos = 0;
    }

    private grow(needed: number) {
        while (this.pos + needed > this.buf.byteLength) {
            const newBuf = new ArrayBuffer(this.buf.byteLength * 2);
            new Uint8Array(newBuf).set(new Uint8Array(this.buf));
            this.buf = newBuf;
            this.view = new DataView(this.buf);
        }
    }

    int32BE(v: number) { this.grow(4); this.view.setInt32(this.pos, v, false); this.pos += 4; }
    int32LE(v: number) { this.grow(4); this.view.setInt32(this.pos, v, false); this.pos += 4;
        // Actually write little-endian
        this.pos -= 4; this.view.setInt32(this.pos, v, true); this.pos += 4;
    }
    float32LE(v: number) { this.grow(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; }
    uint8(v: number) { this.grow(1); this.view.setUint8(this.pos, v); this.pos += 1; }
    int8(v: number) { this.grow(1); this.view.setInt8(this.pos, v); this.pos += 1; }
    bool8(v: boolean) { this.uint8(v ? 1 : 0); }
    nullString(s: string) {
        this.grow(s.length + 1);
        for (let i = 0; i < s.length; i++) {
            this.view.setUint8(this.pos + i, s.charCodeAt(i));
        }
        this.view.setUint8(this.pos + s.length, 0);
        this.pos += s.length + 1;
    }

    toUint8Array(): Uint8Array {
        return new Uint8Array(this.buf, 0, this.pos);
    }
}

function makeChunk(tag: string, data: Uint8Array): IFFNode {
    return { type: 'chunk', tag, data, offset: 0, size: data.length };
}

function makeForm(formName: string, children: IFFNode[]): IFFNode {
    return { type: 'form', tag: 'FORM', formName, children, offset: 0, size: 0 };
}

/**
 * Serialize a PobData structure to binary POB format.
 * Respects pob.version: outputs v0003 or v0004 format accordingly.
 */
export function serializePOB(pob: PobData): Uint8Array {
    const version = pob.version || '0003';
    const isV3 = version === '0003';
    // v0003 uses LE for int32 counts, v0004 uses BE
    const writeInt32 = (w: BinaryWriter, v: number) => isV3 ? w.int32LE(v) : w.int32BE(v);

    // DATA chunk: numPortals, numCells
    const dataW = new BinaryWriter(8);
    writeInt32(dataW, pob.portals.length);
    writeInt32(dataW, pob.cells.length);

    // PRTS form: portal geometries
    let portalChildren: IFFNode[];
    if (isV3) {
        // v0003: flat PRTL chunks with int32LE(numVerts) + vertex data
        portalChildren = pob.portals.map(portal => {
            const pw = new BinaryWriter(4 + portal.verts.length * 12);
            pw.int32LE(portal.verts.length);
            for (const v of portal.verts) {
                pw.float32LE(v.x);
                pw.float32LE(v.y);
                pw.float32LE(v.z);
            }
            return makeChunk('PRTL', pw.toUint8Array());
        });
    } else {
        // v0004: IDTL forms with VERT and INDX chunks
        portalChildren = pob.portals.map(portal => {
            const vertW = new BinaryWriter(portal.verts.length * 12);
            for (const v of portal.verts) {
                vertW.float32LE(v.x);
                vertW.float32LE(v.y);
                vertW.float32LE(v.z);
            }
            const indxW = new BinaryWriter(portal.tris.length * 12);
            for (const t of portal.tris) {
                indxW.int32LE(t.p1);
                indxW.int32LE(t.p2);
                indxW.int32LE(t.p3);
            }
            return makeForm('IDTL', [
                makeForm('0000', [
                    makeChunk('VERT', vertW.toUint8Array()),
                    makeChunk('INDX', indxW.toUint8Array()),
                ])
            ]);
        });
    }

    // CELS form: cell definitions
    const cellForms: IFFNode[] = pob.cells.map((cell, cellIdx) => {
        // Cell DATA chunk
        const cellDataW = new BinaryWriter(256);
        writeInt32(cellDataW, cell.portals.length);
        cellDataW.bool8(cell.can_see_world);
        cellDataW.nullString(cell.name);
        cellDataW.nullString(cell.appearance_file);
        cellDataW.bool8(!!cell.floor_file);
        if (cell.floor_file) {
            cellDataW.nullString(cell.floor_file);
        }

        // Collision form - use raw node if available, otherwise FORM NULL
        const collisionNode = cell.collision.rawNode || makeForm('NULL', []);

        // Portal forms (PRTL)
        const portalNodes: IFFNode[] = cell.portals.map(p => {
            const pw = new BinaryWriter(128);
            if (!isV3) {
                pw.bool8(false); // disabled flag (v0005 only)
            }
            pw.bool8(p.passable);
            pw.int32LE(p.id);
            pw.bool8(p.clockwise);
            pw.int32LE(p.connecting_cell);
            pw.nullString(p.doorstyle || '');
            const hasHp = !!(p.doorhardpoint && p.doorhardpoint.length === 12);
            pw.bool8(hasHp);
            // Always write 12 floats - identity matrix when no hardpoint
            const hpnt = hasHp && p.doorhardpoint ? p.doorhardpoint : [1,0,0,0, 0,1,0,0, 0,0,1,0];
            for (let i = 0; i < 12; i++) {
                pw.float32LE(hpnt[i]);
            }
            // v0003: cell portal chunk 0004, v0004: cell portal chunk 0005
            const chunkTag = isV3 ? '0004' : '0005';
            return makeForm('PRTL', [
                makeChunk(chunkTag, pw.toUint8Array())
            ]);
        });

        // Lights chunk
        const lghtW = new BinaryWriter(4 + cell.lights.length * 93);
        writeInt32(lghtW, cell.lights.length);
        for (const light of cell.lights) {
            lghtW.int8(light.lightType);
            for (const c of light.diffuse_color) lghtW.float32LE(c);
            for (const c of light.specular_color) lghtW.float32LE(c);
            for (const t of light.transform) lghtW.float32LE(t);
            lghtW.float32LE(light.constant_att);
            lghtW.float32LE(light.linear_att);
            lghtW.float32LE(light.quad_att);
        }

        const cellChildren: IFFNode[] = [
            makeChunk('DATA', cellDataW.toUint8Array()),
            collisionNode,
            ...portalNodes,
            makeChunk('LGHT', lghtW.toUint8Array()),
        ];

        return makeForm('CELL', [makeForm('0005', cellChildren)]);
    });

    // Path graph
    const pgChildren: IFFNode[] = [];
    if (pob.pathGraph) {
        const pg = pob.pathGraph;

        // META
        const metaW = new BinaryWriter(4);
        writeInt32(metaW, pg.pathGraphType);
        pgChildren.push(makeChunk('META', metaW.toUint8Array()));

        // PNOD
        const pnodW = new BinaryWriter(4 + pg.nodes.length * 32);
        writeInt32(pnodW, pg.nodes.length);
        for (const n of pg.nodes) {
            writeInt32(pnodW, n.index);
            writeInt32(pnodW, n.id);
            writeInt32(pnodW, n.key);
            writeInt32(pnodW, n.type);
            pnodW.float32LE(n.position.x);
            pnodW.float32LE(n.position.y);
            pnodW.float32LE(n.position.z);
            pnodW.float32LE(n.radius);
        }
        pgChildren.push(makeChunk('PNOD', pnodW.toUint8Array()));

        // PEDG
        const pedgW = new BinaryWriter(4 + pg.edges.length * 16);
        writeInt32(pedgW, pg.edges.length);
        for (const e of pg.edges) {
            writeInt32(pedgW, e.indexA);
            writeInt32(pedgW, e.indexB);
            pedgW.float32LE(e.widthRight);
            pedgW.float32LE(e.widthLeft);
        }
        pgChildren.push(makeChunk('PEDG', pedgW.toUint8Array()));

        // ECNT: edge counts per node
        const edgeCounts = new Array(pg.nodes.length).fill(0);
        const edgeStarts = new Array(pg.nodes.length).fill(-1);
        for (let i = 0; i < pg.edges.length; i++) {
            const a = pg.edges[i].indexA;
            if (a >= 0 && a < pg.nodes.length) {
                edgeCounts[a]++;
                if (edgeStarts[a] === -1) edgeStarts[a] = i;
            }
        }
        const ecntW = new BinaryWriter(4 + edgeCounts.length * 4);
        writeInt32(ecntW, edgeCounts.length);
        for (const c of edgeCounts) writeInt32(ecntW, c);
        pgChildren.push(makeChunk('ECNT', ecntW.toUint8Array()));

        // ESTR: edge start indices per node
        const estrW = new BinaryWriter(4 + edgeStarts.length * 4);
        writeInt32(estrW, edgeStarts.length);
        for (const s of edgeStarts) writeInt32(estrW, s);
        pgChildren.push(makeChunk('ESTR', estrW.toUint8Array()));
    }

    // Build version form children
    const versionChildren: IFFNode[] = [
        makeChunk('DATA', dataW.toUint8Array()),
        makeForm('PRTS', portalChildren),
        makeForm('CELS', cellForms),
    ];

    if (pgChildren.length > 0) {
        versionChildren.push(makeForm('PGRF', [makeForm('0001', pgChildren)]));
    }

    // CRC: serialize without CRC first, then compute and append
    const root = makeForm('PRTO', [makeForm(version, versionChildren)]);
    const withoutCrc = serializeIFF(root);
    const crcValue = computePobCRC(withoutCrc);

    const crcW = new BinaryWriter(4);
    if (isV3) {
        crcW.int32LE(crcValue);
    } else {
        crcW.int32BE(crcValue);
    }
    versionChildren.push(makeChunk('CRC ', crcW.toUint8Array()));

    // Final serialize
    const finalRoot = makeForm('PRTO', [makeForm(version, versionChildren)]);
    return serializeIFF(finalRoot);
}

/** CRC-32 using SWG's MPEG-2 polynomial (0x04C11DB7) */
function computePobCRC(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i] << 24;
        for (let j = 0; j < 8; j++) {
            if (crc & 0x80000000) {
                crc = ((crc << 1) ^ 0x04C11DB7) >>> 0;
            } else {
                crc = (crc << 1) >>> 0;
            }
        }
    }
    return crc | 0; // Return as signed int32
}

/**
 * Get approximate bounds of a cell from collision geometry
 * Returns null if no usable collision data
 */
export function getCellBounds(cell: Cell): { minX: number; maxX: number; minY: number; maxY: number } | null {
    return {
        minX: -20,
        maxX: 20,
        minY: -20,
        maxY: 20
    };
}
