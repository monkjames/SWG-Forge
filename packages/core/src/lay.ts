/**
 * LAY (Terrain Modification) File Parser/Serializer for SWG
 *
 * LAY files define terrain modifications applied when buildings are placed.
 * They use IFF format with a TGEN (Terrain Generator) root containing:
 * - SGRP: Shader family definitions (ground textures)
 * - FGRP: Flora family definitions
 * - RGRP: Radial flora family definitions
 * - EGRP: Environment definitions
 * - MGRP: Map fractal definitions
 * - LAYR/LYRS: Layer(s) with boundaries and affectors
 *
 * Binary format:
 * - IFF structure: tags/sizes are big-endian (standard IFF)
 * - Data values: int32/float32 are little-endian (engine3 native byte order)
 * - Strings: null-terminated ASCII
 *
 * NOTE: Extracted .lay files in tre/vanilla/ may be missing the outer
 * FORM TGEN + FORM 0000 wrapper. The parser handles both formats.
 * The serializer always produces the full wrapped format.
 */

// ============================================================
// Data Interfaces
// ============================================================

export interface LAYData {
    shaderFamilies: ShaderFamily[];
    floraFamilies: FloraFamily[];
    radialFamilies: RadialFamily[];
    environmentEntries: EnvironmentEntry[];
    mapFamilies: MapFamily[];
    layers: LAYLayer[];
    /** Preserved group versions for round-trip fidelity */
    groupVersions?: {
        sgrp?: string;
        fgrp?: string;
        rgrp?: string;
        egrp?: string;
        mgrp?: string;
    };
    /** Raw EGRP content bytes (preserves EFAM data for round-trip) */
    egrpRaw?: RawGroupData;
    /** Raw MGRP content bytes (preserves MFAM+MFRC data for round-trip) */
    mgrpRaw?: RawGroupData;
    /** Optional second MGRP (BitmapGroup) - stored as complete raw FORM */
    bitmapGroupRaw?: Uint8Array;
    /** Whether the original file was wrapped in FORM TGEN > FORM 0000. Preserved for roundtrip. */
    _wrapped?: boolean;
}

export interface ShaderFamily {
    familyId: number;
    familyName: string;
    fileName: string;     // e.g. "terrain/naboo_dirt.sht"
    red: number;          // color preview (0-255)
    green: number;
    blue: number;
    var7: number;         // float, unknown
    weight: number;       // float, blending weight
    children: ShaderChild[];
}

export interface ShaderChild {
    name: string;
    weight: number;
}

export interface FloraFamily {
    familyId: number;
    familyName: string;
    red: number;
    green: number;
    blue: number;
    weight: number;
    isAquatic: number;
    children: FloraChild[];
}

export interface FloraChild {
    name: string;
    var1: number;  // float
    var2: number;  // uint32
    var3: number;  // float
    var4: number;  // float
    var5: number;  // uint32
    var6: number;  // int32
    var7: number;  // float
    var8: number;  // float
}

export interface RadialChild {
    name: string;
    var1: number;  // float
    var2: number;  // float (different from FloraChild!)
    var3: number;  // float
    var4: number;  // float
    var5: number;  // int32
    var6: number;  // float
    var7: number;  // float
    var8: number;  // int32
    var9: number;  // uint32
}

export interface RadialFamily {
    familyId: number;
    familyName: string;
    red: number;
    green: number;
    blue: number;
    weight: number;
    // NOTE: no isAquatic field (unlike FloraFamily)
    children: RadialChild[];
}

export interface EnvironmentEntry {
    familyId: number;
    familyName: string;
}

export interface MapFamily {
    var1: number;
}

/**
 * Raw group data for round-trip fidelity.
 * EGRP and MGRP can contain complex sub-structures (EFAM, MFAM+MFRC)
 * that we preserve as raw bytes rather than fully parsing.
 */
export interface RawGroupData {
    /** Raw bytes of the content INSIDE the version form (after the version tag) */
    rawContent: Uint8Array;
}

export interface LAYLayer {
    enabled: boolean;
    description: string;
    boundariesFlag: number;
    filterFlag: number;
    var3: number;
    var4: string;
    /** Extra field present in LAYR v0004 */
    var5?: number;
    boundaries: LAYBoundary[];
    affectors: LAYAffector[];
    filters: LAYFilter[];
    children: LAYLayer[];
    /** Preserved layer version for round-trip */
    version?: string;
}

// --- Boundary Types ---

export type LAYBoundary =
    | BoundaryCircle
    | BoundaryRectangle
    | BoundaryPolygon
    | BoundaryPolyline;

export interface BoundaryCircle {
    type: 'BCIR';
    enabled: boolean;
    description: string;
    centerX: number;
    centerY: number;
    radius: number;
    featheringType: number;
    featheringAmount: number;
}

export interface BoundaryRectangle {
    type: 'BREC';
    version: '0002' | '0003';
    enabled: boolean;
    description: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    featheringType: number;
    featheringAmount: number;
    // v0003 extensions
    localWaterTableEnabled?: number;
    localWaterTableVar7?: number;
    localWaterTableHeight?: number;
    shaderSize?: number;
    shaderName?: string;
}

export interface Point2D {
    x: number;
    y: number;
}

export interface BoundaryPolygon {
    type: 'BPOL';
    enabled: boolean;
    description: string;
    vertices: Point2D[];
    featheringType: number;
    featheringAmount: number;
    localWaterTableEnabled?: number;
    localWaterTableHeight?: number;
    shaderSize?: number;
    shaderName?: string;
}

export interface BoundaryPolyline {
    type: 'BPLN';
    enabled: boolean;
    description: string;
    vertices: Point2D[];
    featheringType: number;
    featheringAmount: number;
    lineWidth: number;
}

// --- Affector Types ---

export type LAYAffector =
    | AffectorHeightConstant
    | AffectorShaderConstant
    | AffectorFloraNonCollidableConstant
    | AffectorNoncollideFloraConstant
    | AffectorRadialConstant
    | AffectorRadialFarConstant
    | AffectorEnvironment
    | AffectorExclude
    | AffectorPassable
    | AffectorHeightTerrace
    | AffectorHeightFractal
    | AffectorColorConstant
    | AffectorColorRampHeight
    | AffectorColorRampFractal
    | AffectorRoad
    | AffectorRiver
    | AffectorShaderReplace
    | AffectorFCN
    | AffectorRCN
    | AffectorGeneric;

export interface AffectorHeightConstant {
    affectorType: 'AHCN';
    enabled: boolean;
    description: string;
    version?: string;
    operationType: number;  // 0=set(flatten), 1=add, 2=subtract, 3=percentage, 4=zero
    height: number;
}

export interface AffectorShaderConstant {
    affectorType: 'ASCN';
    enabled: boolean;
    description: string;
    version?: string;
    familyId: number;
    featheringType: number;
    featheringAmount: number;
}

export interface AffectorFloraNonCollidableConstant {
    affectorType: 'AFSN';
    enabled: boolean;
    description: string;
    version?: string;
    familyId: number;
    var2: number;
    flag: number;  // 1 = remove
    featheringType: number;
    featheringAmount: number;
}

export interface AffectorNoncollideFloraConstant {
    affectorType: 'AFSC';
    enabled: boolean;
    description: string;
    version?: string;
    familyId: number;
    var2: number;
    flag: number;
    featheringType: number;
    featheringAmount: number;
}

export interface AffectorRadialConstant {
    affectorType: 'AFDN';
    enabled: boolean;
    description: string;
    version?: string;
    familyId: number;
    var2: number;
    flag: number;
    featheringType: number;
    featheringAmount: number;
}

export interface AffectorRadialFarConstant {
    affectorType: 'AFDF';
    enabled: boolean;
    description: string;
    version?: string;
    familyId: number;
    var2: number;
    flag: number;
    featheringType: number;
    featheringAmount: number;
}

export interface AffectorFCN {
    affectorType: 'AFCN';
    enabled: boolean;
    description: string;
    version?: string;
    familyId: number;
    var2: number;
    flag: number;
    featheringType: number;
    featheringAmount: number;
}

export interface AffectorRCN {
    affectorType: 'ARCN';
    enabled: boolean;
    description: string;
    version?: string;
    familyId: number;
    var2: number;
    flag: number;
    featheringType: number;
    featheringAmount: number;
}

export interface AffectorEnvironment {
    affectorType: 'AENV';
    enabled: boolean;
    description: string;
    version?: string;
    environmentId: number;
    var2: number;
    weight: number;
}

export interface AffectorExclude {
    affectorType: 'AEXC';
    enabled: boolean;
    description: string;
    version?: string;
}

export interface AffectorPassable {
    affectorType: 'APAS';
    enabled: boolean;
    description: string;
    version?: string;
    var1: number;  // byte
    var2: number;  // int
}

export interface AffectorHeightTerrace {
    affectorType: 'AHTR';
    enabled: boolean;
    description: string;
    version?: string;
    flatRatio: number;
    height: number;
}

export interface AffectorHeightFractal {
    affectorType: 'AHFR';
    enabled: boolean;
    description: string;
    version?: string;
    fractalId: number;
    operationType: number;
    height: number;
}

export interface AffectorColorConstant {
    affectorType: 'ACCN';
    enabled: boolean;
    description: string;
    version?: string;
    id: number;
    red: number;
    green: number;
    blue: number;
}

export interface AffectorColorRampHeight {
    affectorType: 'ACRH';
    enabled: boolean;
    description: string;
    version?: string;
    familyId: number;
    min: number;
    max: number;
    shaderFile: string;
}

