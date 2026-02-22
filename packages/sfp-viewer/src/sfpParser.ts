/**
 * Self-contained SFP (Server Footprint) parser.
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

function readTag(buf: Buffer, off: number): string {
    return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

export function parseSFP(fileData: Buffer): SfpData {
    if (fileData.length < 12) {
        throw new Error('File too small for SFP');
    }

    // Verify FORM FOOT
    const outerTag = readTag(fileData, 0);
    const outerFormTag = readTag(fileData, 8);
    if (outerTag !== 'FORM' || outerFormTag !== 'FOOT') {
        throw new Error(`Expected FORM FOOT, got ${outerTag} ${outerFormTag}`);
    }

    // Find INFO and PRNT chunks by scanning
    let infoOffset = -1;
    let prntOffset = -1;
    let prntSize = 0;

    let pos = 12; // skip outer FORM header + FOOT tag
    // Inner FORM 0000
    if (pos + 12 <= fileData.length && readTag(fileData, pos) === 'FORM') {
        pos += 12; // skip FORM header + 0000 tag
    }

    while (pos + 8 <= fileData.length) {
        const tag = readTag(fileData, pos);
        const size = fileData.readUInt32BE(pos + 4);

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

    const colSize = fileData.readInt32LE(infoOffset);
    const rowSize = fileData.readInt32LE(infoOffset + 4);
    const centerX = fileData.readInt32LE(infoOffset + 8);
    const centerY = fileData.readInt32LE(infoOffset + 12);
    const colChunkSize = fileData.readFloatLE(infoOffset + 16);
    const rowChunkSize = fileData.readFloatLE(infoOffset + 20);

    // Parse PRNT grid: null-terminated rows of H/F characters
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
            // Skip null terminator
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

function writeTag(buf: Buffer, off: number, tag: string): void {
    buf[off]     = tag.charCodeAt(0);
    buf[off + 1] = tag.charCodeAt(1);
    buf[off + 2] = tag.charCodeAt(2);
    buf[off + 3] = tag.charCodeAt(3);
}

/**
 * Serialize SfpData back to binary SFP format.
 *
 * Layout:
 *   FORM [totalSize BE] FOOT
 *     FORM [innerSize BE] 0000
 *       INFO [0x00000018 BE] (24 bytes LE payload)
 *       PRNT [prntSize BE]   (null-terminated ASCII rows)
 */
export function serializeSFP(sfp: SfpData): Uint8Array {
    const infoPayload = 24;
    const prntPayload = sfp.rowSize * (sfp.colSize + 1); // each row: colSize chars + \0

    // Chunk sizes: tag(4) + size(4) + payload
    const infoChunkSize = 8 + infoPayload;
    const prntChunkSize = 8 + prntPayload;

    // Inner FORM: tag(4) + size(4) + formTag(4) + chunks
    const innerFormPayload = 4 + infoChunkSize + prntChunkSize; // 4 for "0000" tag
    const innerFormSize = 8 + innerFormPayload;

    // Outer FORM: tag(4) + size(4) + "FOOT"(4) + inner FORM
    const outerFormPayload = 4 + innerFormSize; // 4 for "FOOT" tag
    const totalSize = 8 + outerFormPayload;

    const buf = Buffer.alloc(totalSize);
    let off = 0;

    // Outer FORM FOOT
    writeTag(buf, off, 'FORM'); off += 4;
    buf.writeUInt32BE(outerFormPayload, off); off += 4;
    writeTag(buf, off, 'FOOT'); off += 4;

    // Inner FORM 0000
    writeTag(buf, off, 'FORM'); off += 4;
    buf.writeUInt32BE(innerFormPayload, off); off += 4;
    writeTag(buf, off, '0000'); off += 4;

    // INFO chunk
    writeTag(buf, off, 'INFO'); off += 4;
    buf.writeUInt32BE(infoPayload, off); off += 4;
    buf.writeInt32LE(sfp.colSize, off); off += 4;
    buf.writeInt32LE(sfp.rowSize, off); off += 4;
    buf.writeInt32LE(sfp.centerX, off); off += 4;
    buf.writeInt32LE(sfp.centerY, off); off += 4;
    buf.writeFloatLE(sfp.colChunkSize, off); off += 4;
    buf.writeFloatLE(sfp.rowChunkSize, off); off += 4;

    // PRNT chunk
    writeTag(buf, off, 'PRNT'); off += 4;
    buf.writeUInt32BE(prntPayload, off); off += 4;
    for (let r = 0; r < sfp.rowSize; r++) {
        for (let c = 0; c < sfp.colSize; c++) {
            const ch = (sfp.grid[r] && sfp.grid[r][c]) || 'F';
            buf[off] = ch.charCodeAt(0);
            off++;
        }
        buf[off] = 0; // null terminator
        off++;
    }

    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
