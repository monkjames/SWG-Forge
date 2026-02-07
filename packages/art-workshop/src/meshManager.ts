/**
 * Mesh Manager - handles template MSH files for different art types.
 *
 * Strategy: copy a vanilla MSH that matches the desired shape/size,
 * then binary-patch the shader reference to point to our new SHT.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ArtTypeConfig } from './types';

const TRE_SEARCH_ORDER = ['working', 'vanilla', 'infinity'] as const;

/**
 * Resolve a TRE-relative path to an absolute file path.
 */
function resolveTrePath(workspaceRoot: string, relativePath: string): string | null {
    for (const dir of TRE_SEARCH_ORDER) {
        const fullPath = path.join(workspaceRoot, 'tre', dir, relativePath);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }
    return null;
}

/**
 * Find the template MSH file for an art type in the vanilla TRE.
 */
export function findTemplateMesh(workspaceRoot: string, config: ArtTypeConfig): string | null {
    // Try exact mesh path
    const meshPath = `appearance/mesh/${config.templateMesh}.msh`;
    const found = resolveTrePath(workspaceRoot, meshPath);
    if (found) return found;

    // Try with LOD suffix
    const meshPathL0 = `appearance/mesh/${config.templateMesh}_l0.msh`;
    return resolveTrePath(workspaceRoot, meshPathL0);
}

/**
 * Find the template APT file for an art type in the vanilla TRE.
 */
export function findTemplateAPT(workspaceRoot: string, config: ArtTypeConfig): string | null {
    const aptPath = `appearance/${config.templateMesh}.apt`;
    return resolveTrePath(workspaceRoot, aptPath);
}

/**
 * Find animated template files (SAT, MGN, CDF) for banners.
 */
export function findAnimatedTemplates(workspaceRoot: string, config: ArtTypeConfig): {
    sat: string | null;
    mgn: string | null;
    cdf: string | null;
} {
    const baseName = config.templateMesh; // e.g., "banner1"
    return {
        sat: resolveTrePath(workspaceRoot, `appearance/${baseName}.sat`),
        mgn: resolveTrePath(workspaceRoot, `appearance/mesh/${baseName}.mgn`),
        cdf: resolveTrePath(workspaceRoot, `appearance/${baseName}.cdf`),
    };
}

/**
 * Copy a template MSH and patch its shader reference.
 *
 * MSH files contain shader paths as null-terminated ASCII strings inside NAME chunks.
 * We find the first shader path (the painting/rug texture shader, not the frame shader)
 * and replace it with our new shader path.
 *
 * Returns the patched MSH bytes.
 */
export function copyAndPatchMesh(templateMshPath: string, newShaderPath: string): Uint8Array {
    const original = Buffer.from(fs.readFileSync(templateMshPath));

    // Find shader references in the MSH
    // They appear as: NAME chunk → "shader/some_name.sht\0"
    const shaderRefs = findShaderReferences(original);

    if (shaderRefs.length === 0) {
        // No shader refs found - just return a copy
        return new Uint8Array(original);
    }

    // Patch the first shader reference (the main texture shader)
    // The second one (if present) is typically the frame shader - leave it
    const ref = shaderRefs[0];
    return patchStringInBuffer(original, ref.offset, ref.length, newShaderPath);
}

/**
 * Copy a template file (SAT, MGN, CDF) and patch shader references.
 */
export function copyAndPatchAnimated(templatePath: string, newShaderPath: string): Uint8Array {
    const original = Buffer.from(fs.readFileSync(templatePath));

    const shaderRefs = findShaderReferences(original);
    if (shaderRefs.length === 0) {
        return new Uint8Array(original);
    }

    // Patch the first shader reference
    return patchStringInBuffer(original, shaderRefs[0].offset, shaderRefs[0].length, newShaderPath);
}

interface StringRef {
    offset: number;  // byte offset of the string start (after NAME + size)
    length: number;  // length including null terminator
    value: string;
}

/**
 * Scan a buffer for NAME chunks containing shader paths.
 * Looks for pattern: NAME(4) + size(4, BE) + "shader/...sht\0"
 */
