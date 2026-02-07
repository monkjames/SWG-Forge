/**
 * Appearance Parser - Extract file references from each SWG appearance file type.
 *
 * Each parser returns an array of { path, label? } describing referenced files.
 */

import { IFFNode, parseIFF, decodeASCII, findNull, findForm, findAllForms, findChunks, findChunksDeep } from './iffParser';
import { FileType } from './types';

export interface ParsedReference {
    path: string;
    label?: string;
}

/**
 * Dispatch to the correct parser based on file type.
 * For MGN files, rawData is used for fallback binary scanning.
 */
export function parseAppearanceReferences(
    fileType: FileType,
    root: IFFNode,
    rawData: Uint8Array
): ParsedReference[] {
    switch (fileType) {
        case 'apt': return parseAPT(root);
        case 'sat': return parseSAT(root);
        case 'lod': return parseLOD(root, rawData);
        case 'lmg': return parseLMG(root);
        case 'msh': return parseMSH(root, rawData);
        case 'mgn': return parseMGN(root, rawData);
        case 'sht': return parseSHT(root, rawData);
        case 'object': return parseObjectIFF(root);
        default: return [];
    }
}

/**
 * APT: FORM APT (or IAPT) > FORM 0000 > NAME chunk -> single path to .lod or .msh
 */
function parseAPT(root: IFFNode): ParsedReference[] {
    // APT can use form name "APT " or "IAPT"
    const nameChunks = findChunksDeep(root, 'NAME');
    for (const chunk of nameChunks) {
        if (chunk.data && chunk.data.length > 0) {
            const path = decodeASCII(chunk.data);
            if (path.length > 0) {
                return [{ path, label: 'Appearance' }];
            }
        }
    }
    return [];
}

/**
 * SAT: FORM SMAT > FORM 0003 >
 *   MSGN chunk (multiple null-terminated paths concatenated)
 *   SKTI chunk (skeleton paths with attachment names)
 *   LATX chunk (skeleton + LAT path pairs)
 */
function parseSAT(root: IFFNode): ParsedReference[] {
    const refs: ParsedReference[] = [];

    // Find MSGN chunk - contains one or more LMG paths concatenated with nulls
    const msgnChunks = findChunksDeep(root, 'MSGN');
    for (const chunk of msgnChunks) {
        if (!chunk.data) continue;
        const paths = extractNullTerminatedStrings(chunk.data);
        for (const p of paths) {
            if (p.includes('/')) {
                refs.push({ path: p, label: 'Mesh Group' });
            }
        }
    }

    // Find SKTI chunk - skeleton paths (with attachment point names interleaved)
    const sktiChunks = findChunksDeep(root, 'SKTI');
    for (const chunk of sktiChunks) {
        if (!chunk.data) continue;
        const strings = extractNullTerminatedStrings(chunk.data);
        for (const s of strings) {
            if (s.startsWith('appearance/skeleton/') || s.endsWith('.skt')) {
                refs.push({ path: s, label: 'Skeleton' });
            }
        }
    }

    // Find LATX chunk - pairs of skeleton + LAT paths (with leading count bytes)
    const latxChunks = findChunksDeep(root, 'LATX');
    for (const chunk of latxChunks) {
        if (!chunk.data || chunk.data.length < 3) continue;
        // Skip the 2-byte count header
        const strings = extractNullTerminatedStrings(chunk.data, 2);
        for (const s of strings) {
            if (s.endsWith('.lat')) {
                refs.push({ path: s, label: 'Animation Layer' });
            }
            // Skeleton paths from LATX are duplicates of SKTI, skip them
        }
    }

    return refs;
}

/**
 * LOD: FORM DTLA > ... > CHLD chunks
 * Each CHLD chunk: 4-byte LE index + null-terminated path (relative to appearance/)
 */
function parseLOD(root: IFFNode, rawData: Uint8Array): ParsedReference[] {
    const refs: ParsedReference[] = [];

    // Try IFF-based parsing first - find all CHLD chunks
    const chldChunks = findChunksDeep(root, 'CHLD');
    if (chldChunks.length > 0) {
        for (const chunk of chldChunks) {
            if (!chunk.data || chunk.data.length < 5) continue;
            // First 4 bytes are LE index (order index, not LOD level)
            const meshPath = decodeASCII(chunk.data, 4);
            if (meshPath.length > 0) {
                const lodLevel = extractLodLevel(meshPath);
                refs.push({
                    path: meshPath,
                    label: `LOD Level ${lodLevel}${lodLevel === 0 ? ' (highest detail)' : ''}`
                });
            }
        }
        return refs;
    }

    // Fallback: also check DATACHLD chunks (alternate naming)
    const dataChldChunks = findChunksDeep(root, 'DATA');
    // If no CHLD chunks found, try binary scan
    return parseLODFallback(rawData);
}

