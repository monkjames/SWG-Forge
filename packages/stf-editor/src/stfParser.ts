/**
 * STF (String Table File) Parser
 *
 * Format (Little Endian):
 * - Magic: 0xABCD (2 bytes)
 * - Padding: 2 bytes
 * - Version: 1 byte
 * - NextUID: 4 bytes (uint32)
 * - NumStrings: 4 bytes (uint32)
 * - Value Section (for each string):
 *     - Index: 4 bytes (uint32)
 *     - Key: 4 bytes (0xFFFFFFFF)
 *     - StringLen: 4 bytes (character count)
 *     - Value: StringLen * 2 bytes (UTF-16LE)
 * - ID Section (for each string):
 *     - Index: 4 bytes (uint32)
 *     - IDLen: 4 bytes
 *     - ID: IDLen bytes (ASCII)
 */

export interface StringEntry {
    id: string;
    value: string;
}

export interface STFData {
    version: number;
    nextUid: number;
    entries: StringEntry[];
}

const MAGIC = 0xABCD;

export function parseSTF(data: Uint8Array): STFData {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;

    // Read magic
    const magic = view.getUint16(pos, true);
    pos += 2;
    if (magic !== MAGIC) {
        throw new Error(`Invalid magic: expected 0x${MAGIC.toString(16).toUpperCase()}, got 0x${magic.toString(16).toUpperCase()}`);
    }

    // Skip padding
    pos += 2;

    // Read version
    const version = view.getUint8(pos);
    pos += 1;

    // Read nextUid
    const nextUid = view.getUint32(pos, true);
    pos += 4;

    // Read numStrings
    const numStrings = view.getUint32(pos, true);
    pos += 4;

    // Read value section
    const values: Map<number, string> = new Map();
    for (let i = 0; i < numStrings; i++) {
        const index = view.getUint32(pos, true);
        pos += 4;
        // Skip key (0xFFFFFFFF)
        pos += 4;
        const strLen = view.getUint32(pos, true);
        pos += 4;

        // Read UTF-16LE string
        const strBytes = data.slice(pos, pos + strLen * 2);
        const value = decodeUTF16LE(strBytes);
        pos += strLen * 2;

        values.set(index, value);
    }

    // Read ID section
    const entries: StringEntry[] = [];
    for (let i = 0; i < numStrings; i++) {
        const index = view.getUint32(pos, true);
        pos += 4;
        const idLen = view.getUint32(pos, true);
        pos += 4;

        // Read ASCII string
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

export function serializeSTF(stf: STFData): Uint8Array {
    // Calculate total size
    let size = 2 + 2 + 1 + 4 + 4; // header

    for (const entry of stf.entries) {
        // Value section: index + key + strLen + value
        size += 4 + 4 + 4 + entry.value.length * 2;
        // ID section: index + idLen + id
        size += 4 + 4 + entry.id.length;
    }

    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    const data = new Uint8Array(buffer);
    let pos = 0;

    // Write magic
    view.setUint16(pos, MAGIC, true);
    pos += 2;

    // Write padding
    view.setUint16(pos, 0, true);
    pos += 2;

    // Write version
    view.setUint8(pos, stf.version);
    pos += 1;

    // Write nextUid
    view.setUint32(pos, stf.nextUid, true);
    pos += 4;

    // Write numStrings
    view.setUint32(pos, stf.entries.length, true);
    pos += 4;

    // Write value section
    for (let i = 0; i < stf.entries.length; i++) {
        const entry = stf.entries[i];
        const index = i + 1;

        view.setUint32(pos, index, true);
        pos += 4;
        view.setUint32(pos, 0xFFFFFFFF, true);
        pos += 4;
        view.setUint32(pos, entry.value.length, true);
        pos += 4;

        // Write UTF-16LE string
        const encoded = encodeUTF16LE(entry.value);
        data.set(encoded, pos);
        pos += encoded.length;
    }

    // Write ID section
    for (let i = 0; i < stf.entries.length; i++) {
        const entry = stf.entries[i];
        const index = i + 1;

        view.setUint32(pos, index, true);
        pos += 4;
        view.setUint32(pos, entry.id.length, true);
        pos += 4;

        // Write ASCII string
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
