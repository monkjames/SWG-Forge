import * as zlib from 'zlib';
import { FIELD_DICTIONARY, FieldInfo } from './fieldDictionary';

const CLASSNAME_HASH = 0x76457CCA;

export interface ParsedField {
    hash: number;
    size: number;
    data: Buffer;
    name: string;
    type: string;
    decoded: string;
}

export interface RecordSummary {
    className: string;
    fieldCount: number;
    decompressedSize: number;
    compressedSize: number;
}

export interface RecordDetail {
    className: string;
    fields: ParsedField[];
    decompressedSize: number;
}

/**
 * Decompress a BDB record value.
 * Most databases use per-record zlib compression (magic byte 0x78).
 * navareas.db and databases.db store raw data.
 */
export function decompressRecord(valueBuf: Buffer): Buffer {
    if (valueBuf.length >= 2 && valueBuf[0] === 0x78) {
        try {
            return zlib.inflateSync(valueBuf);
        } catch {
            return valueBuf;
        }
    }
    return valueBuf;
}

/**
 * Extract just the class name and field count from a record (fast path for page view).
 */
export function parseRecordSummary(valueHex: string): RecordSummary {
    const compressedSize = valueHex.length / 2;
    const compressed = Buffer.from(valueHex, 'hex');
    const data = decompressRecord(compressed);
    const decompressedSize = data.length;

    if (data.length < 2) {
        return { className: '?', fieldCount: 0, decompressedSize, compressedSize };
    }

    const varCount = data.readUInt16LE(0);
    let offset = 2;
    let className = '?';

    for (let i = 0; i < varCount; i++) {
        if (offset + 8 > data.length) { break; }
        const hash = data.readUInt32LE(offset);
        offset += 4;
        const size = data.readUInt32LE(offset);
        offset += 4;

        if (offset + size > data.length) { break; }

        if (hash === CLASSNAME_HASH) {
            className = decodeString(data, offset);
            break;
        }

        offset += size;
    }

    return { className, fieldCount: varCount, decompressedSize, compressedSize };
}

/**
 * Fully parse a record into named, typed, decoded fields.
 */
export function parseRecordDetail(valueHex: string): RecordDetail {
    const compressed = Buffer.from(valueHex, 'hex');
    const data = decompressRecord(compressed);
    const fields: ParsedField[] = [];

    if (data.length < 2) {
        return { className: '?', fields, decompressedSize: data.length };
    }

    const varCount = data.readUInt16LE(0);
    let offset = 2;
    let className = '?';

    for (let i = 0; i < varCount; i++) {
        if (offset + 8 > data.length) { break; }
        const hash = data.readUInt32LE(offset);
        offset += 4;
        const size = data.readUInt32LE(offset);
        offset += 4;

        if (offset + size > data.length) { break; }

        const fieldData = data.subarray(offset, offset + size);
        const dictEntry = FIELD_DICTIONARY.get(hash);
        const name = dictEntry ? dictEntry.name : unknownFieldName(hash);
        const type = dictEntry ? dictEntry.type : '?';
        const decoded = decodeField(fieldData, type);

        if (hash === CLASSNAME_HASH) {
            className = decoded;
        }

        fields.push({ hash, size, data: fieldData, name, type, decoded });
        offset += size;
    }

    return { className, fields, decompressedSize: data.length };
}

function unknownFieldName(hash: number): string {
    return '[0x' + hash.toString(16).toUpperCase().padStart(8, '0') + ']';
}

/**
 * Decode a field value based on its C++ type string from the dictionary.
 */
