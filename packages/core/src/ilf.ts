/**
 * ILF (Interior Layout File) parser and serializer.
 *
 * ILF files describe object placement inside building cells.
 * Format: FORM INLY → FORM 0000 → NODE chunks
 *
 * Each NODE contains:
 *   - Template path (null-terminated string)
 *   - Cell name (null-terminated string)
 *   - 12 little-endian floats: 4x3 column-major affine transform
 *     (3x3 rotation in rows 0-2, position in row 3)
 */

export interface ILFNode {
    /** Object template path, e.g. "object/tangible/furniture/all/shared_frn_all_plant_potted_lg_s2.iff" */
    templatePath: string;
    /** Cell name this object belongs to, e.g. "room", "foyer" */
    cellName: string;
    /** 4x3 column-major transform: m[row][col], row 3 = position */
    transform: number[][];
    /** Extracted position for convenience */
    posX: number;
    posY: number;
    posZ: number;
    /** Extracted quaternion (w, x, y, z) from rotation matrix */
    quatW: number;
    quatX: number;
    quatY: number;
    quatZ: number;
}

export interface ILFData {
    nodes: ILFNode[];
    /** Distinct cell names found */
    cells: string[];
}

/** Extract quaternion from a 3x3 rotation matrix (rows 0-2 of the 4x3 transform) */
function matrixToQuaternion(m: number[][]): { w: number; x: number; y: number; z: number } {
    const m00 = m[0][0], m01 = m[0][1], m02 = m[0][2];
    const m10 = m[1][0], m11 = m[1][1], m12 = m[1][2];
    const m20 = m[2][0], m21 = m[2][1], m22 = m[2][2];

    const trace = m00 + m11 + m22;
    let w: number, x: number, y: number, z: number;

    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1.0);
        w = 0.25 / s;
        x = (m21 - m12) * s;
        y = (m02 - m20) * s;
        z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
        const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
        w = (m21 - m12) / s;
        x = 0.25 * s;
        y = (m01 + m10) / s;
        z = (m02 + m20) / s;
    } else if (m11 > m22) {
        const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
        w = (m02 - m20) / s;
        x = (m01 + m10) / s;
        y = 0.25 * s;
        z = (m12 + m21) / s;
    } else {
        const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
        w = (m10 - m01) / s;
        x = (m02 + m20) / s;
        y = (m12 + m21) / s;
        z = 0.25 * s;
    }

    return { w, x, y, z };
}

/** Read a null-terminated string from a buffer at offset. Returns [string, newOffset]. */
function readNullStr(buf: Buffer, offset: number): [string, number] {
    let end = offset;
    while (end < buf.length && buf[end] !== 0) end++;
    return [buf.toString('ascii', offset, end), end + 1];
}

/**
 * Parse an ILF file buffer into structured data.
 */
export function parseILF(buf: Buffer): ILFData {
    // Validate: FORM tag
    const formTag = buf.toString('ascii', 0, 4);
    if (formTag !== 'FORM') {
        throw new Error('Not an IFF file (expected FORM, got ' + formTag + ')');
    }

    // Validate: INLY form type
    const formType = buf.toString('ascii', 8, 12);
    if (formType !== 'INLY') {
        throw new Error('Not an ILF file (expected INLY, got ' + formType + ')');
    }

    // Skip: FORM INLY header (12) + FORM 0000 header (12)
    let offset = 24;
    const fileEnd = buf.readUInt32BE(4) + 8; // FORM size + 8 for tag+size

    const nodes: ILFNode[] = [];
    const cellSet = new Set<string>();

    while (offset < fileEnd) {
        const chunkTag = buf.toString('ascii', offset, offset + 4);
        const chunkSize = buf.readUInt32BE(offset + 4);
        offset += 8;

        if (chunkTag !== 'NODE') {
            // Skip unknown chunks
            offset += chunkSize;
            continue;
        }

        const chunkEnd = offset + chunkSize;

        // Template path
        const [templatePath, off1] = readNullStr(buf, offset);
        // Cell name
        const [cellName, off2] = readNullStr(buf, off1);

        // 12 floats: column-major 4x3 (column 0, then 1, then 2; each column = rows 0-3)
        let foff = off2;
        const m: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let col = 0; col < 3; col++) {
            for (let row = 0; row < 4; row++) {
                m[row][col] = buf.readFloatLE(foff);
                foff += 4;
            }
        }

        const q = matrixToQuaternion(m);
        cellSet.add(cellName);

        nodes.push({
            templatePath,
            cellName,
            transform: m,
            posX: m[3][0],
            posY: m[3][1],
            posZ: m[3][2],
            quatW: q.w,
            quatX: q.x,
            quatY: q.y,
            quatZ: q.z,
        });

        offset = chunkEnd;
    }

    return {
        nodes,
        cells: Array.from(cellSet).sort(),
    };
}

/**
 * Serialize ILF data back to a binary buffer.
 */
export function serializeILF(data: ILFData): Buffer {
    // Calculate total NODE data size
    let nodesDataSize = 0;
    for (const node of data.nodes) {
        // tag(4) + size(4) + template+null + cell+null + 48 floats
        nodesDataSize += 8 + (node.templatePath.length + 1) + (node.cellName.length + 1) + 48;
    }

    // FORM INLY: tag(4) + size(4) + "INLY"(4) + FORM 0000 content
    // FORM 0000: tag(4) + size(4) + "0000"(4) + nodes
    const form0000ContentSize = 4 + nodesDataSize; // "0000" + nodes
    const formInlyContentSize = 4 + 8 + form0000ContentSize; // "INLY" + FORM header + content

    const buf = Buffer.alloc(8 + formInlyContentSize);
    let off = 0;

    // FORM INLY
    buf.write('FORM', off); off += 4;
    buf.writeUInt32BE(formInlyContentSize, off); off += 4;
    buf.write('INLY', off); off += 4;

    // FORM 0000
    buf.write('FORM', off); off += 4;
    buf.writeUInt32BE(form0000ContentSize, off); off += 4;
    buf.write('0000', off); off += 4;

    // NODE chunks
    for (const node of data.nodes) {
        const nodeDataSize = (node.templatePath.length + 1) + (node.cellName.length + 1) + 48;
        buf.write('NODE', off); off += 4;
        buf.writeUInt32BE(nodeDataSize, off); off += 4;

        // Template path + null
        buf.write(node.templatePath, off, 'ascii'); off += node.templatePath.length;
        buf.writeUInt8(0, off); off += 1;

        // Cell name + null
        buf.write(node.cellName, off, 'ascii'); off += node.cellName.length;
        buf.writeUInt8(0, off); off += 1;

        // 12 floats column-major
        const m = node.transform;
        for (let col = 0; col < 3; col++) {
            for (let row = 0; row < 4; row++) {
                buf.writeFloatLE(m[row][col], off); off += 4;
            }
        }
    }

    return buf;
}
