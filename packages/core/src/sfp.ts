/**
 * SFP (Server Footprint) parser and serializer.
 *
 * SFP files define the placement grid for structures in SWG.
 * IFF structure: FORM FOOT → FORM 0000 → INFO (24 bytes) + PRNT (grid)
 *
 * All payload ints and floats are little-endian (engine3 native x86_64).
 */

export interface SfpCell {
    col: number;
    row: number;
    type: string;  // 'H' = has structure, 'F' = free
}

export interface SfpData {
    colSize: number;        // grid width in cells
    rowSize: number;        // grid height in cells
    centerX: number;        // center offset X in cells
    centerY: number;        // center offset Y in cells
    colChunkSize: number;   // meters per cell in X
    rowChunkSize: number;   // meters per cell in Y
    totalWidth: number;     // colSize * colChunkSize (meters)
    totalHeight: number;    // rowSize * rowChunkSize (meters)
    grid: string[][];       // grid[row][col] = 'H' or 'F'
}

function readTag(buf: Uint8Array, off: number): string {
    return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

function readUint32BE(buf: Uint8Array, off: number): number {
    return (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0;
}

function readInt32LE(buf: Uint8Array, off: number): number {
    return buf[off] | buf[off + 1] << 8 | buf[off + 2] << 16 | buf[off + 3] << 24;
}

function readFloat32LE(buf: Uint8Array, off: number): number {
    const view = new DataView(buf.buffer, buf.byteOffset + off, 4);
    return view.getFloat32(0, true);
}

export function parseSFP(fileData: Uint8Array): SfpData {
    if (fileData.length < 12) {
        throw new Error('File too small for SFP');
    }

    const outerTag = readTag(fileData, 0);
    const outerFormTag = readTag(fileData, 8);
    if (outerTag !== 'FORM' || outerFormTag !== 'FOOT') {
        throw new Error(`Expected FORM FOOT, got ${outerTag} ${outerFormTag}`);
    }

    let infoOffset = -1;
    let prntOffset = -1;
    let prntSize = 0;

    let pos = 12;
    if (pos + 12 <= fileData.length && readTag(fileData, pos) === 'FORM') {
        pos += 12;
    }

    while (pos + 8 <= fileData.length) {
        const tag = readTag(fileData, pos);
        const size = readUint32BE(fileData, pos + 4);

        if (tag === 'INFO') {
            infoOffset = pos + 8;
        } else if (tag === 'PRNT') {
            prntOffset = pos + 8;
            prntSize = size;
        }

        pos += 8 + size;
    }

    if (infoOffset < 0 || infoOffset + 24 > fileData.length) {
        throw new Error('Missing or truncated INFO chunk');
    }

    const colSize = readInt32LE(fileData, infoOffset);
    const rowSize = readInt32LE(fileData, infoOffset + 4);
    const centerX = readInt32LE(fileData, infoOffset + 8);
    const centerY = readInt32LE(fileData, infoOffset + 12);
    const colChunkSize = readFloat32LE(fileData, infoOffset + 16);
    const rowChunkSize = readFloat32LE(fileData, infoOffset + 20);

    const grid: string[][] = [];

    if (prntOffset >= 0 && prntSize > 0) {
        let off = prntOffset;
        const end = prntOffset + prntSize;

        for (let r = 0; r < rowSize && off < end; r++) {
            const row: string[] = [];
            for (let c = 0; c < colSize && off < end; c++) {
                row.push(String.fromCharCode(fileData[off]));
                off++;
            }
            grid.push(row);
            if (off < end && fileData[off] === 0) {
                off++;
            }
        }
    }

    return {
        colSize,
        rowSize,
        centerX,
        centerY,
        colChunkSize,
        rowChunkSize,
        totalWidth: colSize * colChunkSize,
        totalHeight: rowSize * rowChunkSize,
        grid,
    };
}

function writeTag(buf: Uint8Array, off: number, tag: string): void {
    buf[off]     = tag.charCodeAt(0);
    buf[off + 1] = tag.charCodeAt(1);
    buf[off + 2] = tag.charCodeAt(2);
    buf[off + 3] = tag.charCodeAt(3);
}

function writeUint32BE(buf: Uint8Array, off: number, val: number): void {
    buf[off]     = (val >>> 24) & 0xff;
    buf[off + 1] = (val >>> 16) & 0xff;
    buf[off + 2] = (val >>> 8) & 0xff;
    buf[off + 3] = val & 0xff;
}

function writeInt32LE(buf: Uint8Array, off: number, val: number): void {
    buf[off]     = val & 0xff;
    buf[off + 1] = (val >>> 8) & 0xff;
    buf[off + 2] = (val >>> 16) & 0xff;
    buf[off + 3] = (val >>> 24) & 0xff;
}

function writeFloat32LE(buf: Uint8Array, off: number, val: number): void {
    const view = new DataView(buf.buffer, buf.byteOffset + off, 4);
    view.setFloat32(0, val, true);
}

/**
 * Serialize SfpData back to binary SFP format.
 */
export function serializeSFP(sfp: SfpData): Uint8Array {
    const infoPayload = 24;
    const prntPayload = sfp.rowSize * (sfp.colSize + 1);

    const infoChunkSize = 8 + infoPayload;
    const prntChunkSize = 8 + prntPayload;

    const innerFormPayload = 4 + infoChunkSize + prntChunkSize;
    const outerFormPayload = 4 + 8 + innerFormPayload;
    const totalSize = 8 + outerFormPayload;

    const buf = new Uint8Array(totalSize);
    let off = 0;

    writeTag(buf, off, 'FORM'); off += 4;
    writeUint32BE(buf, off, outerFormPayload); off += 4;
    writeTag(buf, off, 'FOOT'); off += 4;

    writeTag(buf, off, 'FORM'); off += 4;
    writeUint32BE(buf, off, innerFormPayload); off += 4;
    writeTag(buf, off, '0000'); off += 4;

    writeTag(buf, off, 'INFO'); off += 4;
    writeUint32BE(buf, off, infoPayload); off += 4;
    writeInt32LE(buf, off, sfp.colSize); off += 4;
    writeInt32LE(buf, off, sfp.rowSize); off += 4;
    writeInt32LE(buf, off, sfp.centerX); off += 4;
    writeInt32LE(buf, off, sfp.centerY); off += 4;
    writeFloat32LE(buf, off, sfp.colChunkSize); off += 4;
    writeFloat32LE(buf, off, sfp.rowChunkSize); off += 4;

    writeTag(buf, off, 'PRNT'); off += 4;
    writeUint32BE(buf, off, prntPayload); off += 4;
    for (let r = 0; r < sfp.rowSize; r++) {
        for (let c = 0; c < sfp.colSize; c++) {
            const ch = (sfp.grid[r] && sfp.grid[r][c]) || 'F';
            buf[off] = ch.charCodeAt(0);
            off++;
        }
        buf[off] = 0;
        off++;
    }

    return buf;
}

/**
 * Generate an SFP footprint from dimensions. All cells set to 'H'.
 */
export function generateSFP(widthMeters: number, heightMeters: number, cellSize: number = 4): SfpData {
    const colSize = Math.max(1, Math.ceil(widthMeters / cellSize));
    const rowSize = Math.max(1, Math.ceil(heightMeters / cellSize));
    const grid: string[][] = [];
    for (let r = 0; r < rowSize; r++) {
        const row: string[] = [];
        for (let c = 0; c < colSize; c++) {
            row.push('H');
        }
        grid.push(row);
    }
    return {
        colSize,
        rowSize,
        centerX: Math.floor(colSize / 2),
        centerY: Math.floor(rowSize / 2),
        colChunkSize: cellSize,
        rowChunkSize: cellSize,
        totalWidth: colSize * cellSize,
        totalHeight: rowSize * cellSize,
        grid,
    };
}