export interface AffectorColorRampFractal {
    affectorType: 'ACRF';
    enabled: boolean;
    description: string;
    version?: string;
    familyId: number;
    var2: number;           // v0000: float, v0001: byte
    var3?: number;          // v0000 only
    var4?: number;          // v0000 only
    featheringType?: number; // v0000 only
    featheringAmount?: number; // v0000 only
    shaderFile: string;
}

export interface AffectorRoad {
    affectorType: 'AROA';
    enabled: boolean;
    description: string;
    version?: string;
    rawData: Uint8Array;
}

export interface AffectorRiver {
    affectorType: 'ARIV';
    enabled: boolean;
    description: string;
    version?: string;
    rawData: Uint8Array;
}

export interface AffectorShaderReplace {
    affectorType: 'ASRP';
    enabled: boolean;
    description: string;
    version?: string;
    rawData: Uint8Array;
}

export interface AffectorGeneric {
    affectorType: string;
    enabled: boolean;
    description: string;
    version?: string;
    rawData: Uint8Array;
}

// --- Filter Types ---

export type LAYFilter = FilterGeneric;

export interface FilterGeneric {
    filterType: string;
    enabled: boolean;
    description: string;
    version?: string;
    rawData: Uint8Array;
}

// ============================================================
// Binary Reader Helper
// ============================================================

class BinaryReader {
    private data: Uint8Array;
    private view: DataView;
    pos: number;

    constructor(data: Uint8Array, offset: number = 0) {
        this.data = data;
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.pos = offset;
    }

    get length(): number {
        return this.data.length;
    }

    readTag(): string {
        const tag = String.fromCharCode(
            this.data[this.pos], this.data[this.pos + 1],
            this.data[this.pos + 2], this.data[this.pos + 3]
        );
        this.pos += 4;
        return tag;
    }

    peekTag(): string {
        return String.fromCharCode(
            this.data[this.pos], this.data[this.pos + 1],
            this.data[this.pos + 2], this.data[this.pos + 3]
        );
    }

    readSizeBE(): number {
        const val = this.view.getUint32(this.pos, false);
        this.pos += 4;
        return val;
    }

    readInt32LE(): number {
        const val = this.view.getInt32(this.pos, true);
        this.pos += 4;
        return val;
    }

    readUint32LE(): number {
        const val = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return val;
    }

    readFloat32LE(): number {
        const val = this.view.getFloat32(this.pos, true);
        this.pos += 4;
        return val;
    }

    readByte(): number {
        return this.data[this.pos++];
    }

    readNullString(maxLen?: number): string {
        let str = '';
        const end = maxLen ? Math.min(this.pos + maxLen, this.data.length) : this.data.length;
        while (this.pos < end && this.data[this.pos] !== 0) {
            str += String.fromCharCode(this.data[this.pos++]);
        }
        if (this.pos < this.data.length) this.pos++; // skip null
        return str;
    }

    readBytes(count: number): Uint8Array {
        const result = this.data.slice(this.pos, this.pos + count);
        this.pos += count;
        return result;
    }

    skip(count: number): void {
        this.pos += count;
    }
}

// ============================================================
// Binary Writer Helper
// ============================================================

class BinaryWriter {
    private chunks: Uint8Array[] = [];
    private totalSize = 0;

    writeTag(tag: string): void {
        const buf = new Uint8Array(4);
        for (let i = 0; i < 4; i++) buf[i] = tag.charCodeAt(i);
        this.chunks.push(buf);
        this.totalSize += 4;
    }

    writeSizeBE(size: number): void {
        const buf = new Uint8Array(4);
        const view = new DataView(buf.buffer);
        view.setUint32(0, size, false);
        this.chunks.push(buf);
        this.totalSize += 4;
    }

    writeInt32LE(val: number): void {
        const buf = new Uint8Array(4);
        const view = new DataView(buf.buffer);
        view.setInt32(0, val, true);
        this.chunks.push(buf);
        this.totalSize += 4;
    }

    writeUint32LE(val: number): void {
        const buf = new Uint8Array(4);
        const view = new DataView(buf.buffer);
        view.setUint32(0, val, true);
        this.chunks.push(buf);
        this.totalSize += 4;
    }

    writeFloat32LE(val: number): void {
        const buf = new Uint8Array(4);
        const view = new DataView(buf.buffer);
        view.setFloat32(0, val, true);
        this.chunks.push(buf);
        this.totalSize += 4;
    }

    writeByte(val: number): void {
        this.chunks.push(new Uint8Array([val & 0xFF]));
        this.totalSize += 1;
    }

    writeNullString(str: string): void {
        const buf = new Uint8Array(str.length + 1);
        for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
        buf[str.length] = 0;
        this.chunks.push(buf);
        this.totalSize += str.length + 1;
    }

    writeBytes(data: Uint8Array): void {
        this.chunks.push(data);
        this.totalSize += data.length;
    }

