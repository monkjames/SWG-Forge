/**
 * STF (String Table File) Editor
 * Adapted from vscode-stf-editor/src/stfParser.ts
 */

import * as fs from 'fs';
import * as path from 'path';

export interface StringEntry {
    id: string;
    value: string;
}

interface STFData {
    version: number;
    nextUid: number;
    entries: StringEntry[];
}

const MAGIC = 0xABCD;

function parseSTF(data: Uint8Array): STFData {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;

    const magic = view.getUint16(pos, true);
    pos += 2;
    if (magic !== MAGIC) {
        throw new Error(`Invalid STF magic: 0x${magic.toString(16).toUpperCase()}`);
    }

    pos += 2; // padding

    const version = view.getUint8(pos);
    pos += 1;

    const nextUid = view.getUint32(pos, true);
    pos += 4;

    const numStrings = view.getUint32(pos, true);
    pos += 4;

    const values: Map<number, string> = new Map();
    for (let i = 0; i < numStrings; i++) {
        const index = view.getUint32(pos, true);
        pos += 4;
        pos += 4; // skip key (0xFFFFFFFF)
        const strLen = view.getUint32(pos, true);
        pos += 4;

        const strBytes = data.slice(pos, pos + strLen * 2);
        const value = decodeUTF16LE(strBytes);
        pos += strLen * 2;

        values.set(index, value);
    }

    const entries: StringEntry[] = [];
    for (let i = 0; i < numStrings; i++) {
        const index = view.getUint32(pos, true);
        pos += 4;
        const idLen = view.getUint32(pos, true);
        pos += 4;

        const idBytes = data.slice(pos, pos + idLen);
        const id = decodeASCII(idBytes);
        pos += idLen;

        entries.push({
            id,
            value: values.get(index) || ''
        });
    }

    return { version, nextUid, entries };
}

function serializeSTF(stf: STFData): Uint8Array {
    let size = 2 + 2 + 1 + 4 + 4;

    for (const entry of stf.entries) {
        size += 4 + 4 + 4 + entry.value.length * 2;
        size += 4 + 4 + entry.id.length;
    }

    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    const data = new Uint8Array(buffer);
    let pos = 0;

    view.setUint16(pos, MAGIC, true); pos += 2;
    view.setUint16(pos, 0, true); pos += 2;
    view.setUint8(pos, stf.version); pos += 1;
    view.setUint32(pos, stf.nextUid, true); pos += 4;
    view.setUint32(pos, stf.entries.length, true); pos += 4;

    for (let i = 0; i < stf.entries.length; i++) {
        const entry = stf.entries[i];
        const index = i + 1;

        view.setUint32(pos, index, true); pos += 4;
        view.setUint32(pos, 0xFFFFFFFF, true); pos += 4;
        view.setUint32(pos, entry.value.length, true); pos += 4;

        const encoded = encodeUTF16LE(entry.value);
        data.set(encoded, pos);
        pos += encoded.length;
    }

    for (let i = 0; i < stf.entries.length; i++) {
        const entry = stf.entries[i];
        const index = i + 1;

        view.setUint32(pos, index, true); pos += 4;
        view.setUint32(pos, entry.id.length, true); pos += 4;

        const encoded = encodeASCII(entry.id);
        data.set(encoded, pos);
        pos += encoded.length;
    }

    return data;
}

function decodeUTF16LE(bytes: Uint8Array): string {
    const chars: string[] = [];
    for (let i = 0; i < bytes.length; i += 2) {
        const code = bytes[i] | (bytes[i + 1] << 8);
        chars.push(String.fromCharCode(code));
    }
    return chars.join('');
}

function encodeUTF16LE(str: string): Uint8Array {
    const bytes = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        bytes[i * 2] = code & 0xFF;
        bytes[i * 2 + 1] = (code >> 8) & 0xFF;
    }
    return bytes;
}

function decodeASCII(bytes: Uint8Array): string {
    return String.fromCharCode(...bytes);
}

function encodeASCII(str: string): Uint8Array {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i);
    }
    return bytes;
}

/**
 * Add strings to an STF file. Creates the file if it doesn't exist.
 * Returns the count of newly added entries.
 */
export function addStrings(stfPath: string, newEntries: StringEntry[]): number {
    let stf: STFData;

    if (fs.existsSync(stfPath)) {
        const data = new Uint8Array(fs.readFileSync(stfPath));
        stf = parseSTF(data);
    } else {
        fs.mkdirSync(path.dirname(stfPath), { recursive: true });
        stf = { version: 1, nextUid: 1, entries: [] };
    }

    const existingIds = new Set(stf.entries.map(e => e.id));
    let added = 0;

    for (const entry of newEntries) {
        if (existingIds.has(entry.id)) {
            // Update existing entry
            const existing = stf.entries.find(e => e.id === entry.id);
            if (existing) {
                existing.value = entry.value;
            }
        } else {
            stf.entries.push(entry);
            added++;
        }
    }

    stf.nextUid = stf.entries.length + 1;
    fs.writeFileSync(stfPath, serializeSTF(stf));
    return added;
}

/**
 * Read all entries from an STF file
 */
export function readStrings(stfPath: string): StringEntry[] {
    if (!fs.existsSync(stfPath)) return [];
    const data = new Uint8Array(fs.readFileSync(stfPath));
    return parseSTF(data).entries;
}
