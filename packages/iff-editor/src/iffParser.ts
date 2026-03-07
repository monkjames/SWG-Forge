/**
 * IFF (Interchange File Format) Parser for SWG
 *
 * IFF files use a hierarchical chunk-based format:
 * - FORM = container with 4-byte tag + 4-byte size (big-endian) + 4-byte form name
 * - CHUNK = data block with 4-byte tag + 4-byte size (big-endian) + variable data
 */

export interface IFFNode {
    type: 'form' | 'chunk';
    tag: string;           // 4-char tag (e.g., "FORM", "XXXX", "PCNT")
    formName?: string;     // For forms: the form name (e.g., "STOT", "DERV", "0007")
    data?: Uint8Array;     // For chunks: raw data
    children?: IFFNode[];  // For forms: nested nodes
    offset: number;        // Original position in file (for debugging)
    size: number;          // Original size
}

export interface IFFProperty {
    name: string;
    type: 'string' | 'stf_reference' | 'bool' | 'int32' | 'float' | 'raw';
    value: any;
    rawData: Uint8Array;   // Original bytes for reconstruction
}

export interface IFFDocument {
    root: IFFNode;
    properties: Map<string, IFFProperty>;
    derivation: string;    // Base template path from DERV
}

/**
 * Parse an IFF file into a tree structure
 */
export function parseIFF(data: Uint8Array): IFFDocument {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;
    const dataLength = data.length;

    function readTag(): string {
        if (pos + 4 > dataLength) {
            return '????';
        }
        const chars = [
            String.fromCharCode(data[pos]),
            String.fromCharCode(data[pos + 1]),
            String.fromCharCode(data[pos + 2]),
            String.fromCharCode(data[pos + 3])
        ];
        pos += 4;
        return chars.join('');
    }

    function readSize(): number {
        if (pos + 4 > dataLength) {
            return 0;
        }
        // Sizes are big-endian in IFF
        const size = view.getUint32(pos, false);
        pos += 4;
        return size;
    }

    function parseNode(endPos: number): IFFNode | null {
        // Need at least 8 bytes for a valid chunk/form header
        if (pos + 8 > endPos) return null;

        const offset = pos;
        const tag = readTag();
        const size = readSize();

        // Validate tag - should be 4 printable ASCII chars
        const validTag = /^[A-Za-z0-9 ]{4}$/.test(tag);
        if (!validTag) {
            // Invalid tag - likely misaligned, try to recover
            console.warn(`Invalid tag "${tag}" at offset ${offset}`);
            return null;
        }

        // Validate size - shouldn't exceed remaining data
        const maxSize = data.length - pos;
        if (size > maxSize) {
            console.warn(`Size ${size} exceeds remaining data ${maxSize} at offset ${offset}`);
            return null;
        }

        if (tag === 'FORM') {
            const formName = readTag();
            const children: IFFNode[] = [];
            const formEnd = pos + size - 4; // -4 because formName is included in size

            while (pos < formEnd) {
                const child = parseNode(formEnd);
                if (child) {
                    children.push(child);
                } else {
                    // Failed to parse child - skip to end of form
                    break;
                }
            }

            // Ensure we're at the form end (in case we broke early)
            pos = formEnd;

            return {
                type: 'form',
                tag,
                formName,
                children,
                offset,
                size
            };
        } else {
            // Regular chunk
            const chunkData = data.slice(pos, pos + size);
            pos += size;

            // Note: Standard IFF adds padding for odd-sized chunks, but SWG IFF files
            // do NOT use padding - chunks are packed without alignment bytes

            return {
                type: 'chunk',
                tag,
                data: chunkData,
                offset,
                size
            };
        }
    }

    const root = parseNode(data.length);
    if (!root) {
        throw new Error('Failed to parse IFF file');
    }

    // Extract properties from the tree
    const properties = extractProperties(root);
    const derivation = extractDerivation(root);

    return { root, properties, derivation };
}

