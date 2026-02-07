/**
 * CRC String Table Parser
 *
 * Format Structure:
 *   FORM CSTB
 *   └── FORM 0000
 *       ├── DATA (4 bytes LE) - Entry count
 *       ├── CRCT (entry_count * 4 bytes) - CRC values (sorted, 4 bytes LE each)
 *       ├── STRT (entry_count * 4 bytes) - String offsets (4 bytes LE each)
 *       └── STNG (variable) - Null-terminated strings
 *
 * The CRCs are sorted for binary search lookup. Each CRC maps to a string offset
 * in the STNG chunk via the parallel STRT array.
 */

export interface CRCEntry {
    crc: number;
    path: string;
}

export interface CRCTable {
    entries: CRCEntry[];
}

/**
 * Parse a CRC string table IFF file
 */
export function parseCRCTable(data: Uint8Array): CRCTable {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;

    // Verify outer FORM CSTB
    const outerForm = readTag(data, pos);
    pos += 4;
    if (outerForm !== 'FORM') {
        throw new Error('Not a valid IFF file: expected FORM, got ' + outerForm);
    }

    const outerSize = view.getUint32(pos, false); // big-endian
    pos += 4;

    const formName = readTag(data, pos);
    pos += 4;
    if (formName !== 'CSTB') {
        throw new Error('Not a valid CSTB file: expected CSTB, got ' + formName);
    }

    // Inner FORM 0000
    const innerForm = readTag(data, pos);
    pos += 4;
    if (innerForm !== 'FORM') {
        throw new Error('Expected inner FORM, got ' + innerForm);
    }

    const innerSize = view.getUint32(pos, false);
    pos += 4;

    const innerName = readTag(data, pos);
    pos += 4;
    if (innerName !== '0000') {
        throw new Error('Expected inner FORM 0000, got ' + innerName);
    }

    // DATA chunk - entry count
    const dataTag = readTag(data, pos);
    pos += 4;
    if (dataTag !== 'DATA') {
        throw new Error('Expected DATA chunk, got ' + dataTag);
    }

    const dataSize = view.getUint32(pos, false);
    pos += 4;

    const entryCount = view.getUint32(pos, true); // little-endian
    pos += dataSize;

    // CRCT chunk - CRC values
    const crctTag = readTag(data, pos);
    pos += 4;
    if (crctTag !== 'CRCT') {
        throw new Error('Expected CRCT chunk, got ' + crctTag);
    }

    const crctSize = view.getUint32(pos, false);
    pos += 4;

    const crcs: number[] = [];
    for (let i = 0; i < entryCount; i++) {
        crcs.push(view.getUint32(pos, true)); // little-endian
        pos += 4;
    }

    // STRT chunk - string offsets
    const strtTag = readTag(data, pos);
    pos += 4;
    if (strtTag !== 'STRT') {
        throw new Error('Expected STRT chunk, got ' + strtTag);
    }

    const strtSize = view.getUint32(pos, false);
    pos += 4;

    const offsets: number[] = [];
    for (let i = 0; i < entryCount; i++) {
        offsets.push(view.getUint32(pos, true)); // little-endian
        pos += 4;
    }

    // STNG chunk - string data
    const stngTag = readTag(data, pos);
    pos += 4;
    if (stngTag !== 'STNG') {
        throw new Error('Expected STNG chunk, got ' + stngTag);
    }

    const stngSize = view.getUint32(pos, false);
    pos += 4;

    const stngStart = pos;

    // Build entries
    const entries: CRCEntry[] = [];
    for (let i = 0; i < entryCount; i++) {
        const strOffset = offsets[i];
        let strEnd = stngStart + strOffset;
        while (strEnd < data.length && data[strEnd] !== 0) {
            strEnd++;
        }
        const path = String.fromCharCode(...data.slice(stngStart + strOffset, strEnd));
        entries.push({ crc: crcs[i], path });
    }

    return { entries };
}

/**
 * Serialize a CRC table back to IFF format
 */
export function serializeCRCTable(table: CRCTable): Uint8Array {
    // Sort entries by CRC
    const sortedEntries = [...table.entries].sort((a, b) => {
        // Unsigned comparison
        if (a.crc === b.crc) return 0;
        return (a.crc >>> 0) < (b.crc >>> 0) ? -1 : 1;
    });

    const entryCount = sortedEntries.length;

    // Build string data and offsets
    const stringData: number[] = [];
    const offsets: number[] = [];

    for (const entry of sortedEntries) {
        offsets.push(stringData.length);
        for (let i = 0; i < entry.path.length; i++) {
            stringData.push(entry.path.charCodeAt(i));
        }
        stringData.push(0); // null terminator
    }

    // Calculate chunk sizes
    const dataSize = 4; // entry count
    const crctSize = entryCount * 4;
    const strtSize = entryCount * 4;
    const stngSize = stringData.length;

    // Inner FORM 0000 content size (everything after the 0000 tag)
    const innerContentSize = (
        4 + 4 + dataSize +  // DATA chunk
        4 + 4 + crctSize +  // CRCT chunk
        4 + 4 + strtSize +  // STRT chunk
        4 + 4 + stngSize    // STNG chunk
    );

    // Outer FORM CSTB content size (everything after the CSTB tag)
    const outerContentSize = (
        4 + 4 + 4 +         // inner FORM header (FORM + size + 0000)
        innerContentSize
    );

    // Total file size
    const totalSize = 4 + 4 + 4 + outerContentSize; // outer FORM header + content

    const result = new Uint8Array(totalSize);
    const view = new DataView(result.buffer);
    let pos = 0;

    // Outer FORM CSTB
    writeTag(result, pos, 'FORM');
    pos += 4;
    view.setUint32(pos, outerContentSize, false); // big-endian
    pos += 4;
    writeTag(result, pos, 'CSTB');
    pos += 4;

    // Inner FORM 0000
    writeTag(result, pos, 'FORM');
    pos += 4;
    view.setUint32(pos, innerContentSize + 4, false); // +4 for 0000 tag
    pos += 4;
    writeTag(result, pos, '0000');
    pos += 4;

    // DATA chunk
    writeTag(result, pos, 'DATA');
    pos += 4;
    view.setUint32(pos, dataSize, false);
    pos += 4;
    view.setUint32(pos, entryCount, true); // little-endian
    pos += 4;

    // CRCT chunk
    writeTag(result, pos, 'CRCT');
    pos += 4;
    view.setUint32(pos, crctSize, false);
    pos += 4;
    for (const entry of sortedEntries) {
        view.setUint32(pos, entry.crc, true); // little-endian
        pos += 4;
    }

    // STRT chunk
    writeTag(result, pos, 'STRT');
    pos += 4;
    view.setUint32(pos, strtSize, false);
    pos += 4;
    for (const offset of offsets) {
        view.setUint32(pos, offset, true); // little-endian
        pos += 4;
    }

    // STNG chunk
    writeTag(result, pos, 'STNG');
    pos += 4;
    view.setUint32(pos, stngSize, false);
    pos += 4;
    for (const byte of stringData) {
        result[pos++] = byte;
    }

    return result;
}

function readTag(data: Uint8Array, pos: number): string {
    return String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
}

function writeTag(data: Uint8Array, pos: number, tag: string): void {
    for (let i = 0; i < 4; i++) {
        data[pos + i] = tag.charCodeAt(i);
    }
}