    toUint8Array(): Uint8Array {
        const result = new Uint8Array(this.totalSize);
        let offset = 0;
        for (const chunk of this.chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }

    get size(): number {
        return this.totalSize;
    }
}

// ============================================================
// Parser
// ============================================================

/**
 * Parse a LAY (terrain modification) file from binary data.
 * Handles both wrapped (FORM TGEN > FORM 0000 > content) and
 * unwrapped (FORM SGRP > FORM FGRP > ...) formats.
 */
export function parseLAY(data: Uint8Array): LAYData {
    const r = new BinaryReader(data);
    let wrapped = false;

    // Check if wrapped in FORM TGEN
    const firstTag = r.peekTag();
    if (firstTag === 'FORM') {
        // Read outer header
        r.readTag(); // 'FORM'
        const outerSize = r.readSizeBE();
        const outerType = r.readTag();

        if (outerType === 'TGEN') {
            wrapped = true;
            // Skip version form: FORM 0000
            const vTag = r.readTag(); // 'FORM'
            const vSize = r.readSizeBE();
            const vType = r.readTag(); // '0000'
            // Now positioned at inner content (SGRP, FGRP, etc.)
        } else if (outerType === 'SGRP') {
            // Unwrapped format - reset to start
            r.pos = 0;
        } else {
            throw new Error(`Unexpected root form type: ${outerType}`);
        }
    }

    // Parse groups in sequence, preserving versions for round-trip
    // SGRP, FGRP, RGRP are always present. EGRP and MGRP may be missing.
    const groupVersions: NonNullable<LAYData['groupVersions']> = {};
    const shaderFamilies = parseSGRP(r, groupVersions);
    const floraFamilies = parseFGRP(r, groupVersions);
    const radialFamilies = parseRGRP(r, groupVersions);

    // Helper to peek at the next form type
    function peekNextFormType(): string | null {
        if (r.pos >= r.length - 12) return null;
        const savedPos = r.pos;
        r.readTag(); // FORM
        r.readSizeBE();
        const type = r.readTag();
        r.pos = savedPos;
        return type;
    }

    // EGRP is optional — some files go directly RGRP → LAYR
    let environmentEntries: EnvironmentEntry[] = [];
    let egrpRaw: RawGroupData | undefined;
    if (peekNextFormType() === 'EGRP') {
        const result = parseEGRPWithRaw(r, groupVersions);
        environmentEntries = result.entries;
        egrpRaw = result.raw;
    }

    // MGRP is optional — some files go directly EGRP → LAYR (or RGRP → LAYR)
    let mapFamilies: MapFamily[] = [];
    let mgrpRaw: RawGroupData | undefined;
    let bitmapGroupRaw: Uint8Array | undefined;

    if (peekNextFormType() === 'MGRP') {
        const mgrpResult = parseMGRPWithRaw(r, groupVersions);
        mapFamilies = mgrpResult.entries;
        mgrpRaw = mgrpResult.raw;

        // Check for optional second MGRP (BitmapGroup)
        if (peekNextFormType() === 'MGRP') {
            r.readTag(); // FORM
            const totalSize = r.readSizeBE();
            r.pos -= 8; // back to start of FORM
            bitmapGroupRaw = r.readBytes(8 + totalSize);
        }
    }

    // Parse layers (LAYR or LYRS)
    const layers: LAYLayer[] = [];
    if (r.pos < r.length - 8) {
        const peekTag = r.peekTag();
        if (peekTag === 'FORM') {
            r.readTag(); // FORM
            const laySize = r.readSizeBE();
            const layType = r.readTag();

            if (layType === 'LAYR') {
                layers.push(parseLayerContent(r, r.pos + laySize - 4));
            } else if (layType === 'LYRS') {
                // Multiple layers wrapper
                const lyrsEnd = r.pos + laySize - 4;
                while (r.pos < lyrsEnd - 8) {
                    r.readTag(); // FORM
                    const lSize = r.readSizeBE();
                    const lType = r.readTag(); // LAYR
                    if (lType === 'LAYR') {
                        layers.push(parseLayerContent(r, r.pos + lSize - 4));
                    } else {
                        r.pos += lSize - 4; // skip unknown
                    }
                }
            }
        }
    }

    return {
        shaderFamilies,
        floraFamilies,
        radialFamilies,
        environmentEntries,
        mapFamilies,
        layers,
        groupVersions,
        egrpRaw,
        mgrpRaw,
        bitmapGroupRaw,
        _wrapped: wrapped,
    };
}

function parseFormHeader(r: BinaryReader): { type: string; size: number; contentEnd: number } {
    const tag = r.readTag(); // FORM
    const size = r.readSizeBE();
    const type = r.readTag();
    return { type, size, contentEnd: r.pos + size - 4 };
}

function parseVersionForm(r: BinaryReader): { version: string; contentEnd: number } {
    const { type: version, size, contentEnd } = parseFormHeader(r);
    return { version, contentEnd };
}

// --- SGRP (Shader Group) ---

function parseSGRP(r: BinaryReader, gv: NonNullable<LAYData['groupVersions']>): ShaderFamily[] {
    const { contentEnd } = parseFormHeader(r); // FORM SGRP
    const { version, contentEnd: vEnd } = parseVersionForm(r);
    gv.sgrp = version;
    const families: ShaderFamily[] = [];

    while (r.pos < vEnd - 8) {
        families.push(parseSFAM(r));
    }

    r.pos = contentEnd;
    return families;
}

function parseSFAM(r: BinaryReader): ShaderFamily {
    const tag = r.readTag(); // SFAM
    const size = r.readSizeBE();
    const end = r.pos + size;

    const familyId = r.readInt32LE();
    const familyName = r.readNullString();
    const fileName = r.readNullString();
    const red = r.readByte();
    const green = r.readByte();
    const blue = r.readByte();
    const var7 = r.readFloat32LE();
    const weight = r.readFloat32LE();
    const nLayers = r.readInt32LE();
    const children: ShaderChild[] = [];
    for (let i = 0; i < nLayers; i++) {
        children.push({
            name: r.readNullString(),
            weight: r.readFloat32LE(),
        });
    }

    r.pos = end;
    return { familyId, familyName, fileName, red, green, blue, var7, weight, children };
}

// --- FGRP (Flora Group) ---

function parseFGRP(r: BinaryReader, gv: NonNullable<LAYData['groupVersions']>): FloraFamily[] {
    const { contentEnd } = parseFormHeader(r); // FORM FGRP
    const { version, contentEnd: vEnd } = parseVersionForm(r);
    gv.fgrp = version;
    const families: FloraFamily[] = [];

    while (r.pos < vEnd - 8) {
        families.push(parseFFAM(r));
    }

    r.pos = contentEnd;
    return families;
}

function parseFFAM(r: BinaryReader): FloraFamily {
    const tag = r.readTag(); // FFAM
    const size = r.readSizeBE();
    const end = r.pos + size;

    const familyId = r.readInt32LE();
    const familyName = r.readNullString();
    const red = r.readByte();
    const green = r.readByte();
    const blue = r.readByte();
    const weight = r.readFloat32LE();
    const isAquatic = r.readUint32LE();
    const nChildren = r.readInt32LE();
    const children: FloraChild[] = [];
    for (let i = 0; i < nChildren; i++) {
        children.push({
            name: r.readNullString(),
            var1: r.readFloat32LE(),
            var2: r.readUint32LE(),
            var3: r.readFloat32LE(),
            var4: r.readFloat32LE(),
            var5: r.readUint32LE(),
            var6: r.readInt32LE(),
            var7: r.readFloat32LE(),
            var8: r.readFloat32LE(),
        });
    }

    r.pos = end;
    return { familyId, familyName, red, green, blue, weight, isAquatic, children };
}

// --- RGRP (Radial Group) ---

function parseRGRP(r: BinaryReader, gv: NonNullable<LAYData['groupVersions']>): RadialFamily[] {
    const { contentEnd } = parseFormHeader(r); // FORM RGRP
    const { version, contentEnd: vEnd } = parseVersionForm(r);
    gv.rgrp = version;
    const families: RadialFamily[] = [];

    while (r.pos < vEnd - 8) {
        families.push(parseRFAM(r));
    }

    r.pos = contentEnd;
    return families;
}

function parseRFAM(r: BinaryReader): RadialFamily {
    const tag = r.readTag(); // RFAM
    const size = r.readSizeBE();
    const end = r.pos + size;

    const familyId = r.readInt32LE();
    const familyName = r.readNullString();
    const red = r.readByte();
    const green = r.readByte();
    const blue = r.readByte();
    const weight = r.readFloat32LE();
    // NOTE: RadialFamily has NO isAquatic field (unlike FloraFamily)
    const nChildren = r.readInt32LE();
    const children: RadialChild[] = [];
    for (let i = 0; i < nChildren; i++) {
        children.push({
            name: r.readNullString(),
            var1: r.readFloat32LE(),
            var2: r.readFloat32LE(),  // float (not uint32 like FloraChild)
            var3: r.readFloat32LE(),
            var4: r.readFloat32LE(),
            var5: r.readInt32LE(),
            var6: r.readFloat32LE(),
            var7: r.readFloat32LE(),
            var8: r.readInt32LE(),
            var9: r.readUint32LE(),
        });
    }

    r.pos = end;
    return { familyId, familyName, red, green, blue, weight, children };
}

// --- EGRP (Environment Group) ---

function parseEGRPWithRaw(r: BinaryReader, gv: NonNullable<LAYData['groupVersions']>): { entries: EnvironmentEntry[]; raw?: RawGroupData } {
    const { contentEnd } = parseFormHeader(r); // FORM EGRP
    const { version, contentEnd: vEnd } = parseVersionForm(r);
    gv.egrp = version;

    // If version form has content (EFAM chunks), preserve as raw bytes
    let raw: RawGroupData | undefined;
    if (r.pos < vEnd) {
        raw = { rawContent: r.readBytes(vEnd - r.pos) };
    }

    r.pos = contentEnd;
    return { entries: [], raw };
}

// --- MGRP (Map Group) ---

function parseMGRPWithRaw(r: BinaryReader, gv: NonNullable<LAYData['groupVersions']>): { entries: MapFamily[]; raw?: RawGroupData } {
    const { contentEnd } = parseFormHeader(r); // FORM MGRP
    const { version, contentEnd: vEnd } = parseVersionForm(r);
    gv.mgrp = version;

    // If version form has content (MFAM+MFRC chunks), preserve as raw bytes
    let raw: RawGroupData | undefined;
    if (r.pos < vEnd) {
        raw = { rawContent: r.readBytes(vEnd - r.pos) };
    }

    r.pos = contentEnd;
    return { entries: [], raw };
}

// --- Layer ---

function parseLayerContent(r: BinaryReader, end: number): LAYLayer {
    // Inside FORM LAYR, read version form (0003 or 0004)
    const { version, contentEnd: vEnd } = parseVersionForm(r);

    // Parse IHDR
    const { enabled, description } = parseIHDR(r);

    // Parse ADTA
    const adtaTag = r.readTag(); // ADTA
    const adtaSize = r.readSizeBE();
    const adtaEnd = r.pos + adtaSize;
    const boundariesFlag = r.readUint32LE();
    const filterFlag = r.readUint32LE();
    const var3 = r.readUint32LE();
    // v0004 has an extra uint32 field BEFORE the string
    let var5: number | undefined;
    if (version === '0004') {
        var5 = r.readUint32LE();
    }
    const var4 = r.readNullString();
    r.pos = adtaEnd;

    const boundaries: LAYBoundary[] = [];
    const affectors: LAYAffector[] = [];
    const filters: LAYFilter[] = [];
    const children: LAYLayer[] = [];

    // Parse remaining sub-chunks
    while (r.pos < vEnd - 8) {
        const peekTag = r.peekTag();
        if (peekTag !== 'FORM') {
            // Skip unknown non-FORM chunk
            r.readTag();
            const skipSize = r.readSizeBE();
            r.skip(skipSize);
            continue;
        }

        // Read FORM header to peek at type
        const savedPos = r.pos;
        r.readTag(); // FORM
        const formSize = r.readSizeBE();
        const formType = r.readTag();
        const formEnd = r.pos + formSize - 4;

        // Determine what kind of element this is
        const boundary = parseBoundaryByType(r, formType, formEnd);
        if (boundary) {
            boundaries.push(boundary);
            r.pos = formEnd;
            continue;
        }

        const affector = parseAffectorByType(r, formType, formEnd, savedPos);
        if (affector) {
            affectors.push(affector);
            r.pos = formEnd;
            continue;
        }

        const filter = parseFilterByType(r, formType, formEnd, savedPos);
        if (filter) {
            filters.push(filter);
            r.pos = formEnd;
            continue;
        }

        if (formType === 'LAYR') {
            children.push(parseLayerContent(r, formEnd));
            r.pos = formEnd;
            continue;
        }

        // Unknown form - skip
        r.pos = formEnd;
    }

    r.pos = end;
    return {
        enabled,
        description,
        boundariesFlag,
        filterFlag,
        var3,
        var4,
        var5,
        boundaries,
        affectors,
        filters,
        children,
        version,
    };
}

// --- IHDR (Information Header) ---

function parseIHDR(r: BinaryReader): { enabled: boolean; description: string } {
    const { contentEnd } = parseFormHeader(r); // FORM IHDR
    const { version, contentEnd: vEnd } = parseVersionForm(r); // FORM 0001

    const dataTag = r.readTag(); // DATA
    const dataSize = r.readSizeBE();
    const dataEnd = r.pos + dataSize;

    const enabledFlag = r.readInt32LE();
    const description = r.readNullString();

    r.pos = contentEnd;
    return { enabled: enabledFlag !== 0, description };
}

// --- Boundary Parsers ---

const BOUNDARY_TYPES = new Set(['BCIR', 'BREC', 'BPOL', 'BPLN', 'BALL', 'BSPL']);

function parseBoundaryByType(r: BinaryReader, formType: string, formEnd: number): LAYBoundary | null {
    if (!BOUNDARY_TYPES.has(formType)) return null;

    // Read version form
    const { version, contentEnd: vEnd } = parseVersionForm(r);

    switch (formType) {
        case 'BCIR': return parseBCIR(r, vEnd);
        case 'BREC': return parseBREC(r, vEnd, version);
        case 'BPOL': return parseBPOL(r, vEnd);
        case 'BPLN': return parseBPLN(r, vEnd);
        case 'BALL':
        case 'BSPL':
            return null; // Empty/skipped boundaries
        default:
            return null;
    }
}

function parseBCIR(r: BinaryReader, end: number): BoundaryCircle {
    const { enabled, description } = parseIHDR(r);

    const dataTag = r.readTag(); // DATA
    const dataSize = r.readSizeBE();
    const centerX = r.readFloat32LE();
    const centerY = r.readFloat32LE();
    const radius = r.readFloat32LE();
    const featheringType = r.readInt32LE();
    let featheringAmount = r.readFloat32LE();
    featheringAmount = Math.max(0, Math.min(1, featheringAmount));

    return { type: 'BCIR', enabled, description, centerX, centerY, radius, featheringType, featheringAmount };
}

function parseBREC(r: BinaryReader, end: number, version: string): BoundaryRectangle {
    const { enabled, description } = parseIHDR(r);

    const dataTag = r.readTag(); // DATA
    const dataSize = r.readSizeBE();
    const dataEnd = r.pos + dataSize;

    const x0 = r.readFloat32LE();
    const y0 = r.readFloat32LE();
    const x1 = r.readFloat32LE();
    const y1 = r.readFloat32LE();
    const featheringType = r.readInt32LE();
    let featheringAmount = r.readFloat32LE();
    featheringAmount = Math.max(0, Math.min(1, featheringAmount));

    const result: BoundaryRectangle = {
        type: 'BREC',
        version: version === '0003' ? '0003' : '0002',
        enabled, description, x0, y0, x1, y1, featheringType, featheringAmount,
    };

    if (version === '0003') {
        result.localWaterTableEnabled = r.readInt32LE();
        result.localWaterTableVar7 = r.readInt32LE();
        result.localWaterTableHeight = r.readFloat32LE();
        result.shaderSize = r.readFloat32LE();
        result.shaderName = r.readNullString();
    }

    r.pos = dataEnd;
    return result;
}

function parseBPOL(r: BinaryReader, end: number): BoundaryPolygon {
    const { enabled, description } = parseIHDR(r);

    const dataTag = r.readTag(); // DATA
    const dataSize = r.readSizeBE();
    const dataEnd = r.pos + dataSize;

    const vertexCount = r.readInt32LE();
    const vertices: Point2D[] = [];
    for (let i = 0; i < vertexCount; i++) {
        vertices.push({ x: r.readFloat32LE(), y: r.readFloat32LE() });
    }
    const featheringType = r.readInt32LE();
    let featheringAmount = r.readFloat32LE();
    featheringAmount = Math.max(0, Math.min(1, featheringAmount));

    // v0005 has water table fields
    let localWaterTableEnabled: number | undefined;
    let localWaterTableHeight: number | undefined;
    let shaderSize: number | undefined;
    let shaderName: string | undefined;
    if (r.pos < dataEnd - 4) {
        localWaterTableEnabled = r.readInt32LE();
        localWaterTableHeight = r.readFloat32LE();
        shaderSize = r.readFloat32LE();
        shaderName = r.readNullString();
    }

    r.pos = dataEnd;
    return { type: 'BPOL', enabled, description, vertices, featheringType, featheringAmount,
        localWaterTableEnabled, localWaterTableHeight, shaderSize, shaderName };
}

function parseBPLN(r: BinaryReader, end: number): BoundaryPolyline {
    const { enabled, description } = parseIHDR(r);

    const dataTag = r.readTag(); // DATA
    const dataSize = r.readSizeBE();
    const dataEnd = r.pos + dataSize;

    const pointCount = r.readInt32LE();
    const vertices: Point2D[] = [];
    for (let i = 0; i < pointCount; i++) {
        vertices.push({ x: r.readFloat32LE(), y: r.readFloat32LE() });
    }
    const featheringType = r.readInt32LE();
    let featheringAmount = r.readFloat32LE();
    featheringAmount = Math.max(0, Math.min(1, featheringAmount));
    const lineWidth = r.readFloat32LE();

    r.pos = dataEnd;
    return { type: 'BPLN', enabled, description, vertices, featheringType, featheringAmount, lineWidth };
}

// --- Affector Parsers ---

const AFFECTOR_TYPES = new Set([
    'AHCN', 'ASCN', 'AFSN', 'AFSC', 'AFDN', 'AFDF', 'AFCN', 'ARCN',
    'AENV', 'AEXC', 'APAS', 'AHTR', 'AHFR', 'ACCN', 'ACRH', 'ACRF',
    'AROA', 'ARIV', 'ASRP',
    'ACBM', 'AFBM', 'AHBM', 'AHSM', 'ASBM', // skipped types
]);

function parseAffectorByType(r: BinaryReader, formType: string, formEnd: number, savedPos: number): LAYAffector | null {
    if (!AFFECTOR_TYPES.has(formType)) return null;

    // Skipped types
    if (['ACBM', 'AFBM', 'AHBM', 'AHSM', 'ASBM'].includes(formType)) {
        return null;
    }

    // Read version form
    const { version, contentEnd: vEnd } = parseVersionForm(r);

    // All affectors start with IHDR
    const { enabled, description } = parseIHDR(r);

    switch (formType) {
        case 'AHCN': {
            const dataTag = r.readTag(); // DATA
            const dataSize = r.readSizeBE();
            const operationType = r.readInt32LE();
            const height = r.readFloat32LE();
            return { affectorType: 'AHCN', enabled, description, version, operationType, height };
        }
        case 'ASCN': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const familyId = r.readInt32LE();
            const featheringType = r.readInt32LE();
            const featheringAmount = r.readFloat32LE();
            return { affectorType: 'ASCN', enabled, description, version, familyId, featheringType, featheringAmount };
        }
        case 'AFSN': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const familyId = r.readInt32LE();
            const var2 = r.readInt32LE();
            const flag = r.readInt32LE();
            const featheringType = r.readInt32LE();
            const featheringAmount = r.readFloat32LE();
            return { affectorType: 'AFSN', enabled, description, version, familyId, var2, flag, featheringType, featheringAmount };
        }
        case 'AFSC': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const familyId = r.readInt32LE();
            const var2 = r.readInt32LE();
            const flag = r.readInt32LE();
            const featheringType = r.readInt32LE();
            const featheringAmount = r.readFloat32LE();
            return { affectorType: 'AFSC', enabled, description, version, familyId, var2, flag, featheringType, featheringAmount };
        }
        case 'AFDN': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const familyId = r.readInt32LE();
            const var2 = r.readInt32LE();
            const flag = r.readInt32LE();
            const featheringType = r.readInt32LE();
            const featheringAmount = r.readFloat32LE();
            return { affectorType: 'AFDN', enabled, description, version, familyId, var2, flag, featheringType, featheringAmount };
        }
        case 'AFDF': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const familyId = r.readInt32LE();
            const var2 = r.readInt32LE();
            const flag = r.readInt32LE();
            const featheringType = r.readInt32LE();
            const featheringAmount = r.readFloat32LE();
            return { affectorType: 'AFDF', enabled, description, version, familyId, var2, flag, featheringType, featheringAmount };
        }
        case 'AFCN': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const familyId = r.readInt32LE();
            const var2 = r.readInt32LE();
            const flag = r.readInt32LE();
            const featheringType = r.readInt32LE();
            const featheringAmount = r.readFloat32LE();
            return { affectorType: 'AFCN', enabled, description, version, familyId, var2, flag, featheringType, featheringAmount };
        }
        case 'ARCN': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const familyId = r.readInt32LE();
            const var2 = r.readInt32LE();
            const flag = r.readInt32LE();
            const featheringType = r.readInt32LE();
            const featheringAmount = r.readFloat32LE();
            return { affectorType: 'ARCN', enabled, description, version, familyId, var2, flag, featheringType, featheringAmount };
        }
        case 'AENV': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const environmentId = r.readInt32LE();
            const var2 = r.readInt32LE();
            const weight = r.readFloat32LE();
            return { affectorType: 'AENV', enabled, description, version, environmentId, var2, weight };
        }
        case 'AEXC': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            return { affectorType: 'AEXC', enabled, description, version };
        }
        case 'APAS': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const var1 = r.readByte();
            const var2 = r.readInt32LE();
            return { affectorType: 'APAS', enabled, description, version, var1, var2 };
        }
        case 'AHTR': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const flatRatio = r.readFloat32LE();
            const height = r.readFloat32LE();
            return { affectorType: 'AHTR', enabled, description, version, flatRatio, height };
        }
        case 'AHFR': {
            // AHFR has FORM DATA instead of CHUNK DATA
            const innerTag = r.readTag(); // FORM
            const innerSize = r.readSizeBE();
            const innerType = r.readTag(); // DATA
            const parmTag = r.readTag(); // PARM
            const parmSize = r.readSizeBE();
            const fractalId = r.readInt32LE();
            const operationType = r.readInt32LE();
            const height = r.readFloat32LE();
            return { affectorType: 'AHFR', enabled, description, version, fractalId, operationType, height };
        }
        case 'ACCN': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const id = r.readInt32LE();
            const red = r.readByte();
            const green = r.readByte();
            const blue = r.readByte();
            return { affectorType: 'ACCN', enabled, description, version, id, red, green, blue };
        }
        case 'ACRH': {
            const dataTag = r.readTag();
            const dataSize = r.readSizeBE();
            const dataEnd = r.pos + dataSize;
            const familyId = r.readInt32LE();
            const min = r.readFloat32LE();
            const max = r.readFloat32LE();
            const shaderFile = r.readNullString();
            r.pos = dataEnd;
            return { affectorType: 'ACRH', enabled, description, version, familyId, min, max, shaderFile };
        }
        case 'ACRF': {
            if (version === '0001') {
                // v0001: FORM DATA > CHUNK PARM [familyId(int32), var2(byte), shaderFile]
                const formTag = r.readTag(); // FORM
                const formSize = r.readSizeBE();
                const formType = r.readTag(); // DATA
                const parmTag = r.readTag(); // PARM
                const parmSize = r.readSizeBE();
                const parmEnd = r.pos + parmSize;
                const familyId = r.readInt32LE();
                const var2 = r.readInt32LE();
                const shaderFile = r.readNullString();
                r.pos = parmEnd;
                return { affectorType: 'ACRF', enabled, description, version, familyId, var2, shaderFile };
            } else {
                // v0000: DATA [familyId, var2-var4(floats), featheringType, featheringAmount, shaderFile]
                const dataTag = r.readTag();
                const dataSize = r.readSizeBE();
                const dataEnd = r.pos + dataSize;
                const familyId = r.readInt32LE();
                const var2 = r.readFloat32LE();
                const var3 = r.readFloat32LE();
                const var4 = r.readFloat32LE();
                const featheringType = r.readInt32LE();
                const featheringAmount = r.readFloat32LE();
                const shaderFile = r.readNullString();
                r.pos = dataEnd;
                return { affectorType: 'ACRF', enabled, description, version, familyId, var2, var3, var4, featheringType, featheringAmount, shaderFile };
            }
        }
        case 'AROA':
        case 'ARIV':
        case 'ASRP': {
            // Complex structures - store raw
            const rawData = r.readBytes(formEnd - r.pos);
            return { affectorType: formType, enabled, description, version, rawData } as AffectorGeneric;
        }
        default:
            return null;
    }
}

