/**
 * CRC String Table Editor (CSTB format)
 * Adapted from vscode-crc-editor/src/crcTableParser.ts and crc.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── CRC-32 Calculation (MPEG-2 standard) ───────────────────────────────────

export function calculateCRC(input: string): number {
    const normalized = input.toLowerCase();
    let crc = 0xFFFFFFFF;

    for (let i = 0; i < normalized.length; i++) {
        const byte = normalized.charCodeAt(i) & 0xFF;
        crc ^= (byte << 24);
        for (let j = 0; j < 8; j++) {
            if (crc & 0x80000000) {
                crc = ((crc << 1) ^ 0x04C11DB7) >>> 0;
            } else {
                crc = (crc << 1) >>> 0;
            }
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── CSTB Format Parser ─────────────────────────────────────────────────────

interface CRCEntry {
    crc: number;
    path: string;
}

function parseCRCTable(data: Uint8Array): CRCEntry[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;

    // FORM CSTB
    pos += 4; // FORM tag
    pos += 4; // size
    pos += 4; // CSTB tag

    // FORM 0000
    pos += 4; // FORM tag
    pos += 4; // size
    pos += 4; // 0000 tag

    // DATA chunk
    pos += 4; // DATA tag
    pos += 4; // size
    const entryCount = view.getUint32(pos, true);
    pos += 4;

    // CRCT chunk
    pos += 4; // CRCT tag
    pos += 4; // size
    const crcs: number[] = [];
    for (let i = 0; i < entryCount; i++) {
        crcs.push(view.getUint32(pos, true));
        pos += 4;
    }

    // STRT chunk
    pos += 4; // STRT tag
    pos += 4; // size
    const offsets: number[] = [];
    for (let i = 0; i < entryCount; i++) {
        offsets.push(view.getUint32(pos, true));
        pos += 4;
    }

    // STNG chunk
    pos += 4; // STNG tag
    pos += 4; // size
    const stngStart = pos;

    const entries: CRCEntry[] = [];
    for (let i = 0; i < entryCount; i++) {
        let strPos = stngStart + offsets[i];
        let str = '';
        while (strPos < data.length && data[strPos] !== 0) {
            str += String.fromCharCode(data[strPos]);
            strPos++;
        }
        entries.push({ crc: crcs[i], path: str });
    }

    return entries;
}

function serializeCRCTable(entries: CRCEntry[]): Uint8Array {
    // Sort by CRC (unsigned ascending)
    entries.sort((a, b) => (a.crc >>> 0) - (b.crc >>> 0));

    // Build string pool
    let stringPool = '';
    const stringOffsets: number[] = [];
    for (const entry of entries) {
        stringOffsets.push(stringPool.length);
        stringPool += entry.path + '\0';
    }

    const entryCount = entries.length;
    const dataChunkSize = 4;
    const crctChunkSize = entryCount * 4;
    const strtChunkSize = entryCount * 4;
    const stngChunkSize = stringPool.length;

    const innerContentSize = (8 + dataChunkSize) + (8 + crctChunkSize) + (8 + strtChunkSize) + (8 + stngChunkSize);
    const outerContentSize = (8 + innerContentSize + 4); // +4 for '0000' tag
    const totalSize = 12 + outerContentSize; // FORM + size + CSTB + rest

    // Actually: FORM(4) + size(4) + CSTB(4) = 12 for outer header
    // Inner: FORM(4) + size(4) + 0000(4) + chunks
    const innerFormSize = 4 + innerContentSize; // '0000' tag + chunks
    const outerFormSize = 4 + 8 + innerFormSize; // 'CSTB' tag + inner FORM header + inner content
    const total = 8 + outerFormSize;

    const buffer = new ArrayBuffer(total);
    const view = new DataView(buffer);
    const arr = new Uint8Array(buffer);
    let pos = 0;

    // Outer FORM CSTB
    writeTag(arr, pos, 'FORM'); pos += 4;
    view.setUint32(pos, outerFormSize, false); pos += 4;
    writeTag(arr, pos, 'CSTB'); pos += 4;

    // Inner FORM 0000
    writeTag(arr, pos, 'FORM'); pos += 4;
    view.setUint32(pos, innerFormSize, false); pos += 4;
    writeTag(arr, pos, '0000'); pos += 4;

    // DATA
    writeTag(arr, pos, 'DATA'); pos += 4;
    view.setUint32(pos, dataChunkSize, false); pos += 4;
    view.setUint32(pos, entryCount, true); pos += 4;

    // CRCT
    writeTag(arr, pos, 'CRCT'); pos += 4;
    view.setUint32(pos, crctChunkSize, false); pos += 4;
    for (const entry of entries) {
        view.setUint32(pos, entry.crc, true); pos += 4;
    }

    // STRT
    writeTag(arr, pos, 'STRT'); pos += 4;
    view.setUint32(pos, strtChunkSize, false); pos += 4;
    for (const offset of stringOffsets) {
        view.setUint32(pos, offset, true); pos += 4;
    }

    // STNG
    writeTag(arr, pos, 'STNG'); pos += 4;
    view.setUint32(pos, stngChunkSize, false); pos += 4;
    for (let i = 0; i < stringPool.length; i++) {
        arr[pos++] = stringPool.charCodeAt(i);
    }

    return arr;
}

function writeTag(arr: Uint8Array, pos: number, tag: string): void {
    for (let i = 0; i < 4; i++) arr[pos + i] = tag.charCodeAt(i);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Add a path to the CRC string table. Auto-copies from vanilla if needed.
 * Returns true if the entry was added (false if already exists).
 */
export function addCRCEntry(workspaceRoot: string, objectPath: string): boolean {
    const relativePath = 'misc/object_template_crc_string_table.iff';
    const workingPath = path.join(workspaceRoot, 'tre/working', relativePath);

    // Ensure working copy exists
    if (!fs.existsSync(workingPath)) {
        const vanillaPath = path.join(workspaceRoot, 'tre/vanilla', relativePath);
        if (fs.existsSync(vanillaPath)) {
            const dir = path.dirname(workingPath);
            fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(vanillaPath, workingPath);
        } else {
            throw new Error('CRC string table not found');
        }
    }

    const data = new Uint8Array(fs.readFileSync(workingPath));
    const entries = parseCRCTable(data);

    const crc = calculateCRC(objectPath);

    // Check if already exists
    if (entries.some(e => e.crc === crc)) return false;

    entries.push({ crc, path: objectPath });
    fs.writeFileSync(workingPath, serializeCRCTable(entries));
    return true;
}

/**
 * Check if a path exists in the CRC string table
 */
export function hasCRCEntry(workspaceRoot: string, objectPath: string): boolean {
    const relativePath = 'misc/object_template_crc_string_table.iff';
    let filePath = path.join(workspaceRoot, 'tre/working', relativePath);
    if (!fs.existsSync(filePath)) {
        filePath = path.join(workspaceRoot, 'tre/vanilla', relativePath);
    }
    if (!fs.existsSync(filePath)) return false;

    const data = new Uint8Array(fs.readFileSync(filePath));
    const entries = parseCRCTable(data);
    const crc = calculateCRC(objectPath);
    return entries.some(e => e.crc === crc);
}