function decodeField(data: Buffer, type: string): string {
    try {
        // Primitives
        if (type === 'bool' && data.length >= 1) {
            return data[0] !== 0 ? 'true' : 'false';
        }
        if (type === 'byte' && data.length >= 1) {
            return data.readUInt8(0).toString();
        }
        if (type === 'short' && data.length >= 2) {
            return data.readInt16LE(0).toString();
        }
        if (type === 'int' && data.length >= 4) {
            return data.readInt32LE(0).toString();
        }
        if ((type === 'unsigned int' || type === 'uint32') && data.length >= 4) {
            const val = data.readUInt32LE(0);
            return val > 0xFFFF ? '0x' + val.toString(16).toUpperCase() : val.toString();
        }
        if (type === 'float' && data.length >= 4) {
            return data.readFloatLE(0).toFixed(4).replace(/\.?0+$/, '');
        }
        if ((type === 'unsigned long long' || type === 'long long') && data.length >= 8) {
            const val = data.readBigUInt64LE(0);
            if (val === 0n) { return '0'; }
            return '0x' + val.toString(16).toUpperCase().padStart(16, '0');
        }

        // Strings
        if (type === 'String') {
            return decodeString(data, 0);
        }
        if (type === 'UnicodeString') {
            return decodeUnicodeString(data, 0);
        }

        // References — stored as uint64 OID
        if (type.startsWith('ManagedReference<') || type.startsWith('ManagedWeakReference<')) {
            if (data.length >= 8) {
                const val = data.readBigUInt64LE(0);
                if (val === 0n) { return 'null'; }
                return '0x' + val.toString(16).toUpperCase().padStart(16, '0');
            }
            return hexDump(data);
        }

        // Special compound types
        if (type === 'Quaternion' && data.length >= 16) {
            const w = data.readFloatLE(0).toFixed(4);
            const x = data.readFloatLE(4).toFixed(4);
            const y = data.readFloatLE(8).toFixed(4);
            const z = data.readFloatLE(12).toFixed(4);
            return `(w=${w}, x=${x}, y=${y}, z=${z})`;
        }

        if (type === 'StringId') {
            return decodeStringId(data);
        }

        if (type === 'Time' && data.length >= 4) {
            const ts = data.readUInt32LE(0);
            if (ts === 0) { return '0 (never)'; }
            return new Date(ts * 1000).toISOString();
        }

        if (type === 'AtomicInteger' && data.length >= 4) {
            return data.readInt32LE(0).toString();
        }

        // Vectors / collections — show count + elements for simple types
        if (type.startsWith('Vector<') || type.startsWith('SortedVector<') ||
            type.startsWith('DeltaVector<') || type.startsWith('AutoDeltaSet<')) {
            return decodeVector(data, type);
        }

        if (type.startsWith('VectorMap<') || type.startsWith('SynchronizedVectorMap<')) {
            return decodeVectorMap(data, type);
        }

        // Coordinate (from TreeEntry): 6 floats
        if (type === 'Coordinate' && data.length >= 24) {
            return decodeCoordinate(data);
        }

        // Fallback: hex dump
        return hexDump(data);
    } catch {
        return hexDump(data);
    }
}

function decodeString(data: Buffer, offset: number): string {
    if (offset + 2 > data.length) { return ''; }
    const len = data.readUInt16LE(offset);
    offset += 2;
    if (offset + len > data.length) { return `[truncated, len=${len}]`; }
    return data.toString('utf8', offset, offset + len);
}

function decodeUnicodeString(data: Buffer, offset: number): string {
    if (offset + 4 > data.length) { return ''; }
    const charCount = data.readUInt32LE(offset);
    offset += 4;
    const byteLen = charCount * 2;
    if (offset + byteLen > data.length) { return `[truncated, chars=${charCount}]`; }
    return data.toString('utf16le', offset, offset + byteLen);
}

function decodeStringId(data: Buffer): string {
    let offset = 0;
    if (offset + 2 > data.length) { return '@:'; }
    const fileLen = data.readUInt16LE(offset);
    offset += 2;
    if (offset + fileLen > data.length) { return '@?:?'; }
    const file = data.toString('utf8', offset, offset + fileLen);
    offset += fileLen;
    if (offset + 2 > data.length) { return `@${file}:?`; }
    const keyLen = data.readUInt16LE(offset);
    offset += 2;
    if (offset + keyLen > data.length) { return `@${file}:?`; }
    const key = data.toString('utf8', offset, offset + keyLen);
    if (!file && !key) { return '(empty)'; }
    return `@${file}:${key}`;
}