// --- Filter Parsers ---

const FILTER_TYPES = new Set(['FHGT', 'FBIT', 'FDIR', 'FFRA', 'FSHD', 'FSLP']);

function parseFilterByType(r: BinaryReader, formType: string, formEnd: number, savedPos: number): LAYFilter | null {
    if (!FILTER_TYPES.has(formType)) return null;

    const { version, contentEnd: vEnd } = parseVersionForm(r);
    const { enabled, description } = parseIHDR(r);
    const rawData = r.readBytes(formEnd - r.pos);

    return { filterType: formType, enabled, description, version, rawData };
}

// ============================================================
// Serializer
// ============================================================

/**
 * Serialize a LAYData object to binary LAY file format.
 * Produces the full wrapped format: FORM TGEN > FORM 0000 > content
 */
/** Internal: serialize LAY content (groups + layers) to a writer */
function serializeLAYContent(w: BinaryWriter, lay: LAYData): void {
    const gv = lay.groupVersions || {};

    serializeSGRP(w, lay.shaderFamilies, gv.sgrp);
    serializeFGRP(w, lay.floraFamilies, gv.fgrp);
    serializeRGRP(w, lay.radialFamilies, gv.rgrp);

    // EGRP is only emitted if the original had one (indicated by gv.egrp being set)
    if (gv.egrp !== undefined) {
        serializeEGRP(w, lay.environmentEntries, gv.egrp, lay.egrpRaw);
    }

    // MGRP is only emitted if the original had one (indicated by gv.mgrp being set)
    if (gv.mgrp !== undefined) {
        serializeMGRP(w, lay.mapFamilies, gv.mgrp, lay.mgrpRaw);
    }

    // Optional second MGRP (BitmapGroup) as raw bytes
    if (lay.bitmapGroupRaw?.length) {
        w.writeBytes(lay.bitmapGroupRaw);
    }

    if (lay.layers.length === 1) {
        serializeLayer(w, lay.layers[0]);
    } else if (lay.layers.length > 1) {
        const layersContent = new BinaryWriter();
        for (const layer of lay.layers) {
            serializeLayer(layersContent, layer);
        }
        const layersBytes = layersContent.toUint8Array();
        w.writeTag('FORM');
        w.writeSizeBE(4 + layersBytes.length);
        w.writeTag('LYRS');
        w.writeBytes(layersBytes);
    }
}