/**
 * Find the SHOT form and extract properties from XXXX chunks
 */
function extractProperties(root: IFFNode): Map<string, IFFProperty> {
    const properties = new Map<string, IFFProperty>();

    function findForm(node: IFFNode, formName: string): IFFNode | null {
        if (node.type === 'form' && node.formName === formName) {
            return node;
        }
        if (node.children) {
            for (const child of node.children) {
                const found = findForm(child, formName);
                if (found) return found;
            }
        }
        return null;
    }

    // Find SHOT form (Shared Object Template) - contains the main properties
    const shotForm = findForm(root, 'SHOT');
    if (!shotForm || !shotForm.children) return properties;

    // Find the versioned form (0007, 0006, etc.) inside SHOT
    for (const child of shotForm.children) {
        if (child.type === 'form' && child.formName && /^\d{4}$/.test(child.formName)) {
            extractPropertiesFromForm(child, properties);
        }
    }

    // Also look at top-level versioned forms (outside SHOT)
    if (root.children) {
        for (const child of root.children) {
            if (child.type === 'form' && child.formName && /^\d{4}$/.test(child.formName)) {
                extractPropertiesFromForm(child, properties);
            }
        }
    }

    return properties;
}

function extractPropertiesFromForm(form: IFFNode, properties: Map<string, IFFProperty>): void {
    if (!form.children) return;

    for (const chunk of form.children) {
        if (chunk.type === 'chunk' && chunk.tag === 'XXXX' && chunk.data) {
            const prop = parsePropertyChunk(chunk.data);
            if (prop) {
                properties.set(prop.name, prop);
            }
        }
    }
}

/**
 * Parse a single XXXX chunk into a property
 */
function parsePropertyChunk(data: Uint8Array): IFFProperty | null {
    if (data.length === 0) return null;

    // Find null terminator for property name
    let nameEnd = 0;
    while (nameEnd < data.length && data[nameEnd] !== 0) {
        nameEnd++;
    }

    if (nameEnd === 0 || nameEnd >= data.length) return null;

    const name = decodeASCII(data.slice(0, nameEnd));
    const valueData = data.slice(nameEnd + 1); // Skip null terminator

    // Parse the value based on markers
    const parsed = parsePropertyValue(valueData);

    return {
        name,
        type: parsed.type,
        value: parsed.value,
        rawData: data
    };
}

interface ParsedValue {
    type: 'string' | 'stf_reference' | 'bool' | 'int32' | 'float' | 'raw';
    value: any;
}

function parsePropertyValue(data: Uint8Array): ParsedValue {
    if (data.length === 0) {
        return { type: 'bool', value: false };
    }

    const marker = data[0];

    // Empty/false value - only treat as bool if exactly 1 byte
    // If there's trailing data (e.g., \x00\x20), preserve as raw to avoid data loss
    if (marker === 0x00) {
        if (data.length === 1) {
            return { type: 'bool', value: false };
        }
        // Has trailing data - preserve as raw
        return { type: 'raw', value: data };
    }

    // Value follows
    if (marker === 0x01) {
        if (data.length < 2) {
            return { type: 'raw', value: data };
        }

        const secondMarker = data[1];

        // STF reference: \x01\x01file\x00\x01key\x00
        if (secondMarker === 0x01) {
            return parseSTFReference(data.slice(2));
        }

        // Simple string: \x01string\x00
        // Or boolean true: \x01\x01
        if (secondMarker === 0x01 && data.length === 2) {
            return { type: 'bool', value: true };
        }

        // Value with type marker (0x20 = space indicates numeric/flag)
        if (secondMarker === 0x20) {
            // Numeric value follows
            if (data.length >= 6) {
                const view = new DataView(data.buffer, data.byteOffset + 2, 4);
                return { type: 'int32', value: view.getInt32(0, true) };
            }
            return { type: 'raw', value: data };
        }

        // Simple string value
        const strEnd = findNull(data, 1);
        if (strEnd > 1) {
            const str = decodeASCII(data.slice(1, strEnd));
            return { type: 'string', value: str };
        }
    }

    return { type: 'raw', value: data };
}

