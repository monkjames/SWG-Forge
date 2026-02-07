/**
 * SWG Asset Customization Manager (ACM) Parser/Writer
 *
 * The ACM maps appearance file CRCs to customization variables (palettes, color indices,
 * morph blends). The client uses this to know what color pickers to show for each item.
 *
 * IFF Structure: FORM ACST -> FORM 0000 -> 12 data chunks:
 *   NAME  - Null-terminated string table (palette paths + variable names)
 *   PNOF  - Palette Name Offsets (uint16 LE offsets into NAME)
 *   VNOF  - Variable Name Offsets (uint16 LE offsets into NAME)
 *   DEFV  - Default Values (int32 BE per variable)
 *   IRNG  - Integer Ranges (min/max pairs for ranged variables)
 *   RTYP  - Range Types (uint16: high bit = palette, low 15 bits = index)
 *   UCMP  - Unified Compression (precomputed variable combinations)
 *   ULST  - Unified List (uint16 LE references)
 *   UIDX  - Unique Index (5 bytes: index_LE, llst_offset_LE, count)
 *   LLST  - Linked List (uint16 LE references)
 *   LIDX  - Linked Index (5 bytes: index_LE, ulst_offset_LE, count)
 *   CIDX  - CRC Index (6 bytes: crc_LE, index_LE; sorted by CRC for binary search)
 *
 * CRC Algorithm: MPEG-2/HDLC CRC-32 (polynomial 0x04C11DB7)
 * NOTE: ACM CRCs do NOT lowercase the path (unlike object template CRCs).
 */

import { parseIFF, serializeIFF, findForm, findChunk, IFFNode, readNullString } from './iff';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ACMPalette {
    index: number;
    nameOffset: number;
    path: string;
}

export interface ACMVariable {
    index: number;
    nameOffset: number;
    path: string;
}

export interface ACMAssetEntry {
    index: number;
    llstOffset: number;   // byte offset into LLST
    ucmpCount: number;    // number of customization references
}

export interface ACMCidxEntry {
    crc: number;
    assetIndex: number;
}

export interface ACMLidxEntry {
    index: number;
    ulstOffset: number;
    count: number;
}

export interface ACMCustomizationVar {
    variableName: string;
    isPalette: boolean;
    palettePath?: string;       // if isPalette
    minRange?: number;          // if !isPalette
    maxRange?: number;          // if !isPalette
    defaultValue: number;
}

export interface ACMData {
    // Parsed string data
    palettes: ACMPalette[];
    variables: ACMVariable[];

    // Raw section data (preserved for round-trip fidelity)
    nameData: Uint8Array;
    pnofData: Uint8Array;
    vnofData: Uint8Array;
    defvData: Uint8Array;
    irngData: Uint8Array;
    rtypData: Uint8Array;
    ucmpData: Uint8Array;
    ulstData: Uint8Array;
    uidxEntries: ACMAssetEntry[];
    llstData: Uint8Array;
    lidxEntries: ACMLidxEntry[];
    cidxEntries: ACMCidxEntry[];

    // Raw bytes for sections we don't fully parse (for round-trip)
    uidxRaw: Uint8Array;
    lidxRaw: Uint8Array;
    cidxRaw: Uint8Array;
}

// ─── CRC (ACM-specific: NO lowercasing) ─────────────────────────────────────────

const ACM_CRC_TABLE: number[] = [];

(function buildTable() {
    for (let i = 0; i < 256; i++) {
        let crc = (i << 24) >>> 0;
        for (let j = 0; j < 8; j++) {
            if (crc & 0x80000000) {
                crc = ((crc << 1) ^ 0x04C11DB7) >>> 0;
            } else {
                crc = (crc << 1) >>> 0;
            }
        }
        ACM_CRC_TABLE.push(crc);
    }
})();

/**
 * Calculate ACM CRC-32 for an asset path.
 * Unlike object template CRCs, ACM does NOT lowercase the input.
 */
