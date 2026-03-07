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

/**
 * Parse an IFF binary into a tree structure
 */
export function parseIFF(data: Uint8Array): IFFNode {
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
                    break;
                }
            }

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

    return root;
}

/**
 * Serialize an IFF tree back to binary
 */
export function serializeIFF(root: IFFNode): Uint8Array {
    return serializeNode(root);
}

function serializeNode(node: IFFNode): Uint8Array {
    if (node.type === 'chunk') {
        const data = node.data || new Uint8Array(0);
        const result = new Uint8Array(8 + data.length);
        const view = new DataView(result.buffer);

        for (let i = 0; i < 4; i++) {
            result[i] = node.tag.charCodeAt(i);
        }

        view.setUint32(4, data.length, false);
        result.set(data, 8);

        return result;
    } else {
        const childBuffers: Uint8Array[] = [];
        if (node.children) {
            for (const child of node.children) {
                childBuffers.push(serializeNode(child));
            }
        }

        const childrenSize = childBuffers.reduce((sum, buf) => sum + buf.length, 0);
        const formNameBytes = encodeASCII(node.formName || '????');
        const totalSize = 4 + childrenSize;

        const result = new Uint8Array(8 + totalSize);
        const view = new DataView(result.buffer);

        // "FORM" tag
        result[0] = 0x46; result[1] = 0x4F; result[2] = 0x52; result[3] = 0x4D;

        view.setUint32(4, totalSize, false);
        result.set(formNameBytes, 8);

        let offset = 12;
        for (const childBuf of childBuffers) {
            result.set(childBuf, offset);
            offset += childBuf.length;
        }

        return result;
    }
}

/**
 * Find a FORM node by name (depth-first search)
 */
export function findForm(node: IFFNode, formName: string): IFFNode | null {
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

/**
 * Find a chunk by tag within a node's direct children
 */
export function findChunk(node: IFFNode, tag: string): IFFNode | null {
    if (node.children) {
        for (const child of node.children) {
            if (child.type === 'chunk' && child.tag === tag) {
                return child;
            }
        }
    }
    return null;
}

/**
 * Read a null-terminated string from a Uint8Array
 */
export function readNullString(data: Uint8Array, offset: number = 0): string {
    let end = offset;
    while (end < data.length && data[end] !== 0) {
        end++;
    }
    return decodeASCII(data.slice(offset, end));
}

/**
 * Extract the derivation path from a DERV form
 */
export function extractDerivation(root: IFFNode): string {
    function findDerivation(node: IFFNode): string | null {
        if (node.type === 'form' && node.formName === 'DERV' && node.children) {
            for (const child of node.children) {
                if (child.type === 'chunk' && child.tag === 'XXXX' && child.data) {
                    return readNullString(child.data);
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
 * Extract an STF string reference from binary data: \x01\x01file\x00\x01key\x00
 */
export function extractStringProperty(data: Uint8Array, offset: number): { file: string; key: string } | null {
    if (offset + 2 >= data.length) return null;
    if (data[offset] !== 0x01 || data[offset + 1] !== 0x01) return null;

    let pos = offset + 2;
    const fileEnd = findNull(data, pos);
    if (fileEnd < 0) return null;
    const file = decodeASCII(data.slice(pos, fileEnd));

    pos = fileEnd + 2; // skip null + \x01
    if (pos >= data.length) return { file, key: '' };
    const keyEnd = findNull(data, pos);
    const key = keyEnd > pos ? decodeASCII(data.slice(pos, keyEnd)) : '';

    return { file, key };
}

/**
 * Update an STF string reference in binary data
 */
export function updateStringProperty(file: string, key: string): Uint8Array {
    const fileBytes = encodeASCII(file);
    const keyBytes = encodeASCII(key);
    const result = new Uint8Array(2 + fileBytes.length + 1 + 1 + keyBytes.length + 1);
    result[0] = 0x01;
    result[1] = 0x01;
    result.set(fileBytes, 2);
    result[2 + fileBytes.length] = 0x00;
    result[2 + fileBytes.length + 1] = 0x01;
    result.set(keyBytes, 2 + fileBytes.length + 2);
    result[result.length - 1] = 0x00;
    return result;
}

/**
 * Write a 4-character tag into a Uint8Array
 */
export function writeTag(arr: Uint8Array, pos: number, tag: string): void {
    for (let i = 0; i < 4; i++) {
        arr[pos + i] = tag.charCodeAt(i);
    }
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

// --- Internal helpers ---

function findNull(data: Uint8Array, start: number): number {
    for (let i = start; i < data.length; i++) {
        if (data[i] === 0) return i;
    }
    return -1;
}

export function decodeASCII(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) break;
        result += String.fromCharCode(bytes[i]);
    }
    return result;
}

export function encodeASCII(str: string): Uint8Array {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i);
    }
    return bytes;
}

function getDataPreview(data: Uint8Array, maxLen: number = 40): string {
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