function parseSTFReference(data: Uint8Array): ParsedValue {
    // Format: file\x00\x01key\x00 or file\x00\x01key\x00
    const fileEnd = findNull(data, 0);
    if (fileEnd < 0) {
        return { type: 'raw', value: data };
    }

    const file = decodeASCII(data.slice(0, fileEnd));

    // Check for key marker
    const keyStart = fileEnd + 2; // Skip null + \x01
    if (keyStart < data.length) {
        const keyEnd = findNull(data, keyStart);
        const key = keyEnd > keyStart ? decodeASCII(data.slice(keyStart, keyEnd)) : '';
        return {
            type: 'stf_reference',
            value: { file, key }
        };
    }

    return {
        type: 'stf_reference',
        value: { file, key: '' }
    };
}

function findNull(data: Uint8Array, start: number): number {
    for (let i = start; i < data.length; i++) {
        if (data[i] === 0) return i;
    }
    return -1;
}

/**
 * Extract derivation path from DERV form
 */
function extractDerivation(root: IFFNode): string {
    function findDerivation(node: IFFNode): string | null {
        if (node.type === 'form' && node.formName === 'DERV' && node.children) {
            for (const child of node.children) {
                if (child.type === 'chunk' && child.tag === 'XXXX' && child.data) {
                    const strEnd = findNull(child.data, 0);
                    return decodeASCII(child.data.slice(0, strEnd > 0 ? strEnd : child.data.length));
                }
            }
        }
        if (node.children) {
            for (const child of node.children) {
                const found = findDerivation(child);
                if (found) return found;
            }
        }
        return null;
    }

    return findDerivation(root) || '';
}

/**
 * Serialize an IFF document back to binary
 */
export function serializeIFF(doc: IFFDocument): Uint8Array {
    // Serialize the tree directly - chunk data is already updated in place
    // Note: updatePropertiesInTree was removed because we now edit chunk data directly
    return serializeNode(doc.root);
}

function updatePropertiesInTree(node: IFFNode, properties: Map<string, IFFProperty>): void {
    if (node.type === 'chunk' && node.tag === 'XXXX' && node.data) {
        // Parse the property name from this chunk
        const nameEnd = findNull(node.data, 0);
        if (nameEnd > 0) {
            const name = decodeASCII(node.data.slice(0, nameEnd));
            const prop = properties.get(name);
            if (prop) {
                // Rebuild the chunk data from the property
                node.data = serializeProperty(prop);
            }
        }
    }

    if (node.children) {
        for (const child of node.children) {
            updatePropertiesInTree(child, properties);
        }
    }
}

export function serializeProperty(prop: IFFProperty): Uint8Array {
    const nameBytes = encodeASCII(prop.name);

    let valueBytes: Uint8Array;

    switch (prop.type) {
        case 'stf_reference': {
            const { file, key } = prop.value;
            // \x01\x01file\x00\x01key\x00
            const fileBytes = encodeASCII(file);
            const keyBytes = encodeASCII(key);
            valueBytes = new Uint8Array(2 + fileBytes.length + 1 + 1 + keyBytes.length + 1);
            valueBytes[0] = 0x01;
            valueBytes[1] = 0x01;
            valueBytes.set(fileBytes, 2);
            valueBytes[2 + fileBytes.length] = 0x00;
            valueBytes[2 + fileBytes.length + 1] = 0x01;
            valueBytes.set(keyBytes, 2 + fileBytes.length + 2);
            valueBytes[valueBytes.length - 1] = 0x00;
            break;
        }
        case 'string': {
            const strBytes = encodeASCII(prop.value);
            valueBytes = new Uint8Array(1 + strBytes.length + 1);
            valueBytes[0] = 0x01;
            valueBytes.set(strBytes, 1);
            valueBytes[valueBytes.length - 1] = 0x00;
            break;
        }
        case 'bool': {
            valueBytes = new Uint8Array(prop.value ? [0x01, 0x01] : [0x00]);
            break;
        }
        case 'int32': {
            valueBytes = new Uint8Array(6);
            valueBytes[0] = 0x01;
            valueBytes[1] = 0x20;
            const view = new DataView(valueBytes.buffer, 2, 4);
            view.setInt32(0, prop.value, true);
            break;
        }
        case 'float': {
            valueBytes = new Uint8Array(6);
            valueBytes[0] = 0x01;
            valueBytes[1] = 0x20;
            const view = new DataView(valueBytes.buffer, 2, 4);
            view.setFloat32(0, prop.value, true);
            break;
        }
        default: {
            // Raw data - use original
            return prop.rawData;
        }
    }

    // Combine name + null + value
    const result = new Uint8Array(nameBytes.length + 1 + valueBytes.length);
    result.set(nameBytes, 0);
    result[nameBytes.length] = 0x00;
    result.set(valueBytes, nameBytes.length + 1);

    return result;
}

