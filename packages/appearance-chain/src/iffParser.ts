/**
 * IFF (Interchange File Format) Parser for SWG
 *
 * Adapted from vscode-iff-editor. Parse and serialize functions for appearance chain editing.
 *
 * IFF files use a hierarchical chunk-based format:
 * - FORM = container with 4-byte tag + 4-byte size (big-endian) + 4-byte form name
 * - CHUNK = data block with 4-byte tag + 4-byte size (big-endian) + variable data
 */

import { IFFNodeJson } from './types';

export interface IFFNode {
    type: 'form' | 'chunk';
    tag: string;           // 4-char tag (e.g., "FORM", "XXXX", "NAME")
    formName?: string;     // For forms: the form name (e.g., "SMAT", "DTLA", "0007")
    data?: Uint8Array;     // For chunks: raw data
    children?: IFFNode[];  // For forms: nested nodes
    offset: number;        // Original position in file
    size: number;          // Original size
}

/**
 * Parse an IFF file into a tree structure
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
        const size = view.getUint32(pos, false); // big-endian
        pos += 4;
        return size;
    }

    function parseNode(endPos: number): IFFNode | null {
        if (pos + 8 > endPos) return null;

        const offset = pos;
        const tag = readTag();
        const size = readSize();

        const validTag = /^[A-Za-z0-9 _]{4}$/.test(tag);
        if (!validTag) {
            return null;
        }

        const maxSize = data.length - pos;
        if (size > maxSize) {
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
 * Extract a null-terminated ASCII string from a Uint8Array
 */
export function decodeASCII(bytes: Uint8Array, start: number = 0): string {
    let result = '';
    for (let i = start; i < bytes.length; i++) {
        if (bytes[i] === 0) break;
        result += String.fromCharCode(bytes[i]);
    }
    return result;
}

/**
 * Find the index of a null byte starting from a given position
 */
export function findNull(data: Uint8Array, start: number): number {
    for (let i = start; i < data.length; i++) {
        if (data[i] === 0) return i;
    }
    return -1;
}

/**
 * Find a FORM node by its formName anywhere in the tree (depth-first)
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
 * Find all FORM nodes by formName anywhere in the tree
 */
export function findAllForms(node: IFFNode, formName: string): IFFNode[] {
    const results: IFFNode[] = [];
    if (node.type === 'form' && node.formName === formName) {
        results.push(node);
    }
    if (node.children) {
        for (const child of node.children) {
            results.push(...findAllForms(child, formName));
        }
    }
    return results;
}

/**
 * Find all chunks with a given tag within a node's direct children
 */
export function findChunks(node: IFFNode, tag: string): IFFNode[] {
    if (!node.children) return [];
    return node.children.filter(c => c.type === 'chunk' && c.tag === tag);
}

/**
 * Find all chunks with a given tag at any depth
 */
export function findChunksDeep(node: IFFNode, tag: string): IFFNode[] {
    const results: IFFNode[] = [];
    if (node.type === 'chunk' && node.tag === tag) {
        results.push(node);
    }
    if (node.children) {
        for (const child of node.children) {
            results.push(...findChunksDeep(child, tag));
        }
    }
    return results;
}

/**
 * Encode a string to ASCII bytes (no null terminator)
 */
export function encodeASCII(str: string): Uint8Array {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i);
    }
    return bytes;
}

/**
 * Serialize an IFF tree back to binary.
 * SWG IFF files do NOT use padding for odd-sized chunks.
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
        view.setUint32(4, data.length, false); // big-endian size
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
        const totalSize = 4 + childrenSize; // formName + children
        const result = new Uint8Array(8 + totalSize);
        const view = new DataView(result.buffer);
        // "FORM" tag
        result[0] = 0x46; result[1] = 0x4F; result[2] = 0x52; result[3] = 0x4D;
        view.setUint32(4, totalSize, false); // big-endian size
        // Form name
        const fn = node.formName || '????';
        for (let i = 0; i < 4; i++) {
            result[8 + i] = fn.charCodeAt(i);
        }
        // Children
        let offset = 12;
        for (const childBuf of childBuffers) {
            result.set(childBuf, offset);
            offset += childBuf.length;
        }
        return result;
    }
}

/**
 * Update a chunk's data in the tree by matching its original offset.
 * Returns true if the chunk was found and updated.
 */
export function updateChunkData(node: IFFNode, targetOffset: number, newData: Uint8Array): boolean {
    if (node.type === 'chunk' && node.offset === targetOffset) {
        node.data = newData;
        node.size = newData.length;
        return true;
    }
    if (node.children) {
        for (const child of node.children) {
            if (updateChunkData(child, targetOffset, newData)) return true;
        }
    }
    return false;
}

/**
 * Convert an IFF tree to a JSON-safe structure for webview transport.
 * Small chunks (<= 256 bytes) include full data array.
 * Large chunks include only a hex preview and size.
 */
export function nodeToJson(node: IFFNode): IFFNodeJson {
    if (node.type === 'form') {
        return {
            type: 'form',
            tag: node.tag,
            formName: node.formName,
            offset: node.offset,
            size: node.size,
            children: (node.children || []).map(c => nodeToJson(c))
        };
    }

    const data = node.data || new Uint8Array(0);
    const result: IFFNodeJson = {
        type: 'chunk',
        tag: node.tag,
        offset: node.offset,
        size: node.size,
        fullSize: data.length
    };

    // Extract property name (first null-terminated ASCII string from chunk data)
    let propName = '';
    for (let i = 0; i < data.length && data[i] !== 0; i++) {
        if (data[i] >= 32 && data[i] < 127) {
            propName += String.fromCharCode(data[i]);
        }
    }
    if (propName.length > 0) {
        result.propertyName = propName;
    }

    // ASCII preview (first 80 chars, printable only)
    let preview = '';
    for (let i = 0; i < Math.min(data.length, 80); i++) {
        preview += (data[i] >= 32 && data[i] < 127) ? String.fromCharCode(data[i]) : '.';
    }
    result.preview = preview;

    if (data.length <= 256) {
        // Small chunk: include full data for inline editing
        result.dataArray = Array.from(data);
    } else {
        // Large chunk: hex preview only
        const hexBytes: string[] = [];
        for (let i = 0; i < Math.min(data.length, 64); i++) {
            hexBytes.push(data[i].toString(16).padStart(2, '0'));
        }
        result.hex = hexBytes.join(' ');
    }

    return result;
}