export function serializeLAY(lay: LAYData): Uint8Array {
    // If original was unwrapped, serialize unwrapped to preserve format
    if (lay._wrapped === false) {
        return serializeLAYUnwrapped(lay);
    }

    const inner = new BinaryWriter();
    serializeLAYContent(inner, lay);
    const innerBytes = inner.toUint8Array();

    // Wrap in FORM 0000
    const v0000 = new BinaryWriter();
    v0000.writeTag('FORM');
    v0000.writeSizeBE(4 + innerBytes.length);
    v0000.writeTag('0000');
    v0000.writeBytes(innerBytes);
    const v0000Bytes = v0000.toUint8Array();

    // Wrap in FORM TGEN
    const root = new BinaryWriter();
    root.writeTag('FORM');
    root.writeSizeBE(4 + v0000Bytes.length);
    root.writeTag('TGEN');
    root.writeBytes(v0000Bytes);

    return root.toUint8Array();
}

/**
 * Serialize to "unwrapped" format (no TGEN/0000 wrapper).
 * Matches the format of extracted .lay files in tre/vanilla/.
 */
export function serializeLAYUnwrapped(lay: LAYData): Uint8Array {
    const w = new BinaryWriter();
    serializeLAYContent(w, lay);
    return w.toUint8Array();
}

// --- Group Serializers ---

function serializeSGRP(w: BinaryWriter, families: ShaderFamily[], version?: string): void {
    const content = new BinaryWriter();
    for (const fam of families) {
        serializeSFAM(content, fam);
    }
    const contentBytes = content.toUint8Array();

    const ver = new BinaryWriter();
    ver.writeTag('FORM');
    ver.writeSizeBE(4 + contentBytes.length);
    ver.writeTag(version || '0006');
    ver.writeBytes(contentBytes);
    const versionBytes = ver.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + versionBytes.length);
    w.writeTag('SGRP');
    w.writeBytes(versionBytes);
}

function serializeSFAM(w: BinaryWriter, fam: ShaderFamily): void {
    const data = new BinaryWriter();
    data.writeInt32LE(fam.familyId);
    data.writeNullString(fam.familyName);
    data.writeNullString(fam.fileName);
    data.writeByte(fam.red);
    data.writeByte(fam.green);
    data.writeByte(fam.blue);
    data.writeFloat32LE(fam.var7);
    data.writeFloat32LE(fam.weight);
    data.writeInt32LE(fam.children.length);
    for (const child of fam.children) {
        data.writeNullString(child.name);
        data.writeFloat32LE(child.weight);
    }
    const dataBytes = data.toUint8Array();

    w.writeTag('SFAM');
    w.writeSizeBE(dataBytes.length);
    w.writeBytes(dataBytes);
}

function serializeFGRP(w: BinaryWriter, families: FloraFamily[], version?: string): void {
    const content = new BinaryWriter();
    for (const fam of families) {
        serializeFFAM(content, fam);
    }
    const contentBytes = content.toUint8Array();

    const ver = new BinaryWriter();
    ver.writeTag('FORM');
    ver.writeSizeBE(4 + contentBytes.length);
    ver.writeTag(version || '0008');
    ver.writeBytes(contentBytes);
    const versionBytes = ver.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + versionBytes.length);
    w.writeTag('FGRP');
    w.writeBytes(versionBytes);
}

function serializeFFAM(w: BinaryWriter, fam: FloraFamily): void {
    const data = new BinaryWriter();
    data.writeInt32LE(fam.familyId);
    data.writeNullString(fam.familyName);
    data.writeByte(fam.red);
    data.writeByte(fam.green);
    data.writeByte(fam.blue);
    data.writeFloat32LE(fam.weight);
    data.writeUint32LE(fam.isAquatic);
    data.writeInt32LE(fam.children.length);
    for (const child of fam.children) {
        data.writeNullString(child.name);
        data.writeFloat32LE(child.var1);
        data.writeUint32LE(child.var2);
        data.writeFloat32LE(child.var3);
        data.writeFloat32LE(child.var4);
        data.writeUint32LE(child.var5);
        data.writeInt32LE(child.var6);
        data.writeFloat32LE(child.var7);
        data.writeFloat32LE(child.var8);
    }
    const dataBytes = data.toUint8Array();

    w.writeTag('FFAM');
    w.writeSizeBE(dataBytes.length);
    w.writeBytes(dataBytes);
}

function serializeRGRP(w: BinaryWriter, families: RadialFamily[], version?: string): void {
    const content = new BinaryWriter();
    for (const fam of families) {
        serializeRFAM(content, fam);
    }
    const contentBytes = content.toUint8Array();

    const ver = new BinaryWriter();
    ver.writeTag('FORM');
    ver.writeSizeBE(4 + contentBytes.length);
    ver.writeTag(version || '0003');
    ver.writeBytes(contentBytes);
    const versionBytes = ver.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + versionBytes.length);
    w.writeTag('RGRP');
    w.writeBytes(versionBytes);
}

