/**
 * SWG Palette (.pal) Parser/Writer
 *
 * Palette files use the Microsoft RIFF PAL format:
 *   RIFF header (4 bytes: "RIFF")
 *   uint32 LE total size
 *   "PAL " type (4 bytes)
 *   "data" chunk tag (4 bytes)
 *   uint32 LE data size
 *   uint16 LE version (always 0x0300)
 *   uint16 LE color count
 *   N x { uint8 R, uint8 G, uint8 B, uint8 flags }
 *
 * SWG uses the flags byte as 0x00 (not alpha).
 * Palette indices 0..N-1 are what gets stored in customization variables.
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface PaletteColor {
    r: number;
    g: number;
    b: number;
    flags: number;  // typically 0 in SWG
}

export interface PaletteData {
    colors: PaletteColor[];
    version: number;   // typically 0x0300
}

// ─── Parse ──────────────────────────────────────────────────────────────────────

/**
 * Parse a RIFF PAL file into color data
 */
export function parsePalette(data: Uint8Array): PaletteData {
    if (data.length < 24) throw new Error('File too small for RIFF PAL');

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Check RIFF header
    const riff = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (riff !== 'RIFF') throw new Error(`Not a RIFF file (got "${riff}")`);

    // Check PAL type
    const palType = String.fromCharCode(data[8], data[9], data[10], data[11]);
    if (palType !== 'PAL ') throw new Error(`Not a PAL file (got "${palType}")`);

    // Check data chunk
    const dataTag = String.fromCharCode(data[12], data[13], data[14], data[15]);
    if (dataTag !== 'data') throw new Error(`Missing data chunk (got "${dataTag}")`);

    const dataSize = view.getUint32(16, true);

    // Version + count at offset 20
    const version = view.getUint16(20, true);
    const colorCount = view.getUint16(22, true);

    const colors: PaletteColor[] = [];
    for (let i = 0; i < colorCount; i++) {
        const offset = 24 + i * 4;
        if (offset + 3 >= data.length) break;
        colors.push({
            r: data[offset],
            g: data[offset + 1],
            b: data[offset + 2],
            flags: data[offset + 3]
        });
    }

    return { colors, version };
}

/**
 * Serialize palette data back to RIFF PAL binary
 */
export function serializePalette(palette: PaletteData): Uint8Array {
    const colorCount = palette.colors.length;
    const dataSize = 4 + colorCount * 4;  // version(2) + count(2) + N*4
    const totalSize = 4 + 4 + 4 + dataSize;  // "PAL " + "data" + dataSize + data
    const fileSize = 4 + totalSize;  // "RIFF" + size + content

    const result = new Uint8Array(8 + totalSize);
    const view = new DataView(result.buffer);

    // RIFF header
    result[0] = 0x52; result[1] = 0x49; result[2] = 0x46; result[3] = 0x46; // "RIFF"
    view.setUint32(4, totalSize, true);

    // PAL type
    result[8] = 0x50; result[9] = 0x41; result[10] = 0x4C; result[11] = 0x20; // "PAL "

    // data chunk
    result[12] = 0x64; result[13] = 0x61; result[14] = 0x74; result[15] = 0x61; // "data"
    view.setUint32(16, dataSize, true);

    // Version + count
    view.setUint16(20, palette.version || 0x0300, true);
    view.setUint16(22, colorCount, true);

    // Colors
    for (let i = 0; i < colorCount; i++) {
        const offset = 24 + i * 4;
        const c = palette.colors[i];
        result[offset] = c.r;
        result[offset + 1] = c.g;
        result[offset + 2] = c.b;
        result[offset + 3] = c.flags;
    }

    return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Convert a palette color to CSS hex string
 */
export function colorToHex(color: PaletteColor): string {
    return '#' +
        color.r.toString(16).padStart(2, '0') +
        color.g.toString(16).padStart(2, '0') +
        color.b.toString(16).padStart(2, '0');
}

/**
 * Convert a palette color to CSS rgb() string
 */
export function colorToRGB(color: PaletteColor): string {
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

/**
 * Create a simple palette from an array of hex colors (e.g. ["#ff0000", "#00ff00"])
 */
export function createPaletteFromHex(hexColors: string[]): PaletteData {
    const colors: PaletteColor[] = hexColors.map(hex => {
        const clean = hex.replace('#', '');
        return {
            r: parseInt(clean.substring(0, 2), 16),
            g: parseInt(clean.substring(2, 4), 16),
            b: parseInt(clean.substring(4, 6), 16),
            flags: 0
        };
    });
    return { colors, version: 0x0300 };
}