export function acmCRC(path: string): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < path.length; i++) {
        const byte = path.charCodeAt(i) & 0xFF;
        const index = ((crc >>> 24) ^ byte) & 0xFF;
        crc = ((crc << 8) ^ ACM_CRC_TABLE[index]) >>> 0;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function readUint16LE(data: Uint8Array, offset: number): number {
    return data[offset] | (data[offset + 1] << 8);
}

function readUint32LE(data: Uint8Array, offset: number): number {
    return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function readInt32BE(data: Uint8Array, offset: number): number {
    return (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
}

function writeUint16LE(value: number): Uint8Array {
    const buf = new Uint8Array(2);
    buf[0] = value & 0xFF;
    buf[1] = (value >>> 8) & 0xFF;
    return buf;
}

function writeUint32LE(value: number): Uint8Array {
    const buf = new Uint8Array(4);
    buf[0] = value & 0xFF;
    buf[1] = (value >>> 8) & 0xFF;
    buf[2] = (value >>> 16) & 0xFF;
    buf[3] = (value >>> 24) & 0xFF;
    return buf;
}

function writeInt32BE(value: number): Uint8Array {
    const buf = new Uint8Array(4);
    buf[0] = (value >>> 24) & 0xFF;
    buf[1] = (value >>> 16) & 0xFF;
    buf[2] = (value >>> 8) & 0xFF;
    buf[3] = value & 0xFF;
    return buf;
}

// ─── Parse ──────────────────────────────────────────────────────────────────────

/**
 * Parse an ACM IFF binary into structured data
 */
export function parseACM(data: Uint8Array): ACMData {
    const root = parseIFF(data);

    // Navigate: FORM ACST -> FORM 0000
    const acstForm = root.formName === 'ACST' ? root : findForm(root, 'ACST');
    if (!acstForm) throw new Error('Not a valid ACM file (missing FORM ACST)');

    const versionForm = acstForm.children?.find(c => c.type === 'form' && c.formName === '0000');
    if (!versionForm) throw new Error('Not a valid ACM file (missing FORM 0000)');

    // Extract raw chunk data
    const getChunkData = (tag: string): Uint8Array => {
        const chunk = findChunk(versionForm, tag);
        return chunk?.data || new Uint8Array(0);
    };

    const nameData = getChunkData('NAME');
    const pnofData = getChunkData('PNOF');
    const vnofData = getChunkData('VNOF');
    const defvData = getChunkData('DEFV');
    const irngData = getChunkData('IRNG');
    const rtypData = getChunkData('RTYP');
    const ucmpData = getChunkData('UCMP');
    const ulstData = getChunkData('ULST');
    const uidxRaw = getChunkData('UIDX');
    const llstData = getChunkData('LLST');
    const lidxRaw = getChunkData('LIDX');
    const cidxRaw = getChunkData('CIDX');

    // Parse NAME: null-terminated strings
    // Parse PNOF: palette name offsets -> resolve from NAME
    const palettes: ACMPalette[] = [];
    for (let i = 0; i + 1 < pnofData.length; i += 2) {
        const offset = readUint16LE(pnofData, i);
        const path = readNullString(nameData, offset);
        palettes.push({ index: palettes.length, nameOffset: offset, path });
    }

    // Parse VNOF: variable name offsets -> resolve from NAME
    const variables: ACMVariable[] = [];
    for (let i = 0; i + 1 < vnofData.length; i += 2) {
        const offset = readUint16LE(vnofData, i);
        const path = readNullString(nameData, offset);
        variables.push({ index: variables.length, nameOffset: offset, path });
    }

    // Parse UIDX: 5 bytes per entry (uint16 index, uint16 llst_offset, uint8 count)
    const uidxEntries: ACMAssetEntry[] = [];
    for (let i = 0; i + 4 < uidxRaw.length; i += 5) {
        uidxEntries.push({
            index: readUint16LE(uidxRaw, i),
            llstOffset: readUint16LE(uidxRaw, i + 2) * 2,
            ucmpCount: uidxRaw[i + 4]
        });
    }

    // Parse LIDX: 5 bytes per entry (uint16 index, uint16 ulst_offset, uint8 count)
    const lidxEntries: ACMLidxEntry[] = [];
    for (let i = 0; i + 4 < lidxRaw.length; i += 5) {
        lidxEntries.push({
            index: readUint16LE(lidxRaw, i),
            ulstOffset: readUint16LE(lidxRaw, i + 2),
            count: lidxRaw[i + 4]
        });
    }

    // Parse CIDX: 6 bytes per entry (uint32 CRC_LE, uint16 asset_index_LE), sorted by CRC
    const cidxEntries: ACMCidxEntry[] = [];
    for (let i = 0; i + 5 < cidxRaw.length; i += 6) {
        cidxEntries.push({
            crc: readUint32LE(cidxRaw, i),
            assetIndex: readUint16LE(cidxRaw, i + 4)
        });
    }

    return {
        palettes, variables,
        nameData, pnofData, vnofData, defvData,
        irngData, rtypData, ucmpData, ulstData,
        uidxEntries, llstData, lidxEntries, cidxEntries,
        uidxRaw, lidxRaw, cidxRaw
    };
}

// ─── Query ──────────────────────────────────────────────────────────────────────

/**
 * Look up an asset path in the CIDX by CRC (binary search)
 */
export function findAssetByCRC(acm: ACMData, crc: number): ACMCidxEntry | null {
    let lo = 0, hi = acm.cidxEntries.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const entry = acm.cidxEntries[mid];
        if (entry.crc === crc) return entry;
        if (entry.crc < crc) lo = mid + 1;
        else hi = mid - 1;
    }
    return null;
}

/**
 * Look up an asset path string in the CIDX
 */
export function findAssetByPath(acm: ACMData, assetPath: string): ACMCidxEntry | null {
    return findAssetByCRC(acm, acmCRC(assetPath));
}

/**
 * Get the UIDX entry for an asset index
 */
export function getUidxEntry(acm: ACMData, assetIndex: number): ACMAssetEntry | undefined {
    return acm.uidxEntries.find(e => e.index === assetIndex);
}

/**
 * Get the LIDX entry for an asset index
 */
export function getLidxEntry(acm: ACMData, assetIndex: number): ACMLidxEntry | undefined {
    return acm.lidxEntries.find(e => e.index === assetIndex);
}

/**
 * Resolve the full customization variables for a UIDX entry.
 * Reads through UCMP to get variable name, type, and default value.
 */
export function resolveCustomization(acm: ACMData, assetIndex: number): ACMCustomizationVar[] {
    const result: ACMCustomizationVar[] = [];

    const uidx = getUidxEntry(acm, assetIndex);
    if (!uidx || uidx.ucmpCount === 0) return result;

    // Read UCMP indices from LLST at uidx.llstOffset
    for (let i = 0; i < uidx.ucmpCount; i++) {
        const llstPos = uidx.llstOffset + i * 2;
        if (llstPos + 1 >= acm.llstData.length) break;
        const ucmpIndex = readUint16LE(acm.llstData, llstPos);

        // UCMP entry: 3 bytes (vnof_index, rtyp_index, defv_index) - but actual format
        // may vary. The UCMP records are variable-length precomputed combos.
        // Each is: uint8 vnofIdx, uint8 rtypIdx, uint8 defvIdx
        const ucmpOffset = ucmpIndex * 3;
        if (ucmpOffset + 2 >= acm.ucmpData.length) continue;

        const vnofIdx = acm.ucmpData[ucmpOffset];
        const rtypIdx = acm.ucmpData[ucmpOffset + 1];
        const defvIdx = acm.ucmpData[ucmpOffset + 2];

        // Get variable name
        const variableName = vnofIdx < acm.variables.length ? acm.variables[vnofIdx].path : `unknown_${vnofIdx}`;

        // Get range type
        let isPalette = false;
        let palettePath: string | undefined;
        let minRange: number | undefined;
        let maxRange: number | undefined;

        if (rtypIdx * 2 + 1 < acm.rtypData.length) {
            const rtyp = readUint16LE(acm.rtypData, rtypIdx * 2);
            isPalette = (rtyp & 0x8000) !== 0;
            const subIndex = rtyp & 0x7FFF;

            if (isPalette) {
                palettePath = subIndex < acm.palettes.length ? acm.palettes[subIndex].path : undefined;
            } else {
                // IRNG: 8 bytes per entry (int32 min, int32 max)
                const irngOffset = subIndex * 8;
                if (irngOffset + 7 < acm.irngData.length) {
                    minRange = readInt32BE(acm.irngData, irngOffset);
                    maxRange = readInt32BE(acm.irngData, irngOffset + 4);
                }
            }
        }

        // Get default value
        let defaultValue = 0;
        if (defvIdx * 4 + 3 < acm.defvData.length) {
            defaultValue = readInt32BE(acm.defvData, defvIdx * 4);
        }

        result.push({ variableName, isPalette, palettePath, minRange, maxRange, defaultValue });
    }

    return result;
}

// ─── Modify ─────────────────────────────────────────────────────────────────────

/**
 * Add a new palette path to the ACM. Returns the palette index.
 * Idempotent: returns existing index if already present.
 */
export function addPalette(acm: ACMData, palPath: string): number {
    // Normalize
    if (!palPath.startsWith('palette/')) palPath = 'palette/' + palPath;
    if (!palPath.endsWith('.pal')) palPath += '.pal';

    // Check existing
    const existing = acm.palettes.find(p => p.path === palPath);
    if (existing) return existing.index;

    // Append to NAME
    const encoded = new TextEncoder().encode(palPath + '\0');
    const newOffset = acm.nameData.length;
    const newName = new Uint8Array(acm.nameData.length + encoded.length);
    newName.set(acm.nameData);
    newName.set(encoded, acm.nameData.length);
    acm.nameData = newName;

    // Append to PNOF
    const newPnof = new Uint8Array(acm.pnofData.length + 2);
    newPnof.set(acm.pnofData);
    newPnof.set(writeUint16LE(newOffset), acm.pnofData.length);
    acm.pnofData = newPnof;

    const palette: ACMPalette = { index: acm.palettes.length, nameOffset: newOffset, path: palPath };
    acm.palettes.push(palette);
    return palette.index;
}

/**
 * Add a new variable path to the ACM. Returns the variable index.
 * Idempotent: returns existing index if already present.
 */
export function addVariable(acm: ACMData, varPath: string): number {
    // Normalize
    if (!varPath.startsWith('/')) varPath = '/private/' + varPath;

    // Check existing
    const existing = acm.variables.find(v => v.path === varPath);
    if (existing) return existing.index;

    // Append to NAME
    const encoded = new TextEncoder().encode(varPath + '\0');
    const newOffset = acm.nameData.length;
    const newName = new Uint8Array(acm.nameData.length + encoded.length);
    newName.set(acm.nameData);
    newName.set(encoded, acm.nameData.length);
    acm.nameData = newName;

    // Append to VNOF
    const newVnof = new Uint8Array(acm.vnofData.length + 2);
    newVnof.set(acm.vnofData);
    newVnof.set(writeUint16LE(newOffset), acm.vnofData.length);
    acm.vnofData = newVnof;

    const variable: ACMVariable = { index: acm.variables.length, nameOffset: newOffset, path: varPath };
    acm.variables.push(variable);
    return variable.index;
}

/**
 * Add a CIDX entry for an asset path, pointing to an existing asset index's customization.
 * The assetIndex should reference an existing UIDX entry (copy its customization).
 * Maintains CIDX sorted order by CRC.
 */
export function addCidxEntry(acm: ACMData, assetPath: string, assetIndex: number): void {
    const crc = acmCRC(assetPath);

    // Check for existing
    if (findAssetByCRC(acm, crc)) return;

    const entry: ACMCidxEntry = { crc, assetIndex };

    // Insert in sorted order
    let insertAt = acm.cidxEntries.length;
    for (let i = 0; i < acm.cidxEntries.length; i++) {
        if (acm.cidxEntries[i].crc > crc) {
            insertAt = i;
            break;
        }
    }
    acm.cidxEntries.splice(insertAt, 0, entry);

    // Rebuild cidxRaw
    acm.cidxRaw = rebuildCidxRaw(acm.cidxEntries);
}

/**
 * Add a new UIDX entry with no customization (count=0).
 * Useful for registering assets that need to be in the ACM but don't need color pickers.
 */
export function addMinimalUidxEntry(acm: ACMData, assetIndex: number): void {
    if (acm.uidxEntries.find(e => e.index === assetIndex)) return;

    const entry: ACMAssetEntry = { index: assetIndex, llstOffset: 0, ucmpCount: 0 };

    // Insert sorted by index
    let insertAt = acm.uidxEntries.length;
    for (let i = 0; i < acm.uidxEntries.length; i++) {
        if (acm.uidxEntries[i].index > assetIndex) {
            insertAt = i;
            break;
        }
    }
    acm.uidxEntries.splice(insertAt, 0, entry);

    // Rebuild uidxRaw
    acm.uidxRaw = rebuildUidxRaw(acm.uidxEntries);
}

/**
 * Add an asset path pointing to the same customization as an existing asset.
 * This is the recommended way to add new armor/clothing that should share
 * the same color palettes as an existing item.
 */
export function addAssetLikeExisting(acm: ACMData, newAssetPath: string, copyFromIndex: number): void {
    const source = acm.uidxEntries.find(e => e.index === copyFromIndex);
    if (!source) throw new Error(`Source asset index ${copyFromIndex} not found in UIDX`);

    // Find next available asset index
    const maxIndex = acm.uidxEntries.reduce((max, e) => Math.max(max, e.index), 0);
    const newIndex = maxIndex + 1;

    // Add UIDX entry pointing to same LLST data
    const newEntry: ACMAssetEntry = {
        index: newIndex,
        llstOffset: source.llstOffset,
        ucmpCount: source.ucmpCount
    };
    acm.uidxEntries.push(newEntry);
    acm.uidxEntries.sort((a, b) => a.index - b.index);
    acm.uidxRaw = rebuildUidxRaw(acm.uidxEntries);

    // Mirror in LIDX if source has a LIDX entry
    const sourceLidx = acm.lidxEntries.find(e => e.index === copyFromIndex);
    if (sourceLidx) {
        acm.lidxEntries.push({ index: newIndex, ulstOffset: sourceLidx.ulstOffset, count: sourceLidx.count });
        acm.lidxEntries.sort((a, b) => a.index - b.index);
        acm.lidxRaw = rebuildLidxRaw(acm.lidxEntries);
    }

    // Add CIDX entry
    addCidxEntry(acm, newAssetPath, newIndex);
}

// ─── Serialize ──────────────────────────────────────────────────────────────────

/**
 * Serialize ACM data back to IFF binary
 */
export function serializeACM(acm: ACMData): Uint8Array {
    const chunks: IFFNode[] = [
        { type: 'chunk', tag: 'NAME', data: acm.nameData, offset: 0, size: acm.nameData.length },
        { type: 'chunk', tag: 'PNOF', data: acm.pnofData, offset: 0, size: acm.pnofData.length },
        { type: 'chunk', tag: 'VNOF', data: acm.vnofData, offset: 0, size: acm.vnofData.length },
        { type: 'chunk', tag: 'DEFV', data: acm.defvData, offset: 0, size: acm.defvData.length },
        { type: 'chunk', tag: 'IRNG', data: acm.irngData, offset: 0, size: acm.irngData.length },
        { type: 'chunk', tag: 'RTYP', data: acm.rtypData, offset: 0, size: acm.rtypData.length },
        { type: 'chunk', tag: 'UCMP', data: acm.ucmpData, offset: 0, size: acm.ucmpData.length },
        { type: 'chunk', tag: 'ULST', data: acm.ulstData, offset: 0, size: acm.ulstData.length },
        { type: 'chunk', tag: 'UIDX', data: acm.uidxRaw, offset: 0, size: acm.uidxRaw.length },
        { type: 'chunk', tag: 'LLST', data: acm.llstData, offset: 0, size: acm.llstData.length },
        { type: 'chunk', tag: 'LIDX', data: acm.lidxRaw, offset: 0, size: acm.lidxRaw.length },
        { type: 'chunk', tag: 'CIDX', data: acm.cidxRaw, offset: 0, size: acm.cidxRaw.length },
    ];

    const versionForm: IFFNode = {
        type: 'form', tag: 'FORM', formName: '0000',
        children: chunks, offset: 0, size: 0
    };

    const root: IFFNode = {
        type: 'form', tag: 'FORM', formName: 'ACST',
        children: [versionForm], offset: 0, size: 0
    };

    return serializeIFF(root);
}

/**
 * Create a minimal valid ACM for a single asset with no customization.
 * 131 bytes total. Used when an asset just needs to exist in the ACM
 * but doesn't need color pickers.
 */
export function createMinimalACM(assetPath: string, assetIndex: number = 1): Uint8Array {
    const crc = acmCRC(assetPath);

    const acm: ACMData = {
        palettes: [], variables: [],
        nameData: new Uint8Array(0),
        pnofData: new Uint8Array(0),
        vnofData: new Uint8Array(0),
        defvData: new Uint8Array(0),
        irngData: new Uint8Array(0),
        rtypData: new Uint8Array(0),
        ucmpData: new Uint8Array(0),
        ulstData: new Uint8Array(0),
        uidxEntries: [{ index: assetIndex, llstOffset: 0, ucmpCount: 0 }],
        llstData: new Uint8Array(0),
        lidxEntries: [],
        cidxEntries: [{ crc, assetIndex }],
        uidxRaw: new Uint8Array(0),
        lidxRaw: new Uint8Array(0),
        cidxRaw: new Uint8Array(0),
    };

    // Build raw sections
    acm.uidxRaw = rebuildUidxRaw(acm.uidxEntries);
    acm.cidxRaw = rebuildCidxRaw(acm.cidxEntries);

    return serializeACM(acm);
}

// ─── Internal rebuild helpers ───────────────────────────────────────────────────

function rebuildCidxRaw(entries: ACMCidxEntry[]): Uint8Array {
    const raw = new Uint8Array(entries.length * 6);
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        raw.set(writeUint32LE(e.crc), i * 6);
        raw.set(writeUint16LE(e.assetIndex), i * 6 + 4);
    }
    return raw;
}

function rebuildUidxRaw(entries: ACMAssetEntry[]): Uint8Array {
    const raw = new Uint8Array(entries.length * 5);
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        raw.set(writeUint16LE(e.index), i * 5);
        raw.set(writeUint16LE(e.llstOffset / 2), i * 5 + 2);  // convert byte offset back to word offset
        raw[i * 5 + 4] = e.ucmpCount;
    }
    return raw;
}