function findShaderReferences(buf: Buffer): StringRef[] {
    const refs: StringRef[] = [];

    for (let i = 0; i < buf.length - 12; i++) {
        // Look for "NAME" tag
        if (buf[i] === 0x4E && buf[i + 1] === 0x41 && buf[i + 2] === 0x4D && buf[i + 3] === 0x45) {
            // Read size (big-endian)
            const size = buf.readUInt32BE(i + 4);
            if (size > 0 && size < 256 && i + 8 + size <= buf.length) {
                // Read string
                let str = '';
                const strStart = i + 8;
                for (let j = 0; j < size && buf[strStart + j] !== 0; j++) {
                    str += String.fromCharCode(buf[strStart + j]);
                }

                if (str.startsWith('shader/') && str.endsWith('.sht')) {
                    refs.push({
                        offset: strStart,
                        length: size,
                        value: str,
                    });
                }
            }
        }
    }

    return refs;
}

/**
 * Replace a string in a buffer, adjusting the NAME chunk size if needed.
 * The new string must be null-terminated within the chunk.
 */
function patchStringInBuffer(original: Buffer, stringOffset: number, oldSize: number, newStr: string): Uint8Array {
    const newStrBytes = Buffer.from(newStr + '\0', 'ascii');
    const newSize = newStrBytes.length;

    if (newSize === oldSize) {
        // Same size - in-place replace
        const result = Buffer.from(original);
        newStrBytes.copy(result, stringOffset);
        return new Uint8Array(result);
    }

    // Different size - need to rebuild buffer with adjusted size
    const sizeDiff = newSize - oldSize;
    const result = Buffer.alloc(original.length + sizeDiff);

    // Copy before string
    original.copy(result, 0, 0, stringOffset);

    // Write new string
    newStrBytes.copy(result, stringOffset);

    // Copy after old string
    original.copy(result, stringOffset + newSize, stringOffset + oldSize);

    // Update the NAME chunk size (4 bytes before string, big-endian)
    result.writeUInt32BE(newSize, stringOffset - 4);

    // Walk up the IFF tree and update all parent FORM sizes
    updateParentFormSizes(result, sizeDiff);

    return new Uint8Array(result);
}

/**
 * After changing a chunk size, walk through the IFF and recalculate all FORM sizes.
 * Simple approach: re-parse and re-serialize would be cleaner but this is faster
 * for the common case of a single size change.
 *
 * We use a simpler approach: adjust only the outermost FORM size and the
 * immediate parent FORM sizes by the size difference.
 */
function updateParentFormSizes(buf: Buffer, sizeDiff: number): void {
    // Update the outermost FORM size (at offset 4)
    if (buf.length >= 8 && buf[0] === 0x46 && buf[1] === 0x4F && buf[2] === 0x52 && buf[3] === 0x4D) {
        const currentSize = buf.readUInt32BE(4);
        buf.writeUInt32BE(currentSize + sizeDiff, 4);
    }

    // For nested FORMs, we need to find and update each parent.
    // A simpler strategy: just recalculate all FORM sizes from the leaf up.
    // Since these are small files (~2KB), we can re-parse and re-serialize.
    // But for the MVP, the outer FORM size adjustment is usually sufficient
    // since SWG is tolerant of slight size mismatches in inner FORMs.

    // For correctness, walk through and update inner FORM sizes too
    recalcFormSizes(buf, 0);
}

/**
 * Recursively recalculate FORM sizes in a buffer.
 * Returns the total bytes consumed at this level.
 */
function recalcFormSizes(buf: Buffer, pos: number): number {
    if (pos + 8 > buf.length) return 0;

    const tag = buf.toString('ascii', pos, pos + 4);

    if (tag === 'FORM') {
        const formNameEnd = pos + 12;
        let childPos = formNameEnd;
        let childrenSize = 0;

        // Walk children
        while (childPos < buf.length - 8) {
            const childTag = buf.toString('ascii', childPos, childPos + 4);
            if (!/^[A-Za-z0-9 _]{4}$/.test(childTag)) break;

            const childSize = buf.readUInt32BE(childPos + 4);
            if (childTag === 'FORM') {
                const consumed = recalcFormSizes(buf, childPos);
                if (consumed === 0) break;
                childrenSize += consumed;
                childPos += consumed;
            } else {
                // Chunk: tag + size + data
                const chunkTotal = 8 + childSize;
                childrenSize += chunkTotal;
                childPos += chunkTotal;
            }
        }

        // Update this FORM's size: formName(4) + children
        const newFormSize = 4 + childrenSize;
        buf.writeUInt32BE(newFormSize, pos + 4);

        return 8 + newFormSize; // FORM tag + size + content
    }

    // Not a FORM - skip
    const size = buf.readUInt32BE(pos + 4);
    return 8 + size;
}