function decodeCoordinate(data: Buffer): string {
    // Coordinate serializes as Serializable with string-named fields:
    // It may use the old Serializable format (string names, not hashes)
    // Try to detect: if first 2 bytes look like a small varCount, parse as Serializable
    if (data.length >= 2) {
        const varCount = data.readUInt16LE(0);
        if (varCount <= 10 && varCount > 0) {
            // Likely a Serializable sub-object. Extract floats from named fields.
            // For display, just show the raw floats we can find
            const floats: number[] = [];
            let off = 2;
            for (let i = 0; i < varCount && off + 2 < data.length; i++) {
                // String-name format: uint16 nameLen, chars, uint32 size, data
                const nameLen = data.readUInt16LE(off);
                off += 2;
                if (off + nameLen > data.length) { break; }
                off += nameLen; // skip name
                if (off + 4 > data.length) { break; }
                const size = data.readUInt32LE(off);
                off += 4;
                if (off + size > data.length) { break; }
                if (size === 4) {
                    floats.push(data.readFloatLE(off));
                }
                off += size;
            }
            if (floats.length >= 3) {
                return `(${floats.map(f => f.toFixed(2)).join(', ')})`;
            }
        }
    }
    // Fallback: try reading as raw floats
    if (data.length >= 24) {
        const vals = [];
        for (let i = 0; i < 6 && i * 4 + 4 <= data.length; i++) {
            vals.push(data.readFloatLE(i * 4).toFixed(2));
        }
        return `(${vals.join(', ')})`;
    }
    return hexDump(data);
}

function decodeVector(data: Buffer, type: string): string {
    if (data.length < 4) { return hexDump(data); }

    const innerType = extractInnerType(type);
    const count = data.readInt32LE(0);
    if (count < 0 || count > 10000) { return `[count=${count}] ${hexDump(data)}`; }
    if (count === 0) { return '[] (empty)'; }

    // For DeltaVector, there's an update counter at the end
    const elements: string[] = [];
    let offset = 4;

    for (let i = 0; i < count && i < 20; i++) {
        const result = decodeElementAt(data, offset, innerType);
        if (!result) { break; }
        elements.push(result.value);
        offset = result.nextOffset;
    }

    const suffix = count > 20 ? `, ... (${count} total)` : '';
    return `[${elements.join(', ')}${suffix}]`;
}

function decodeVectorMap(data: Buffer, type: string): string {
    if (data.length < 8) { return hexDump(data); }

    const count = data.readInt32LE(0);
    const capacity = data.readInt32LE(4);
    if (count < 0 || count > 10000) { return `{count=${count}, cap=${capacity}} ${hexDump(data)}`; }
    if (count === 0) { return '{} (empty)'; }

    return `{${count} entries, cap=${capacity}} ${hexDump(data.subarray(0, Math.min(64, data.length)))}`;
}

interface ElementResult {
    value: string;
    nextOffset: number;
}

function decodeElementAt(data: Buffer, offset: number, type: string): ElementResult | null {
    if (offset >= data.length) { return null; }

    if (type === 'int' && offset + 4 <= data.length) {
        return { value: data.readInt32LE(offset).toString(), nextOffset: offset + 4 };
    }
    if ((type === 'unsigned int' || type === 'uint32') && offset + 4 <= data.length) {
        return { value: data.readUInt32LE(offset).toString(), nextOffset: offset + 4 };
    }
    if (type === 'float' && offset + 4 <= data.length) {
        return { value: data.readFloatLE(offset).toFixed(2), nextOffset: offset + 4 };
    }
    if ((type === 'unsigned long long' || type.startsWith('ManagedReference<') ||
         type.startsWith('ManagedWeakReference<')) && offset + 8 <= data.length) {
        const val = data.readBigUInt64LE(offset);
        return { value: val === 0n ? 'null' : '0x' + val.toString(16).toUpperCase(), nextOffset: offset + 8 };
    }
    if (type === 'String' && offset + 2 <= data.length) {
        const len = data.readUInt16LE(offset);
        const end = offset + 2 + len;
        if (end <= data.length) {
            return { value: '"' + data.toString('utf8', offset + 2, end) + '"', nextOffset: end };
        }
    }
    if (type === 'bool' && offset + 1 <= data.length) {
        return { value: data[offset] !== 0 ? 'true' : 'false', nextOffset: offset + 1 };
    }

    return null;
}

function extractInnerType(type: string): string {
    // Extract T from Vector<T>, DeltaVector<T>, SortedVector<T>, etc.
    const match = type.match(/<(.+?)(?:\s*>\s*>|>)$/);
    if (match) {
        let inner = match[1].trim();
        // Remove trailing space before >
        if (inner.endsWith(' ')) { inner = inner.trimEnd(); }
        return inner;
    }
    return '?';
}

function hexDump(data: Buffer): string {
    const maxBytes = 64;
    const hex = data.subarray(0, Math.min(maxBytes, data.length))
        .toString('hex').toUpperCase()
        .replace(/(.{2})/g, '$1 ').trim();
    const suffix = data.length > maxBytes ? ` ... (${data.length} bytes)` : ` (${data.length} bytes)`;
    return hex + suffix;
}
