/**
 * IFF Builder - creates APT, SHT, and object IFF files from scratch
 */

import * as fs from 'fs';
import * as path from 'path';
import { encodeASCII, writeTag } from './iffUtils';

// ─── Helper: build an IFF binary buffer ─────────────────────────────────────

function writeBE32(buf: Uint8Array, pos: number, val: number): void {
    buf[pos]     = (val >>> 24) & 0xFF;
    buf[pos + 1] = (val >>> 16) & 0xFF;
    buf[pos + 2] = (val >>> 8) & 0xFF;
    buf[pos + 3] = val & 0xFF;
}

function writeLE32(buf: Uint8Array, pos: number, val: number): void {
    buf[pos]     = val & 0xFF;
    buf[pos + 1] = (val >>> 8) & 0xFF;
    buf[pos + 2] = (val >>> 16) & 0xFF;
    buf[pos + 3] = (val >>> 24) & 0xFF;
}

function writeFloat32LE(buf: Uint8Array, pos: number, val: number): void {
    const dv = new DataView(buf.buffer, buf.byteOffset);
    dv.setFloat32(pos, val, true);
}

/** Build a chunk: TAG(4) + size(4, BE) + data */
function buildChunk(tag: string, data: Uint8Array): Uint8Array {
    const result = new Uint8Array(8 + data.length);
    writeTag(result, 0, tag);
    writeBE32(result, 4, data.length);
    result.set(data, 8);
    return result;
}

/** Build a FORM: FORM(4) + size(4, BE) + formName(4) + children */
function buildForm(formName: string, children: Uint8Array[]): Uint8Array {
    const childrenSize = children.reduce((s, c) => s + c.length, 0);
    const totalSize = 4 + childrenSize; // formName + children
    const result = new Uint8Array(8 + totalSize);
    writeTag(result, 0, 'FORM');
    writeBE32(result, 4, totalSize);
    writeTag(result, 8, formName);
    let pos = 12;
    for (const child of children) {
        result.set(child, pos);
        pos += child.length;
    }
    return result;
}

/** Encode a null-terminated ASCII string */
function nullStr(s: string): Uint8Array {
    const bytes = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) {
        bytes[i] = s.charCodeAt(i);
    }
    bytes[s.length] = 0;
    return bytes;
}

// ─── APT (Appearance Template) ──────────────────────────────────────────────

/**
 * Create an APT file (FORM HAPT → FORM 0000 → NAME chunk with mesh path).
 * Typically ~80 bytes.
 */
export function createAPT(meshPath: string): Uint8Array {
    const nameChunk = buildChunk('NAME', nullStr(meshPath));
    const inner = buildForm('0000', [nameChunk]);
    return buildForm('HAPT', [inner]);
}

// ─── SHT (Shader Template) ─────────────────────────────────────────────────

/**
 * Create an SHT file for a painting/rug/banner texture.
 * Structure: FORM SSHT → FORM 0000 → [FORM MATS, FORM TXMS, FORM TCSS, NAME(effect)]
 *
 * Material properties: standard flat matte white (1.0 RGBA diffuse).
 */