function serializeRFAM(w: BinaryWriter, fam: RadialFamily): void {
    const data = new BinaryWriter();
    data.writeInt32LE(fam.familyId);
    data.writeNullString(fam.familyName);
    data.writeByte(fam.red);
    data.writeByte(fam.green);
    data.writeByte(fam.blue);
    data.writeFloat32LE(fam.weight);
    // NOTE: RadialFamily has NO isAquatic field
    data.writeInt32LE(fam.children.length);
    for (const child of fam.children) {
        data.writeNullString(child.name);
        data.writeFloat32LE(child.var1);
        data.writeFloat32LE(child.var2);  // float (not uint32)
        data.writeFloat32LE(child.var3);
        data.writeFloat32LE(child.var4);
        data.writeInt32LE(child.var5);
        data.writeFloat32LE(child.var6);
        data.writeFloat32LE(child.var7);
        data.writeInt32LE(child.var8);
        data.writeUint32LE(child.var9);
    }
    const dataBytes = data.toUint8Array();

    w.writeTag('RFAM');
    w.writeSizeBE(dataBytes.length);
    w.writeBytes(dataBytes);
}

function serializeEGRP(w: BinaryWriter, entries: EnvironmentEntry[], ver?: string, raw?: RawGroupData): void {
    const version = new BinaryWriter();
    const rawLen = raw?.rawContent?.length || 0;
    version.writeTag('FORM');
    version.writeSizeBE(4 + rawLen);
    version.writeTag(ver || '0002');
    if (raw?.rawContent?.length) {
        version.writeBytes(raw.rawContent);
    }
    const versionBytes = version.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + versionBytes.length);
    w.writeTag('EGRP');
    w.writeBytes(versionBytes);
}

function serializeMGRP(w: BinaryWriter, families: MapFamily[], ver?: string, raw?: RawGroupData): void {
    const version = new BinaryWriter();
    const rawLen = raw?.rawContent?.length || 0;
    version.writeTag('FORM');
    version.writeSizeBE(4 + rawLen);
    version.writeTag(ver || '0000');
    if (raw?.rawContent?.length) {
        version.writeBytes(raw.rawContent);
    }
    const versionBytes = version.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + versionBytes.length);
    w.writeTag('MGRP');
    w.writeBytes(versionBytes);
}

// --- Layer Serializer ---

function serializeLayer(w: BinaryWriter, layer: LAYLayer): void {
    const content = new BinaryWriter();

    // IHDR
    serializeIHDR(content, layer.enabled, layer.description);

    // ADTA
    const adta = new BinaryWriter();
    adta.writeUint32LE(layer.boundariesFlag);
    adta.writeUint32LE(layer.filterFlag);
    adta.writeUint32LE(layer.var3);
    // v0004 has an extra uint32 field BEFORE the string
    if (layer.var5 !== undefined) {
        adta.writeUint32LE(layer.var5);
    }
    adta.writeNullString(layer.var4);
    const adtaBytes = adta.toUint8Array();
    content.writeTag('ADTA');
    content.writeSizeBE(adtaBytes.length);
    content.writeBytes(adtaBytes);

    // Boundaries
    for (const boundary of layer.boundaries) {
        serializeBoundary(content, boundary);
    }

    // Affectors
    for (const affector of layer.affectors) {
        serializeAffector(content, affector);
    }

    // Filters
    for (const filter of layer.filters) {
        serializeFilter(content, filter);
    }

    // Child layers (recursive)
    for (const child of layer.children) {
        serializeLayer(content, child);
    }

    const contentBytes = content.toUint8Array();

    // FORM version (0003 or 0004)
    const version = new BinaryWriter();
    version.writeTag('FORM');
    version.writeSizeBE(4 + contentBytes.length);
    version.writeTag(layer.version || '0003');
    version.writeBytes(contentBytes);
    const versionBytes = version.toUint8Array();

    // FORM LAYR
    w.writeTag('FORM');
    w.writeSizeBE(4 + versionBytes.length);
    w.writeTag('LAYR');
    w.writeBytes(versionBytes);
}

function serializeIHDR(w: BinaryWriter, enabled: boolean, description: string): void {
    // Build DATA chunk content
    const data = new BinaryWriter();
    data.writeInt32LE(enabled ? 1 : 0);
    data.writeNullString(description);
    const dataBytes = data.toUint8Array();

    // Build FORM 0001
    const v = new BinaryWriter();
    v.writeTag('DATA');
    v.writeSizeBE(dataBytes.length);
    v.writeBytes(dataBytes);
    const vBytes = v.toUint8Array();

    const version = new BinaryWriter();
    version.writeTag('FORM');
    version.writeSizeBE(4 + vBytes.length);
    version.writeTag('0001');
    version.writeBytes(vBytes);
    const versionBytes = version.toUint8Array();

    // FORM IHDR
    w.writeTag('FORM');
    w.writeSizeBE(4 + versionBytes.length);
    w.writeTag('IHDR');
    w.writeBytes(versionBytes);
}

// --- Boundary Serializers ---

function serializeBoundary(w: BinaryWriter, boundary: LAYBoundary): void {
    switch (boundary.type) {
        case 'BCIR': return serializeBCIR(w, boundary);
        case 'BREC': return serializeBREC(w, boundary);
        case 'BPOL': return serializeBPOL(w, boundary);
        case 'BPLN': return serializeBPLN(w, boundary);
    }
}

function serializeBCIR(w: BinaryWriter, b: BoundaryCircle): void {
    const content = new BinaryWriter();

    serializeIHDR(content, b.enabled, b.description);

    const data = new BinaryWriter();
    data.writeFloat32LE(b.centerX);
    data.writeFloat32LE(b.centerY);
    data.writeFloat32LE(b.radius);
    data.writeInt32LE(b.featheringType);
    data.writeFloat32LE(b.featheringAmount);
    const dataBytes = data.toUint8Array();
    content.writeTag('DATA');
    content.writeSizeBE(dataBytes.length);
    content.writeBytes(dataBytes);

    const contentBytes = content.toUint8Array();

    // FORM 0002
    const version = new BinaryWriter();
    version.writeTag('FORM');
    version.writeSizeBE(4 + contentBytes.length);
    version.writeTag('0002');
    version.writeBytes(contentBytes);
    const versionBytes = version.toUint8Array();

    // FORM BCIR
    w.writeTag('FORM');
    w.writeSizeBE(4 + versionBytes.length);
    w.writeTag('BCIR');
    w.writeBytes(versionBytes);
}

function serializeBREC(w: BinaryWriter, b: BoundaryRectangle): void {
    const content = new BinaryWriter();

    serializeIHDR(content, b.enabled, b.description);

    const data = new BinaryWriter();
    data.writeFloat32LE(b.x0);
    data.writeFloat32LE(b.y0);
    data.writeFloat32LE(b.x1);
    data.writeFloat32LE(b.y1);
    data.writeInt32LE(b.featheringType);
    data.writeFloat32LE(b.featheringAmount);

    if (b.version === '0003') {
        data.writeInt32LE(b.localWaterTableEnabled ?? 0);
        data.writeInt32LE(b.localWaterTableVar7 ?? 0);
        data.writeFloat32LE(b.localWaterTableHeight ?? 0);
        data.writeFloat32LE(b.shaderSize ?? 0);
        data.writeNullString(b.shaderName ?? '');
    }

    const dataBytes = data.toUint8Array();
    content.writeTag('DATA');
    content.writeSizeBE(dataBytes.length);
    content.writeBytes(dataBytes);

    const contentBytes = content.toUint8Array();

    const version = new BinaryWriter();
    version.writeTag('FORM');
    version.writeSizeBE(4 + contentBytes.length);
    version.writeTag(b.version);
    version.writeBytes(contentBytes);
    const versionBytes = version.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + versionBytes.length);
    w.writeTag('BREC');
    w.writeBytes(versionBytes);
}

function serializeBPOL(w: BinaryWriter, b: BoundaryPolygon): void {
    const content = new BinaryWriter();

    serializeIHDR(content, b.enabled, b.description);

    const data = new BinaryWriter();
    data.writeInt32LE(b.vertices.length);
    for (const v of b.vertices) {
        data.writeFloat32LE(v.x);
        data.writeFloat32LE(v.y);
    }
    data.writeInt32LE(b.featheringType);
    data.writeFloat32LE(b.featheringAmount);
    if (b.localWaterTableEnabled !== undefined) {
        data.writeInt32LE(b.localWaterTableEnabled);
        data.writeFloat32LE(b.localWaterTableHeight ?? 0);
        data.writeFloat32LE(b.shaderSize ?? 0);
        data.writeNullString(b.shaderName ?? '');
    }
    const dataBytes = data.toUint8Array();
    content.writeTag('DATA');
    content.writeSizeBE(dataBytes.length);
    content.writeBytes(dataBytes);

    const contentBytes = content.toUint8Array();

    const version = new BinaryWriter();
    version.writeTag('FORM');
    version.writeSizeBE(4 + contentBytes.length);
    version.writeTag('0005');
    version.writeBytes(contentBytes);
    const versionBytes = version.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + versionBytes.length);
    w.writeTag('BPOL');
    w.writeBytes(versionBytes);
}