/**
 * Fallback LOD parser using binary string scanning
 */
function parseLODFallback(rawData: Uint8Array): ParsedReference[] {
    const refs: ParsedReference[] = [];
    const text = binaryToString(rawData);
    const regex = /mesh\/[^\x00]+\.msh/g;
    let match;
    let index = 0;
    while ((match = regex.exec(text)) !== null) {
        refs.push({
            path: match[0],
            label: `LOD Level ${index}`
        });
        index++;
    }
    return refs;
}

/**
 * LMG: FORM MLOD > FORM 0000 > multiple NAME chunks -> .mgn paths
 */
function parseLMG(root: IFFNode): ParsedReference[] {
    const refs: ParsedReference[] = [];
    const nameChunks = findChunksDeep(root, 'NAME');
    let lodLevel = 0;
    for (const chunk of nameChunks) {
        if (!chunk.data) continue;
        const path = decodeASCII(chunk.data);
        if (path.length > 0 && path.includes('/')) {
            refs.push({
                path,
                label: `LOD Level ${lodLevel}${lodLevel === 0 ? ' (highest detail)' : ''}`
            });
            lodLevel++;
        }
    }
    return refs;
}

/**
 * MSH: FORM MESH > ... > FORM SPS > child FORMs > NAME chunk -> shader path
 */
function parseMSH(root: IFFNode, rawData: Uint8Array): ParsedReference[] {
    const refs: ParsedReference[] = [];
    const seen = new Set<string>();

    // Find SPS forms which contain shader references
    const spsForms = findAllForms(root, 'SPS ');
    for (const sps of spsForms) {
        const nameChunks = findChunksDeep(sps, 'NAME');
        for (const chunk of nameChunks) {
            if (!chunk.data) continue;
            const path = decodeASCII(chunk.data);
            if (path.length > 0 && path.includes('shader/') && !seen.has(path)) {
                seen.add(path);
                refs.push({ path, label: 'Shader' });
            }
        }
    }

    // Fallback: scan raw binary for shader paths
    if (refs.length === 0) {
        const text = binaryToString(rawData);
        const regex = /shader\/[^\x00]+\.sht/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            if (!seen.has(match[0])) {
                seen.add(match[0]);
                refs.push({ path: match[0], label: 'Shader' });
            }
        }
    }

    return refs;
}

/**
 * MGN: FORM SKMG > ... > FORM PSDT > NAME chunk -> shader path
 * Also has SKTM chunk with skeleton path.
 */
function parseMGN(root: IFFNode, rawData: Uint8Array): ParsedReference[] {
    const refs: ParsedReference[] = [];
    const seen = new Set<string>();

    // Extract skeleton reference from SKTM chunk
    const sktmChunks = findChunksDeep(root, 'SKTM');
    for (const chunk of sktmChunks) {
        if (!chunk.data) continue;
        const path = decodeASCII(chunk.data);
        if (path.length > 0 && !seen.has(path)) {
            seen.add(path);
            refs.push({ path, label: 'Skeleton' });
        }
    }

    // Find PSDT forms which contain shader NAME chunks
    const psdtForms = findAllForms(root, 'PSDT');
    for (const psdt of psdtForms) {
        const nameChunks = findChunks(psdt, 'NAME');
        for (const chunk of nameChunks) {
            if (!chunk.data) continue;
            const path = decodeASCII(chunk.data);
            if (path.length > 0 && path.includes('shader/') && !seen.has(path)) {
                seen.add(path);
                refs.push({ path, label: 'Shader' });
            }
        }
    }

    // Fallback: scan raw binary for shader paths
    if (refs.filter(r => r.label === 'Shader').length === 0) {
        const text = binaryToString(rawData);
        const regex = /shader\/[^\x00]+\.sht/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            if (!seen.has(match[0])) {
                seen.add(match[0]);
                refs.push({ path: match[0], label: 'Shader' });
            }
        }
    }

    return refs;
}