function rebuildLidxRaw(entries: ACMLidxEntry[]): Uint8Array {
    const raw = new Uint8Array(entries.length * 5);
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        raw.set(writeUint16LE(e.index), i * 5);
        raw.set(writeUint16LE(e.ulstOffset), i * 5 + 2);
        raw[i * 5 + 4] = e.count;
    }
    return raw;
}

// ─── Summary ────────────────────────────────────────────────────────────────────

export interface ACMSummary {
    palettes: number;
    variables: number;
    uidxEntries: number;
    lidxEntries: number;
    cidxEntries: number;
    nameBytes: number;
    totalBytes: number;
}

export function getACMSummary(acm: ACMData): ACMSummary {
    const totalBytes = acm.nameData.length + acm.pnofData.length + acm.vnofData.length +
        acm.defvData.length + acm.irngData.length + acm.rtypData.length +
        acm.ucmpData.length + acm.ulstData.length + acm.uidxRaw.length +
        acm.llstData.length + acm.lidxRaw.length + acm.cidxRaw.length;

    return {
        palettes: acm.palettes.length,
        variables: acm.variables.length,
        uidxEntries: acm.uidxEntries.length,
        lidxEntries: acm.lidxEntries.length,
        cidxEntries: acm.cidxEntries.length,
        nameBytes: acm.nameData.length,
        totalBytes
    };
}
