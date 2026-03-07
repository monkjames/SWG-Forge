/**
 * IFF (Interchange File Format) Parser/Serializer for SWG
 * Adapted from vscode-iff-editor/src/iffParser.ts
 *
 * IFF files use a hierarchical chunk-based format:
 * - FORM = container with 4-byte tag + 4-byte size (big-endian) + 4-byte form name
 * - CHUNK = data block with 4-byte tag + 4-byte size (big-endian) + variable data
 */

export interface IFFNode {
    type: 'form' | 'chunk';
    tag: string;
    formName?: string;
    data?: Uint8Array;
    children?: IFFNode[];
    offset: number;
    size: number;
}

/**
 * Parse an IFF file into a tree structure
 */
export function parseIFF(data: Uint8Array): IFFNode {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;
    const dataLength = data.length;

    function readTag(): string {
        if (pos + 4 > dataLength) return '????';
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
        if (pos + 4 > dataLength) return 0;
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
        if (!validTag) return null;

        const maxSize = data.length - pos;
        if (size > maxSize) return null;

        if (tag === 'FORM') {
            const formName = readTag();
            const children: IFFNode[] = [];
            const formEnd = pos + size - 4;

            while (pos < formEnd) {
                const child = parseNode(formEnd);
                if (child) {
                    children.push(child);
                } else {
                    break;
                }
            }
            pos = formEnd;

            return { type: 'form', tag, formName, children, offset, size };
        } else {
            const chunkData = data.slice(pos, pos + size);
            pos += size;
            return { type: 'chunk', tag, data: chunkData, offset, size };
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
export function serializeIFF(node: IFFNode): Uint8Array {
    return serializeNode(node);
}

function serializeNode(node: IFFNode): Uint8Array {
    if (node.type === 'chunk') {
        const data = node.data || new Uint8Array(0);
        const result = new Uint8Array(8 + data.length);
        const view = new DataView(result.buffer);

        writeTag(result, 0, node.tag);
        view.setUint32(4, data.length, false); // big-endian
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
        const totalSize = 4 + childrenSize; // formName + children

        const result = new Uint8Array(8 + totalSize);
        const view = new DataView(result.buffer);

        writeTag(result, 0, 'FORM');
        view.setUint32(4, totalSize, false); // big-endian
        writeTag(result, 8, node.formName || '????');

        let offset = 12;
        for (const childBuf of childBuffers) {
            result.set(childBuf, offset);
            offset += childBuf.length;
        }

        return result;
    }
}

/** Find a child FORM by name within a node */
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

/** Find a child chunk by tag within a node's direct children */
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

/** Read a null-terminated string from a Uint8Array at a given position */
export function readNullString(data: Uint8Array, pos: number): string {
    let end = pos;
    while (end < data.length && data[end] !== 0) {
        end++;
    }
    let result = '';
    for (let i = pos; i < end; i++) {
        result += String.fromCharCode(data[i]);
    }
    return result;
}

/** Encode a string to ASCII Uint8Array */
export function encodeASCII(str: string): Uint8Array {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i);
    }
    return bytes;
}

/** Write a 4-char tag into a Uint8Array */
export function writeTag(arr: Uint8Array, pos: number, tag: string): void {
    for (let i = 0; i < 4; i++) {
        arr[pos + i] = tag.charCodeAt(i);
    }
}

/**
 * Extract a string property value from a SHOT/XXXX chunk.
 * XXXX chunks store: name\0\x01value\0
 */
export function extractStringProperty(node: IFFNode, propertyName: string): string | null {
    const shotForm = findForm(node, 'SHOT');
    if (!shotForm?.children) return null;

    for (const child of shotForm.children) {
        if (child.type === 'form' && child.formName && /^\d{4}$/.test(child.formName)) {
            if (child.children) {
                for (const chunk of child.children) {
                    if (chunk.type === 'chunk' && chunk.tag === 'XXXX' && chunk.data) {
                        const nameEnd = chunk.data.indexOf(0);
                        if (nameEnd > 0) {
                            let name = '';
                            for (let i = 0; i < nameEnd; i++) {
                                name += String.fromCharCode(chunk.data[i]);
                            }
                            if (name === propertyName && chunk.data[nameEnd + 1] === 0x01) {
                                return readNullString(chunk.data, nameEnd + 2);
                            }
                        }
                    }
                }
            }
        }
    }
    return null;
}

/**
 * Update a string property in a SHOT/XXXX chunk.
 * Returns true if the property was found and updated.
 */
export function updateStringProperty(node: IFFNode, propertyName: string, newValue: string): boolean {
    const shotForm = findForm(node, 'SHOT');
    if (!shotForm?.children) return false;

    for (const child of shotForm.children) {
        if (child.type === 'form' && child.formName && /^\d{4}$/.test(child.formName)) {
            if (child.children) {
                for (const chunk of child.children) {
                    if (chunk.type === 'chunk' && chunk.tag === 'XXXX' && chunk.data) {
                        const nameEnd = chunk.data.indexOf(0);
                        if (nameEnd > 0) {
                            let name = '';
                            for (let i = 0; i < nameEnd; i++) {
                                name += String.fromCharCode(chunk.data[i]);
                            }
                            if (name === propertyName) {
                                // Rebuild: name\0\x01newValue\0
                                const nameBytes = encodeASCII(propertyName);
                                const valueBytes = encodeASCII(newValue);
                                const newData = new Uint8Array(nameBytes.length + 1 + 1 + valueBytes.length + 1);
                                newData.set(nameBytes, 0);
                                newData[nameBytes.length] = 0x00;
                                newData[nameBytes.length + 1] = 0x01;
                                newData.set(valueBytes, nameBytes.length + 2);
                                newData[newData.length - 1] = 0x00;
                                chunk.data = newData;
                                chunk.size = newData.length;
                                return true;
                            }
                        }
                    }
                }
            }
        }
    }
    return false;
}

/**
 * Extract the derivation path from a DERV form
 */
export function extractDerivation(node: IFFNode): string {
    const dervForm = findForm(node, 'DERV');
    if (!dervForm?.children) return '';

    for (const child of dervForm.children) {
        if (child.type === 'chunk' && child.tag === 'XXXX' && child.data) {
            return readNullString(child.data, 0);
        }
    }
    return '';
}