export function createSHT(texturePath: string, effectPath: string = 'effect\\a_simple.eft'): Uint8Array {
    // TAG chunk inside MATS → "NIAM" (= "MAIN" reversed, identifies main material)
    const tagChunk = buildChunk('TAG ', encodeASCII('NIAM'));

    // MATL chunk: 17 floats (68 bytes) of material properties
    const matlData = new Uint8Array(68);
    // Diffuse RGBA: 1.0, 1.0, 1.0, 1.0
    writeFloat32LE(matlData, 0, 1.0);
    writeFloat32LE(matlData, 4, 1.0);
    writeFloat32LE(matlData, 8, 1.0);
    writeFloat32LE(matlData, 12, 1.0);
    // Ambient RGBA: 1.0, 1.0, 1.0, 1.0
    writeFloat32LE(matlData, 16, 1.0);
    writeFloat32LE(matlData, 20, 1.0);
    writeFloat32LE(matlData, 24, 1.0);
    writeFloat32LE(matlData, 28, 1.0);
    // Emissive: 0.0, 0.0, 0.0, 0.0
    writeFloat32LE(matlData, 32, 0.0);
    writeFloat32LE(matlData, 36, 0.0);
    writeFloat32LE(matlData, 40, 0.0);
    writeFloat32LE(matlData, 44, 0.0);
    // Specular power: 1.0
    writeFloat32LE(matlData, 48, 1.0);
    // Specular color: 0.25, 0.25, 0.25
    writeFloat32LE(matlData, 52, 0.25);
    writeFloat32LE(matlData, 56, 0.25);
    writeFloat32LE(matlData, 60, 0.25);
    // Shininess: 20.0
    writeFloat32LE(matlData, 64, 20.0);

    const matlChunk = buildChunk('MATL', matlData);
    const matsInner = buildForm('0000', [tagChunk, matlChunk]);
    const mats = buildForm('MATS', [matsInner]);

    // TXMS → STXM → 0001 → [DATA, NAME(texture)]
    // DATA chunk: "NIAM" + padding + flags
    const txmDataBuf = new Uint8Array(11);
    // "NIAM"
    txmDataBuf[0] = 0x4E; txmDataBuf[1] = 0x49; txmDataBuf[2] = 0x41; txmDataBuf[3] = 0x4D;
    txmDataBuf[4] = 0x00;
    txmDataBuf[5] = 0x00;
    txmDataBuf[6] = 0x00;
    txmDataBuf[7] = 0x02;
    txmDataBuf[8] = 0x02;
    txmDataBuf[9] = 0x02;
    txmDataBuf[10] = 0x00;
    const txmData = buildChunk('DATA', txmDataBuf);
    const txmName = buildChunk('NAME', nullStr(texturePath));
    const txm0001 = buildForm('0001', [txmData, txmName]);
    const stxm = buildForm('STXM', [txm0001]);
    const txms = buildForm('TXMS', [stxm]);

    // TCSS → 0000 (empty)
    const tcssInner = buildForm('0000', []);
    const tcss = buildForm('TCSS', [tcssInner]);

    // Effect NAME chunk
    const effectName = buildChunk('NAME', nullStr(effectPath));

    // Wrap everything in FORM 0000 → FORM SSHT
    const inner = buildForm('0000', [mats, txms, tcss, effectName]);
    return buildForm('SSHT', [inner]);
}

// ─── Object IFF (clone + patch approach) ────────────────────────────────────

/**
 * Clone an existing painting/rug IFF object template, patching:
 * - appearanceFilename → new appearance path
 * - objectName → new string reference (@art_n:key)
 * - detailedDescription → new string reference (@art_d:key)
 *
 * This does binary search-and-replace on the raw bytes since the IFF object
 * template structure (STOT with ~80 properties) is complex to build from scratch.
 */
export function cloneAndPatchObjectIFF(
    templateIffPath: string,
    newAppearancePath: string,
    newNameRef: string,
    newDescRef: string
): Uint8Array {
    const original = new Uint8Array(fs.readFileSync(templateIffPath));

    // Find and extract current property values using the IFF parser
    const { parseIFF, findForm, serializeIFF, updateStringProperty } = require('./iffUtils');
    const root = parseIFF(original);

    // Update the three key properties
    updateStringProperty(root, 'appearanceFilename', newAppearancePath);
    updateStringProperty(root, 'objectName', newNameRef);
    updateStringProperty(root, 'detailedDescription', newDescRef);

    return serializeIFF(root);
}

/**
 * Find a suitable template IFF to clone from the vanilla TRE.
 * Searches for an existing painting IFF to use as a base.
 */
export function findTemplateIFF(workspaceRoot: string): string | null {
    const searchDirs = [
        path.join(workspaceRoot, 'tre/working/object/tangible/painting'),
        path.join(workspaceRoot, 'tre/vanilla/object/tangible/painting'),
    ];

    for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.startsWith('shared_') && f.endsWith('.iff'));
        if (files.length > 0) {
            return path.join(dir, files[0]);
        }
    }

    return null;
}