function serializeBPLN(w: BinaryWriter, b: BoundaryPolyline): void {
    const content = new BinaryWriter();

    serializeIHDR(content, b.enabled, b.description);

    const data = new BinaryWriter();
    data.writeInt32LE(b.vertices.length);
    for (const v of b.vertices) {
        data.writeFloat32LE(v.x);
        data.writeFloat32LE(v.y);
    }
    data.writeInt32LE(b.featheringType);
    data.writeFloat32LE(b.featheringAmount);
    data.writeFloat32LE(b.lineWidth);
    const dataBytes = data.toUint8Array();
    content.writeTag('DATA');
    content.writeSizeBE(dataBytes.length);
    content.writeBytes(dataBytes);

    const contentBytes = content.toUint8Array();

    const version = new BinaryWriter();
    version.writeTag('FORM');
    version.writeSizeBE(4 + contentBytes.length);
    version.writeTag('0001');
    version.writeBytes(contentBytes);
    const versionBytes = version.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + versionBytes.length);
    w.writeTag('BPLN');
    w.writeBytes(versionBytes);
}

// --- Affector Serializers ---

function serializeAffector(w: BinaryWriter, affector: LAYAffector): void {
    switch (affector.affectorType) {
        case 'AHCN': return serializeAHCN(w, affector as AffectorHeightConstant);
        case 'ASCN': return serializeASCN(w, affector as AffectorShaderConstant);
        case 'AFSN': return serializeAFSN(w, affector as AffectorFloraNonCollidableConstant);
        case 'AFSC': return serializeAFSC(w, affector as AffectorNoncollideFloraConstant);
        case 'AFDN': return serializeAFDN(w, affector as AffectorRadialConstant);
        case 'AFDF': return serializeAFDF(w, affector as AffectorRadialFarConstant);
        case 'AFCN': return serializeAFCN(w, affector as AffectorFCN);
        case 'ARCN': return serializeARCN(w, affector as AffectorRCN);
        case 'AENV': return serializeAENV(w, affector as AffectorEnvironment);
        case 'AEXC': return serializeAEXC(w, affector as AffectorExclude);
        case 'APAS': return serializeAPAS(w, affector as AffectorPassable);
        case 'AHTR': return serializeAHTR(w, affector as AffectorHeightTerrace);
        case 'AHFR': return serializeAHFR(w, affector as AffectorHeightFractal);
        case 'ACCN': return serializeACCN(w, affector as AffectorColorConstant);
        case 'ACRH': return serializeACRH(w, affector as AffectorColorRampHeight);
        case 'ACRF': return serializeACRF(w, affector as AffectorColorRampFractal);
        default:
            serializeGenericAffector(w, affector as AffectorGeneric);
    }
}

/** Helper: wrap IHDR + DATA in versioned FORM + outer FORM */
function serializeSimpleAffector(
    w: BinaryWriter, type: string, version: string,
    enabled: boolean, description: string,
    writeData: (dw: BinaryWriter) => void
): void {
    const content = new BinaryWriter();
    serializeIHDR(content, enabled, description);

    const data = new BinaryWriter();
    writeData(data);
    const dataBytes = data.toUint8Array();
    content.writeTag('DATA');
    content.writeSizeBE(dataBytes.length);
    content.writeBytes(dataBytes);

    const contentBytes = content.toUint8Array();

    const ver = new BinaryWriter();
    ver.writeTag('FORM');
    ver.writeSizeBE(4 + contentBytes.length);
    ver.writeTag(version);
    ver.writeBytes(contentBytes);
    const verBytes = ver.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + verBytes.length);
    w.writeTag(type);
    w.writeBytes(verBytes);
}

function serializeAHCN(w: BinaryWriter, a: AffectorHeightConstant): void {
    serializeSimpleAffector(w, 'AHCN', a.version || '0000', a.enabled, a.description, (d) => {
        d.writeInt32LE(a.operationType);
        d.writeFloat32LE(a.height);
    });
}

function serializeASCN(w: BinaryWriter, a: AffectorShaderConstant): void {
    serializeSimpleAffector(w, 'ASCN', a.version || '0001', a.enabled, a.description, (d) => {
        d.writeInt32LE(a.familyId);
        d.writeInt32LE(a.featheringType);
        d.writeFloat32LE(a.featheringAmount);
    });
}

function serializeAFSN(w: BinaryWriter, a: AffectorFloraNonCollidableConstant): void {
    serializeSimpleAffector(w, 'AFSN', a.version || '0004', a.enabled, a.description, (d) => {
        d.writeInt32LE(a.familyId);
        d.writeInt32LE(a.var2);
        d.writeInt32LE(a.flag);
        d.writeInt32LE(a.featheringType);
        d.writeFloat32LE(a.featheringAmount);
    });
}

function serializeAFSC(w: BinaryWriter, a: AffectorNoncollideFloraConstant): void {
    serializeSimpleAffector(w, 'AFSC', a.version || '0004', a.enabled, a.description, (d) => {
        d.writeInt32LE(a.familyId);
        d.writeInt32LE(a.var2);
        d.writeInt32LE(a.flag);
        d.writeInt32LE(a.featheringType);
        d.writeFloat32LE(a.featheringAmount);
    });
}

function serializeAFDN(w: BinaryWriter, a: AffectorRadialConstant): void {
    serializeSimpleAffector(w, 'AFDN', a.version || '0002', a.enabled, a.description, (d) => {
        d.writeInt32LE(a.familyId);
        d.writeInt32LE(a.var2);
        d.writeInt32LE(a.flag);
        d.writeInt32LE(a.featheringType);
        d.writeFloat32LE(a.featheringAmount);
    });
}

function serializeAFDF(w: BinaryWriter, a: AffectorRadialFarConstant): void {
    serializeSimpleAffector(w, 'AFDF', a.version || '0002', a.enabled, a.description, (d) => {
        d.writeInt32LE(a.familyId);
        d.writeInt32LE(a.var2);
        d.writeInt32LE(a.flag);
        d.writeInt32LE(a.featheringType);
        d.writeFloat32LE(a.featheringAmount);
    });
}

function serializeAFCN(w: BinaryWriter, a: AffectorFCN): void {
    serializeSimpleAffector(w, 'AFCN', a.version || '0002', a.enabled, a.description, (d) => {
        d.writeInt32LE(a.familyId);
        d.writeInt32LE(a.var2);
        d.writeInt32LE(a.flag);
        d.writeInt32LE(a.featheringType);
        d.writeFloat32LE(a.featheringAmount);
    });
}

function serializeARCN(w: BinaryWriter, a: AffectorRCN): void {
    serializeSimpleAffector(w, 'ARCN', a.version || '0002', a.enabled, a.description, (d) => {
        d.writeInt32LE(a.familyId);
        d.writeInt32LE(a.var2);
        d.writeInt32LE(a.flag);
        d.writeInt32LE(a.featheringType);
        d.writeFloat32LE(a.featheringAmount);
    });
}

function serializeAENV(w: BinaryWriter, a: AffectorEnvironment): void {
    serializeSimpleAffector(w, 'AENV', a.version || '0000', a.enabled, a.description, (d) => {
        d.writeInt32LE(a.environmentId);
        d.writeInt32LE(a.var2);
        d.writeFloat32LE(a.weight);
    });
}

function serializeAEXC(w: BinaryWriter, a: AffectorExclude): void {
    serializeSimpleAffector(w, 'AEXC', a.version || '0000', a.enabled, a.description, (_d) => {
        // Empty DATA chunk
    });
}

function serializeAPAS(w: BinaryWriter, a: AffectorPassable): void {
    serializeSimpleAffector(w, 'APAS', a.version || '0000', a.enabled, a.description, (d) => {
        d.writeByte(a.var1);
        d.writeInt32LE(a.var2);
    });
}

function serializeAHTR(w: BinaryWriter, a: AffectorHeightTerrace): void {
    serializeSimpleAffector(w, 'AHTR', a.version || '0004', a.enabled, a.description, (d) => {
        d.writeFloat32LE(a.flatRatio);
        d.writeFloat32LE(a.height);
    });
}

function serializeAHFR(w: BinaryWriter, a: AffectorHeightFractal): void {
    // AHFR uses FORM DATA > CHUNK PARM instead of CHUNK DATA
    const content = new BinaryWriter();
    serializeIHDR(content, a.enabled, a.description);

    // PARM data
    const parm = new BinaryWriter();
    parm.writeInt32LE(a.fractalId);
    parm.writeInt32LE(a.operationType);
    parm.writeFloat32LE(a.height);
    const parmBytes = parm.toUint8Array();

    // FORM DATA > CHUNK PARM
    const formData = new BinaryWriter();
    formData.writeTag('PARM');
    formData.writeSizeBE(parmBytes.length);
    formData.writeBytes(parmBytes);
    const formDataBytes = formData.toUint8Array();

    content.writeTag('FORM');
    content.writeSizeBE(4 + formDataBytes.length);
    content.writeTag('DATA');
    content.writeBytes(formDataBytes);

    const contentBytes = content.toUint8Array();

    const ver = new BinaryWriter();
    ver.writeTag('FORM');
    ver.writeSizeBE(4 + contentBytes.length);
    ver.writeTag(a.version || '0003');
    ver.writeBytes(contentBytes);
    const verBytes = ver.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + verBytes.length);
    w.writeTag('AHFR');
    w.writeBytes(verBytes);
}

function serializeACCN(w: BinaryWriter, a: AffectorColorConstant): void {
    serializeSimpleAffector(w, 'ACCN', a.version || '0000', a.enabled, a.description, (d) => {
        d.writeInt32LE(a.id);
        d.writeByte(a.red);
        d.writeByte(a.green);
        d.writeByte(a.blue);
    });
}

