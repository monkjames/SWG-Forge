/**
 * CRC String Table Editor (CSTB format)
 * Adapted from vscode-mount-wizard/src/crcTable.ts
 */

import * as fs from 'fs';
import * as path from 'path';

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

interface CRCEntry {
    crc: number;
    path: string;
}

function parseCRCTable(data: Uint8Array): CRCEntry[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;

    pos += 4; pos += 4; pos += 4; // FORM + size + CSTB
    pos += 4; pos += 4; pos += 4; // FORM + size + 0000

    pos += 4; pos += 4; // DATA tag + size
    const entryCount = view.getUint32(pos, true);
    pos += 4;

    pos += 4; pos += 4; // CRCT tag + size
    const crcs: number[] = [];
    for (let i = 0; i < entryCount; i++) {
        crcs.push(view.getUint32(pos, true));
        pos += 4;
    }

    pos += 4; pos += 4; // STRT tag + size
    const offsets: number[] = [];
    for (let i = 0; i < entryCount; i++) {
        offsets.push(view.getUint32(pos, true));
        pos += 4;
    }

    pos += 4; pos += 4; // STNG tag + size
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
    entries.sort((a, b) => (a.crc >>> 0) - (b.crc >>> 0));

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
    const innerFormSize = 4 + innerContentSize;
    const outerFormSize = 4 + 8 + innerFormSize;
    const total = 8 + outerFormSize;

    const buffer = new ArrayBuffer(total);
    const view = new DataView(buffer);
    const arr = new Uint8Array(buffer);
    let pos = 0;

    writeTag(arr, pos, 'FORM'); pos += 4;
    view.setUint32(pos, outerFormSize, false); pos += 4;
    writeTag(arr, pos, 'CSTB'); pos += 4;

    writeTag(arr, pos, 'FORM'); pos += 4;
    view.setUint32(pos, innerFormSize, false); pos += 4;
    writeTag(arr, pos, '0000'); pos += 4;

    writeTag(arr, pos, 'DATA'); pos += 4;
    view.setUint32(pos, dataChunkSize, false); pos += 4;
    view.setUint32(pos, entryCount, true); pos += 4;

    writeTag(arr, pos, 'CRCT'); pos += 4;
    view.setUint32(pos, crctChunkSize, false); pos += 4;
    for (const entry of entries) {
        view.setUint32(pos, entry.crc, true); pos += 4;
    }

    writeTag(arr, pos, 'STRT'); pos += 4;
    view.setUint32(pos, strtChunkSize, false); pos += 4;
    for (const offset of stringOffsets) {
        view.setUint32(pos, offset, true); pos += 4;
    }

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

/**
 * Add one or more paths to the CRC string table.
 * Returns the count of newly added entries.
 */
export function addCRCEntries(workspaceRoot: string, objectPaths: string[]): number {
    const relativePath = 'misc/object_template_crc_string_table.iff';
    const workingPath = path.join(workspaceRoot, 'tre/working', relativePath);

    if (!fs.existsSync(workingPath)) {
        const vanillaPath = path.join(workspaceRoot, 'tre/vanilla', relativePath);
        if (fs.existsSync(vanillaPath)) {
            fs.mkdirSync(path.dirname(workingPath), { recursive: true });
            fs.copyFileSync(vanillaPath, workingPath);
        } else {
            throw new Error('CRC string table not found');
        }
    }

    const data = new Uint8Array(fs.readFileSync(workingPath));
    const entries = parseCRCTable(data);
    const existingCrcs = new Set(entries.map(e => e.crc));

    let added = 0;
    for (const objPath of objectPaths) {
        const crc = calculateCRC(objPath);
        if (!existingCrcs.has(crc)) {
            entries.push({ crc, path: objPath });
            existingCrcs.add(crc);
            added++;
        }
    }

    if (added > 0) {
        fs.writeFileSync(workingPath, serializeCRCTable(entries));
    }
    return added;
}

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