function serializeNode(node: IFFNode): Uint8Array {
    if (node.type === 'chunk') {
        const data = node.data || new Uint8Array(0);
        // SWG IFF files do NOT use padding for odd-sized chunks
        const result = new Uint8Array(8 + data.length);
        const view = new DataView(result.buffer);

        // Tag (4 bytes ASCII)
        for (let i = 0; i < 4; i++) {
            result[i] = node.tag.charCodeAt(i);
        }

        // Size (4 bytes big-endian)
        view.setUint32(4, data.length, false);

        // Data
        result.set(data, 8);

        return result;
    } else {
        // FORM
        const childBuffers: Uint8Array[] = [];
        if (node.children) {
            for (const child of node.children) {
                childBuffers.push(serializeNode(child));
            }
        }

        const childrenSize = childBuffers.reduce((sum, buf) => sum + buf.length, 0);
        const formNameBytes = encodeASCII(node.formName || '????');
        const totalSize = 4 + childrenSize; // formName + children

        const result = new Uint8Array(8 + totalSize);
        const view = new DataView(result.buffer);

        // "FORM" tag
        result[0] = 0x46; result[1] = 0x4F; result[2] = 0x52; result[3] = 0x4D;

        // Size (big-endian)
        view.setUint32(4, totalSize, false);

        // Form name
        result.set(formNameBytes, 8);

        // Children
        let offset = 12;
        for (const childBuf of childBuffers) {
            result.set(childBuf, offset);
            offset += childBuf.length;
        }

        return result;
    }
}

// Helper functions
function decodeASCII(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) break;
        result += String.fromCharCode(bytes[i]);
    }
    return result;
}

function encodeASCII(str: string): Uint8Array {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i);
    }
    return bytes;
}

/**
 * Get a simplified tree structure for display
 */
export function getTreeStructure(node: IFFNode, depth: number = 0): string[] {
    const lines: string[] = [];
    const indent = '  '.repeat(depth);

    if (node.type === 'form') {
        lines.push(`${indent}FORM ${node.formName} (${node.size} bytes)`);
        if (node.children) {
            for (const child of node.children) {
                lines.push(...getTreeStructure(child, depth + 1));
            }
        }
    } else {
        const preview = node.data ? getDataPreview(node.data) : '';
        lines.push(`${indent}${node.tag} (${node.size} bytes)${preview ? ': ' + preview : ''}`);
    }

    return lines;
}

function getDataPreview(data: Uint8Array, maxLen: number = 40): string {
    // Try to show as string if it looks like ASCII
    let str = '';
    for (let i = 0; i < Math.min(data.length, maxLen); i++) {
        const byte = data[i];
        if (byte >= 32 && byte < 127) {
            str += String.fromCharCode(byte);
        } else if (byte === 0) {
            str += '\\0';
        } else {
            str += '.';
        }
    }
    if (data.length > maxLen) str += '...';
    return str;
}
