/**
 * STF (String Table File) Parser/Serializer
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
    /** Original index from file, preserved for roundtrip fidelity */
    _index?: number;
    /** Original key field from value section, preserved for roundtrip fidelity */
    _key?: number;
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

    const magic = view.getUint16(pos, true);
    pos += 2;
    if (magic !== MAGIC) {
        throw new Error(`Invalid STF magic: expected 0xABCD, got 0x${magic.toString(16).toUpperCase()}`);
    }

    pos += 2; // padding
    const version = view.getUint8(pos);
    pos += 1;
    const nextUid = view.getUint32(pos, true);
    pos += 4;
    const numStrings = view.getUint32(pos, true);
    pos += 4;

    // Value section
    const values: Map<number, string> = new Map();
    const valueKeys: Map<number, number> = new Map(); // index -> key field
    for (let i = 0; i < numStrings; i++) {
        const index = view.getUint32(pos, true);
        pos += 4;
        const key = view.getUint32(pos, true);
        valueKeys.set(index, key);
        pos += 4;
        const strLen = view.getUint32(pos, true);
        pos += 4;
        const strBytes = data.slice(pos, pos + strLen * 2);
        let value = '';
        for (let j = 0; j < strBytes.length; j += 2) {
            value += String.fromCharCode(strBytes[j] | (strBytes[j + 1] << 8));
        }
        pos += strLen * 2;
        values.set(index, value);
    }

    // ID section
    const entries: StringEntry[] = [];
    for (let i = 0; i < numStrings; i++) {
        const index = view.getUint32(pos, true);
        pos += 4;
        const idLen = view.getUint32(pos, true);
        pos += 4;
        let id = '';
        for (let j = 0; j < idLen; j++) {
            id += String.fromCharCode(data[pos + j]);
        }
        pos += idLen;
        entries.push({ id, value: values.get(index) || '', _index: index, _key: valueKeys.get(index) });
    }

    return { version, nextUid, entries };
}

export function serializeSTF(stf: STFData): Uint8Array {
    let size = 2 + 2 + 1 + 4 + 4; // header
    for (const entry of stf.entries) {
        size += 4 + 4 + 4 + entry.value.length * 2; // value section
        size += 4 + 4 + entry.id.length;             // id section
    }

    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    const result = new Uint8Array(buffer);
    let pos = 0;

    view.setUint16(pos, MAGIC, true); pos += 2;
    view.setUint16(pos, 0, true); pos += 2; // padding
    view.setUint8(pos, stf.version); pos += 1;
    view.setUint32(pos, stf.nextUid, true); pos += 4;
    view.setUint32(pos, stf.entries.length, true); pos += 4;

    // Value section — write in index order (sequential 1..N) for roundtrip fidelity.
    // Build index-to-value map, then write sequentially.
    const hasOrigIndices = stf.entries.some(e => e._index !== undefined);
    if (hasOrigIndices) {
        // Build maps from original index to value and key
        const valueByIndex = new Map<number, string>();
        const keyByIndex = new Map<number, number>();
        for (const entry of stf.entries) {
            valueByIndex.set(entry._index!, entry.value);
            keyByIndex.set(entry._index!, entry._key ?? 0xFFFFFFFF);
        }
        // Write in sorted index order (value section is always sequential)
        const sortedIndices = [...valueByIndex.keys()].sort((a, b) => a - b);
        for (const idx of sortedIndices) {
            const value = valueByIndex.get(idx)!;
            view.setUint32(pos, idx, true); pos += 4;
            view.setUint32(pos, keyByIndex.get(idx)!, true); pos += 4;
            view.setUint32(pos, value.length, true); pos += 4;
            for (let j = 0; j < value.length; j++) {
                const code = value.charCodeAt(j);
                result[pos++] = code & 0xFF;
                result[pos++] = (code >> 8) & 0xFF;
            }
        }
    } else {
        // No original indices — use sequential (new file)
        for (let i = 0; i < stf.entries.length; i++) {
            const entry = stf.entries[i];
            view.setUint32(pos, i + 1, true); pos += 4;
            view.setUint32(pos, 0xFFFFFFFF, true); pos += 4;
            view.setUint32(pos, entry.value.length, true); pos += 4;
            for (let j = 0; j < entry.value.length; j++) {
                const code = entry.value.charCodeAt(j);
                result[pos++] = code & 0xFF;
                result[pos++] = (code >> 8) & 0xFF;
            }
        }
    }

    // ID section — write in entries array order with original indices
    for (let i = 0; i < stf.entries.length; i++) {
        const entry = stf.entries[i];
        const idx = entry._index ?? (i + 1);
        view.setUint32(pos, idx, true); pos += 4;
        view.setUint32(pos, entry.id.length, true); pos += 4;
        for (let j = 0; j < entry.id.length; j++) {
            result[pos++] = entry.id.charCodeAt(j);
        }
    }

    return result;
}

/**
 * Add entries to an STF, avoiding duplicates by id.
 * Returns the number of entries actually added.
 */
export function addSTFEntries(stf: STFData, newEntries: StringEntry[]): number {
    let added = 0;
    for (const entry of newEntries) {
        if (!stf.entries.some(e => e.id === entry.id)) {
            stf.entries.push(entry);
            added++;
        }
    }
    stf.nextUid = stf.entries.length + 1;
    return added;
}