function serializeACRH(w: BinaryWriter, a: AffectorColorRampHeight): void {
    serializeSimpleAffector(w, 'ACRH', a.version || '0000', a.enabled, a.description, (d) => {
        d.writeInt32LE(a.familyId);
        d.writeFloat32LE(a.min);
        d.writeFloat32LE(a.max);
        d.writeNullString(a.shaderFile);
    });
}

function serializeACRF(w: BinaryWriter, a: AffectorColorRampFractal): void {
    const ver = a.version || '0000';
    if (ver === '0001') {
        // v0001: IHDR + FORM DATA > CHUNK PARM [familyId, var2(byte), shaderFile]
        const content = new BinaryWriter();
        serializeIHDR(content, a.enabled, a.description);

        const parm = new BinaryWriter();
        parm.writeInt32LE(a.familyId);
        parm.writeInt32LE(a.var2);
        parm.writeNullString(a.shaderFile);
        const parmBytes = parm.toUint8Array();

        const formData = new BinaryWriter();
        formData.writeTag('PARM');
        formData.writeSizeBE(parmBytes.length);
        formData.writeBytes(parmBytes);
        const formDataBytes = formData.toUint8Array();

        content.writeTag('FORM');
        content.writeSizeBE(4 + formDataBytes.length);
        content.writeTag('DATA');
        content.writeBytes(formDataBytes);

        const contentBytes = content.toUint8Array();
        const verForm = new BinaryWriter();
        verForm.writeTag('FORM');
        verForm.writeSizeBE(4 + contentBytes.length);
        verForm.writeTag(ver);
        verForm.writeBytes(contentBytes);
        const verBytes = verForm.toUint8Array();

        w.writeTag('FORM');
        w.writeSizeBE(4 + verBytes.length);
        w.writeTag('ACRF');
        w.writeBytes(verBytes);
    } else {
        // v0000: flat DATA chunk
        serializeSimpleAffector(w, 'ACRF', ver, a.enabled, a.description, (d) => {
            d.writeInt32LE(a.familyId);
            d.writeFloat32LE(a.var2);
            d.writeFloat32LE(a.var3 || 0);
            d.writeFloat32LE(a.var4 || 0);
            d.writeInt32LE(a.featheringType || 0);
            d.writeFloat32LE(a.featheringAmount || 0);
            d.writeNullString(a.shaderFile);
        });
    }
}

function serializeGenericAffector(w: BinaryWriter, a: AffectorGeneric): void {
    const content = new BinaryWriter();
    serializeIHDR(content, a.enabled, a.description);
    content.writeBytes(a.rawData);
    const contentBytes = content.toUint8Array();

    const ver = new BinaryWriter();
    ver.writeTag('FORM');
    ver.writeSizeBE(4 + contentBytes.length);
    ver.writeTag(a.version || '0000');
    ver.writeBytes(contentBytes);
    const verBytes = ver.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + verBytes.length);
    w.writeTag(a.affectorType);
    w.writeBytes(verBytes);
}

// --- Filter Serializer ---

function serializeFilter(w: BinaryWriter, filter: LAYFilter): void {
    const content = new BinaryWriter();
    serializeIHDR(content, filter.enabled, filter.description);
    content.writeBytes(filter.rawData);
    const contentBytes = content.toUint8Array();

    const ver = new BinaryWriter();
    ver.writeTag('FORM');
    ver.writeSizeBE(4 + contentBytes.length);
    ver.writeTag(filter.version || '0000');
    ver.writeBytes(contentBytes);
    const verBytes = ver.toUint8Array();

    w.writeTag('FORM');
    w.writeSizeBE(4 + verBytes.length);
    w.writeTag(filter.filterType);
    w.writeBytes(verBytes);
}

// ============================================================
// Convenience Builders
// ============================================================

/**
 * Create a minimal LAY file for a flat rectangular walkway tile.
 * This is the most common use case for the walkway builder.
 */
export function createWalkwayLAY(options: {
    width: number;          // meters (x axis)
    height: number;         // meters (y/z axis)
    flatten: boolean;       // flatten terrain to building height
    shaderFamilyId?: number;  // shader family ID for ground texture
    shaderFamilyName?: string;
    shaderFileName?: string;  // e.g. "terrain/naboo_cobblestone.sht"
    removeFlora?: boolean;
    featheringType?: number;  // 0=linear, 1=x², 2=sqrt(x), 3=smoothstep
    featheringAmount?: number; // 0.0-1.0
    description?: string;
}): LAYData {
    const w2 = options.width / 2;
    const h2 = options.height / 2;
    const desc = options.description || 'Walkway Tile';
    const featherType = options.featheringType ?? 3;
    const featherAmt = options.featheringAmount ?? 0.25;

    const shaderFamilies: ShaderFamily[] = [];
    const affectors: LAYAffector[] = [];

    // Add shader family if ground texture is specified
    if (options.shaderFileName) {
        const familyId = options.shaderFamilyId ?? 1;
        shaderFamilies.push({
            familyId,
            familyName: options.shaderFamilyName || 'Walkway',
            fileName: options.shaderFileName,
            red: 128, green: 128, blue: 128,
            var7: 0,
            weight: 1.0,
            children: [],
        });

        affectors.push({
            affectorType: 'ASCN',
            enabled: true,
            description: 'AffectorShaderConstant',
            familyId,
            featheringType: featherType,
            featheringAmount: featherAmt,
        });
    }

    // Flatten terrain
    if (options.flatten) {
        affectors.push({
            affectorType: 'AHCN',
            enabled: true,
            description: 'AffectorHeightConstant',
            operationType: 0,  // set/flatten
            height: 0,         // 0 = auto-set to current terrain height
        });
    }

    // Remove flora
    if (options.removeFlora) {
        affectors.push({
            affectorType: 'AFSN',
            enabled: true,
            description: 'AffectorFloraNonCollidableConstant',
            familyId: 1,
            var2: 1,
            flag: 1,  // remove
            featheringType: 0,
            featheringAmount: 1.0,
        });
        affectors.push({
            affectorType: 'AFSC',
            enabled: true,
            description: 'AffectorFloraCollidableConstant',
            familyId: 1,
            var2: 1,
            flag: 1,  // remove
            featheringType: 0,
            featheringAmount: 1.0,
        });
    }

    return {
        shaderFamilies,
        floraFamilies: [],
        radialFamilies: [],
        environmentEntries: [],
        mapFamilies: [],
        groupVersions: { sgrp: '0006', fgrp: '0008', rgrp: '0003', egrp: '0002', mgrp: '0000' },
        layers: [{
            enabled: true,
            description: desc,
            boundariesFlag: 0,
            filterFlag: 0,
            var3: 1,
            var4: '',
            boundaries: [{
                type: 'BREC',
                version: '0002',
                enabled: true,
                description: 'BoundaryRectangle',
                x0: -w2,
                y0: -h2,
                x1: w2,
                y1: h2,
                featheringType: featherType,
                featheringAmount: featherAmt,
            }],
            affectors,
            filters: [],
            children: [],
        }],
    };
}

/**
 * Create a minimal LAY file for a circular terrain modification area.
 */
export function createCircleLAY(options: {
    radius: number;
    flatten: boolean;
    shaderFamilyId?: number;
    shaderFamilyName?: string;
    shaderFileName?: string;
    removeFlora?: boolean;
    featheringType?: number;
    featheringAmount?: number;
    description?: string;
}): LAYData {
    const desc = options.description || 'Circle Modification';
    const featherType = options.featheringType ?? 3;
    const featherAmt = options.featheringAmount ?? 0.25;

    const shaderFamilies: ShaderFamily[] = [];
    const affectors: LAYAffector[] = [];

    if (options.shaderFileName) {
        const familyId = options.shaderFamilyId ?? 1;
        shaderFamilies.push({
            familyId,
            familyName: options.shaderFamilyName || 'Circle',
            fileName: options.shaderFileName,
            red: 128, green: 128, blue: 128,
            var7: 0,
            weight: 1.0,
            children: [],
        });
        affectors.push({
            affectorType: 'ASCN',
            enabled: true,
            description: 'AffectorShaderConstant',
            familyId,
            featheringType: featherType,
            featheringAmount: featherAmt,
        });
    }

    if (options.flatten) {
        affectors.push({
            affectorType: 'AHCN',
            enabled: true,
            description: 'AffectorHeightConstant',
            operationType: 0,
            height: 0,
        });
    }

    if (options.removeFlora) {
        affectors.push({
            affectorType: 'AFSN',
            enabled: true,
            description: 'AffectorFloraNonCollidableConstant',
            familyId: 1, var2: 1, flag: 1,
            featheringType: 0, featheringAmount: 1.0,
        });
        affectors.push({
            affectorType: 'AFSC',
            enabled: true,
            description: 'AffectorFloraCollidableConstant',
            familyId: 1, var2: 1, flag: 1,
            featheringType: 0, featheringAmount: 1.0,
        });
    }

    return {
        shaderFamilies,
        floraFamilies: [],
        radialFamilies: [],
        environmentEntries: [],
        mapFamilies: [],
        groupVersions: { sgrp: '0006', fgrp: '0008', rgrp: '0003', egrp: '0002', mgrp: '0000' },
        layers: [{
            enabled: true,
            description: desc,
            boundariesFlag: 0,
            filterFlag: 0,
            var3: 1,
            var4: '',
            boundaries: [{
                type: 'BCIR',
                enabled: true,
                description: 'BoundaryCircle',
                centerX: 0,
                centerY: 0,
                radius: options.radius,
                featheringType: featherType,
                featheringAmount: featherAmt,
            }],
            affectors,
            filters: [],
            children: [],
        }],
    };
}