/**
 * SHT: FORM SSHT > FORM 0000 > FORM TXMS > FORM TXM > FORM 0001 > NAME -> texture path
 * Also final NAME chunk -> .eft effect path
 */
function parseSHT(root: IFFNode, rawData: Uint8Array): ParsedReference[] {
    const refs: ParsedReference[] = [];
    const seen = new Set<string>();

    // Find all NAME chunks in the tree
    const nameChunks = findChunksDeep(root, 'NAME');
    for (const chunk of nameChunks) {
        if (!chunk.data) continue;
        const path = decodeASCII(chunk.data);
        if (path.length === 0 || seen.has(path)) continue;

        if (path.includes('texture/') && path.endsWith('.dds')) {
            seen.add(path);
            refs.push({ path, label: 'Texture' });
        } else if ((path.includes('effect') || path.includes('effect')) && path.endsWith('.eft')) {
            seen.add(path);
            refs.push({ path, label: 'Effect' });
        }
    }

    // Fallback: binary scan for texture and effect paths
    if (refs.length === 0) {
        const text = binaryToString(rawData);
        const texRegex = /texture\/[^\x00]+\.dds/g;
        let match;
        while ((match = texRegex.exec(text)) !== null) {
            if (!seen.has(match[0])) {
                seen.add(match[0]);
                refs.push({ path: match[0], label: 'Texture' });
            }
        }
        const eftRegex = /effect[/\\][^\x00]+\.eft/g;
        while ((match = eftRegex.exec(text)) !== null) {
            if (!seen.has(match[0])) {
                seen.add(match[0]);
                refs.push({ path: match[0], label: 'Effect' });
            }
        }
    }

    return refs;
}

/**
 * Object IFF: Extract appearanceFilename from XXXX property chunks.
 * Object templates have DERV/SHOT forms with XXXX chunks containing
 * name\x00\x01value\x00 format properties.
 */
function parseObjectIFF(root: IFFNode): ParsedReference[] {
    const refs: ParsedReference[] = [];

    // Find all XXXX chunks (property chunks in object templates)
    const xxxxChunks = findChunksDeep(root, 'XXXX');
    for (const chunk of xxxxChunks) {
        if (!chunk.data || chunk.data.length < 5) continue;

        // Extract property name (null-terminated)
        const nameEnd = findNull(chunk.data, 0);
        if (nameEnd <= 0) continue;

        const propName = decodeASCII(chunk.data, 0);
        if (propName !== 'appearanceFilename') continue;

        // Value starts after name + null + marker byte (0x01)
        const valueStart = nameEnd + 1;
        if (valueStart >= chunk.data.length) continue;

        // Check for value marker
        if (chunk.data[valueStart] === 0x01) {
            const path = decodeASCII(chunk.data, valueStart + 1);
            if (path.length > 0) {
                refs.push({ path, label: 'Appearance' });
            }
        }
    }

    return refs;
}

// --- Helpers ---

/**
 * Extract the LOD level number from a filename like "mesh/foo_l2.msh" -> 2
 */
function extractLodLevel(filePath: string): number {
    const match = filePath.match(/_l(\d+)\.\w+$/);
    return match ? parseInt(match[1], 10) : 0;
}

/**
 * Extract all null-terminated strings from a byte array.
 */
function extractNullTerminatedStrings(data: Uint8Array, startOffset: number = 0): string[] {
    const strings: string[] = [];
    let pos = startOffset;

    while (pos < data.length) {
        const nullPos = findNull(data, pos);
        if (nullPos < 0) break;

        if (nullPos > pos) {
            const str = decodeASCII(data, pos);
            if (str.length > 0) {
                strings.push(str);
            }
        }
        pos = nullPos + 1;
    }

    return strings;
}

/**
 * Convert binary data to a string for regex scanning.
 * Non-printable chars become \x00 equivalent for null matching.
 */
function binaryToString(data: Uint8Array): string {
    let result = '';
    for (let i = 0; i < data.length; i++) {
        const byte = data[i];
        if (byte === 0) {
            result += '\x00';
        } else if (byte >= 32 && byte < 127) {
            result += String.fromCharCode(byte);
        } else {
            result += '\x00';
        }
    }
    return result;
}
