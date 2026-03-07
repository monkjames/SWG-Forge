/**
 * DDS Codec - Pure TypeScript DXT1/DXT5 decode + encode + mipmap generation.
 * Decoder adapted from vscode-appearance-chain/src/ddsDecoder.ts.
 * Encoder uses bounding-box endpoint selection (sufficient quality for SWG textures).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DDSInfo {
    width: number;
    height: number;
    mipCount: number;
    fourCC: string;
    fileSize: number;
}

export interface DDSImage {
    info: DDSInfo;
    rgba: Uint8Array;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DDS_MAGIC = 0x20534444; // "DDS "

// Max texture size we'll attempt to decode (2048x2048 = 16MB RGBA)
const MAX_DIMENSION = 2048;
const MAX_PIXELS = MAX_DIMENSION * MAX_DIMENSION;

// Header flags matching real SWG DDS files
const DDSD_FLAGS = 0x000A1007;  // CAPS|HEIGHT|WIDTH|PIXELFORMAT|MIPMAPCOUNT|LINEARSIZE
const DDPF_FOURCC = 0x00000004;
const DDSCAPS = 0x00401008;     // COMPLEX|TEXTURE|MIPMAP

// ─── Header Parsing ──────────────────────────────────────────────────────────

interface DDSHeader {
    width: number;
    height: number;
    mipCount: number;
    fourCC: string;
    pfFlags: number;
    rgbBitCount: number;
    rMask: number;
    gMask: number;
    bMask: number;
    aMask: number;
}

function parseHeader(data: Uint8Array): DDSHeader | null {
    if (data.length < 128) { return null; }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    if (view.getUint32(0, true) !== DDS_MAGIC) { return null; }

    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    const mipCount = view.getUint32(28, true) || 1;

    const pfFlags = view.getUint32(80, true);

    let fourCC = '';
    if (pfFlags & DDPF_FOURCC) {
        fourCC = String.fromCharCode(data[84], data[85], data[86], data[87]);
    }

    const rgbBitCount = view.getUint32(88, true);
    const rMask = view.getUint32(92, true);
    const gMask = view.getUint32(96, true);
    const bMask = view.getUint32(100, true);
    const aMask = view.getUint32(104, true);

    return { width, height, mipCount, fourCC, pfFlags, rgbBitCount, rMask, gMask, bMask, aMask };
}

// ─── DXT Decoding ────────────────────────────────────────────────────────────

function decodeDXT1Block(data: Uint8Array, offset: number): Uint8Array {
    const pixels = new Uint8Array(64); // 16 pixels * 4 channels
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const c0 = view.getUint16(offset, true);
    const c1 = view.getUint16(offset + 2, true);

    const r0 = ((c0 >> 11) & 0x1F) * 255 / 31;
    const g0 = ((c0 >> 5) & 0x3F) * 255 / 63;
    const b0 = (c0 & 0x1F) * 255 / 31;
    const r1 = ((c1 >> 11) & 0x1F) * 255 / 31;
    const g1 = ((c1 >> 5) & 0x3F) * 255 / 63;
    const b1 = (c1 & 0x1F) * 255 / 31;

    const colors: number[][] = [
        [Math.round(r0), Math.round(g0), Math.round(b0), 255],
        [Math.round(r1), Math.round(g1), Math.round(b1), 255],
        [0, 0, 0, 255],
        [0, 0, 0, 0]
    ];

    if (c0 > c1) {
        colors[2] = [Math.round((2 * r0 + r1) / 3), Math.round((2 * g0 + g1) / 3), Math.round((2 * b0 + b1) / 3), 255];
        colors[3] = [Math.round((r0 + 2 * r1) / 3), Math.round((g0 + 2 * g1) / 3), Math.round((b0 + 2 * b1) / 3), 255];
    } else {
        colors[2] = [Math.round((r0 + r1) / 2), Math.round((g0 + g1) / 2), Math.round((b0 + b1) / 2), 255];
        colors[3] = [0, 0, 0, 0];
    }

    const bits = view.getUint32(offset + 4, true);
    for (let i = 0; i < 16; i++) {
        const ci = (bits >> (i * 2)) & 0x3;
        const pi = i * 4;
        pixels[pi] = colors[ci][0];
        pixels[pi + 1] = colors[ci][1];
        pixels[pi + 2] = colors[ci][2];
        pixels[pi + 3] = colors[ci][3];
    }

    return pixels;
}

function decodeDXT5Block(data: Uint8Array, offset: number): Uint8Array {
    const pixels = new Uint8Array(64);

    // Alpha block (8 bytes)
    const a0 = data[offset];
    const a1 = data[offset + 1];

    const alphaTable = new Uint8Array(8);
    alphaTable[0] = a0;
    alphaTable[1] = a1;
    if (a0 > a1) {
        for (let i = 0; i < 6; i++) {
            alphaTable[2 + i] = Math.round(((6 - i) * a0 + (1 + i) * a1) / 7);
        }
    } else {
        for (let i = 0; i < 4; i++) {
            alphaTable[2 + i] = Math.round(((4 - i) * a0 + (1 + i) * a1) / 5);
        }
        alphaTable[6] = 0;
        alphaTable[7] = 255;
    }

    // Extract 3-bit alpha indices from 6 bytes
    const alphaBytes = [
        data[offset + 2], data[offset + 3], data[offset + 4],
        data[offset + 5], data[offset + 6], data[offset + 7]
    ];
    const alphaIndices = new Uint8Array(16);
    let alphaBitPos = 0;
    for (let i = 0; i < 16; i++) {
        const byteIdx = Math.floor(alphaBitPos / 8);
        const bitIdx = alphaBitPos % 8;
        if (bitIdx <= 5) {
            alphaIndices[i] = (alphaBytes[byteIdx] >> bitIdx) & 0x7;
        } else {
            alphaIndices[i] = ((alphaBytes[byteIdx] >> bitIdx) | ((alphaBytes[byteIdx + 1] || 0) << (8 - bitIdx))) & 0x7;
        }
        alphaBitPos += 3;
    }

    // Color block (8 bytes at offset+8)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const c0 = view.getUint16(offset + 8, true);
    const c1 = view.getUint16(offset + 10, true);

    const r0 = ((c0 >> 11) & 0x1F) * 255 / 31;
    const g0 = ((c0 >> 5) & 0x3F) * 255 / 63;
    const b0 = (c0 & 0x1F) * 255 / 31;
    const r1 = ((c1 >> 11) & 0x1F) * 255 / 31;
    const g1 = ((c1 >> 5) & 0x3F) * 255 / 63;
    const b1 = (c1 & 0x1F) * 255 / 31;

    const colors = [
        [Math.round(r0), Math.round(g0), Math.round(b0)],
        [Math.round(r1), Math.round(g1), Math.round(b1)],
        [Math.round((2 * r0 + r1) / 3), Math.round((2 * g0 + g1) / 3), Math.round((2 * b0 + b1) / 3)],
        [Math.round((r0 + 2 * r1) / 3), Math.round((g0 + 2 * g1) / 3), Math.round((b0 + 2 * b1) / 3)]
    ];

    const colorBits = view.getUint32(offset + 12, true);

    for (let i = 0; i < 16; i++) {
        const ci = (colorBits >> (i * 2)) & 0x3;
        const pi = i * 4;
        pixels[pi] = colors[ci][0];
        pixels[pi + 1] = colors[ci][1];
        pixels[pi + 2] = colors[ci][2];
        pixels[pi + 3] = alphaTable[alphaIndices[i]];
    }

    return pixels;
}

function decompressUncompressed(data: Uint8Array, header: DDSHeader): Uint8Array {
    const { width, height, rgbBitCount, rMask, gMask, bMask, aMask } = header;
    const rgba = new Uint8Array(width * height * 4);
    const pixelData = data.subarray(128);
    const bytesPerPixel = rgbBitCount / 8;

    // Find shift amounts from masks
    function maskShift(mask: number): { shift: number; bits: number } {
        if (mask === 0) { return { shift: 0, bits: 0 }; }
        let shift = 0;
        let m = mask;
        while ((m & 1) === 0) { shift++; m >>= 1; }
        let bits = 0;
        while (m & 1) { bits++; m >>= 1; }
        return { shift, bits };
    }

    const rs = maskShift(rMask);
    const gs = maskShift(gMask);
    const bs = maskShift(bMask);
    const as = maskShift(aMask);

    const view = new DataView(pixelData.buffer, pixelData.byteOffset, pixelData.byteLength);

    for (let i = 0; i < width * height; i++) {
        const off = i * bytesPerPixel;
        if (off + bytesPerPixel > pixelData.length) { break; }

        let pixel: number;
        if (bytesPerPixel === 4) {
            pixel = view.getUint32(off, true);
        } else if (bytesPerPixel === 3) {
            pixel = pixelData[off] | (pixelData[off + 1] << 8) | (pixelData[off + 2] << 16);
        } else if (bytesPerPixel === 2) {
            pixel = view.getUint16(off, true);
        } else {
            pixel = pixelData[off];
        }

        const r = rs.bits > 0 ? Math.round(((pixel & rMask) >>> rs.shift) * 255 / ((1 << rs.bits) - 1)) : 0;
        const g = gs.bits > 0 ? Math.round(((pixel & gMask) >>> gs.shift) * 255 / ((1 << gs.bits) - 1)) : 0;
        const b = bs.bits > 0 ? Math.round(((pixel & bMask) >>> bs.shift) * 255 / ((1 << bs.bits) - 1)) : 0;
        const a = as.bits > 0 ? Math.round(((pixel & aMask) >>> as.shift) * 255 / ((1 << as.bits) - 1)) : 255;

        const di = i * 4;
        rgba[di] = r;
        rgba[di + 1] = g;
        rgba[di + 2] = b;
        rgba[di + 3] = a;
    }

    return rgba;
}

function decompress(data: Uint8Array, header: DDSHeader): Uint8Array {
    const { width, height, fourCC } = header;

    // Handle uncompressed formats
    if (!fourCC && header.rgbBitCount > 0) {
        return decompressUncompressed(data, header);
    }

    const rgba = new Uint8Array(width * height * 4);
    const pixelData = data.subarray(128);

    const blocksX = Math.max(1, Math.ceil(width / 4));
    const blocksY = Math.max(1, Math.ceil(height / 4));
    const blockSize = (fourCC === 'DXT1') ? 8 : 16;

    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const blockIdx = by * blocksX + bx;
            const blockOff = blockIdx * blockSize;

            if (blockOff + blockSize > pixelData.length) { break; }

            let pixels: Uint8Array;
            if (fourCC === 'DXT1') {
                pixels = decodeDXT1Block(pixelData, blockOff);
            } else {
                // DXT3 and DXT5 both use 16-byte blocks; DXT5 decoder handles both
                pixels = decodeDXT5Block(pixelData, blockOff);
            }

            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const destX = bx * 4 + px;
                    const destY = by * 4 + py;
                    if (destX >= width || destY >= height) { continue; }
                    const srcIdx = (py * 4 + px) * 4;
                    const destIdx = (destY * width + destX) * 4;
                    rgba[destIdx] = pixels[srcIdx];
                    rgba[destIdx + 1] = pixels[srcIdx + 1];
                    rgba[destIdx + 2] = pixels[srcIdx + 2];
                    rgba[destIdx + 3] = pixels[srcIdx + 3];
                }
            }
        }
    }

    return rgba;
}

// ─── DXT Encoding ────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

function toRGB565(r: number, g: number, b: number): number {
    const r5 = Math.round(r * 31 / 255);
    const g6 = Math.round(g * 63 / 255);
    const b5 = Math.round(b * 31 / 255);
    return (r5 << 11) | (g6 << 5) | b5;
}

function fromRGB565(c: number): [number, number, number] {
    const r = Math.round(((c >> 11) & 0x1F) * 255 / 31);
    const g = Math.round(((c >> 5) & 0x3F) * 255 / 63);
    const b = Math.round((c & 0x1F) * 255 / 31);
    return [r, g, b];
}

/**
 * Extract 16 RGBA pixels for the 4x4 block at (bx*4, by*4).
 * Clamps to image edges.
 */
function extractBlock(rgba: Uint8Array, w: number, h: number, bx: number, by: number): Uint8Array {
    const block = new Uint8Array(64); // 16 pixels * 4 channels
    for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
            const sx = Math.min(bx * 4 + px, w - 1);
            const sy = Math.min(by * 4 + py, h - 1);
            const si = (sy * w + sx) * 4;
            const di = (py * 4 + px) * 4;
            block[di] = rgba[si];
            block[di + 1] = rgba[si + 1];
            block[di + 2] = rgba[si + 2];
            block[di + 3] = rgba[si + 3];
        }
    }
    return block;
}

/**
 * Find best two RGB565 endpoints using bounding-box diagonal.
 * Returns [color0, color1] where color0 > color1 (4-color mode).
 */
function findColorEndpoints(block: Uint8Array): [number, number] {
    let minR = 255, minG = 255, minB = 255;
    let maxR = 0, maxG = 0, maxB = 0;

    for (let i = 0; i < 16; i++) {
        const r = block[i * 4];
        const g = block[i * 4 + 1];
        const b = block[i * 4 + 2];
        if (r < minR) { minR = r; }
        if (g < minG) { minG = g; }
        if (b < minB) { minB = b; }
        if (r > maxR) { maxR = r; }
        if (g > maxG) { maxG = g; }
        if (b > maxB) { maxB = b; }
    }

    // Inset the bounding box slightly for better quality
    const insetR = Math.round((maxR - minR) / 16);
    const insetG = Math.round((maxG - minG) / 16);
    const insetB = Math.round((maxB - minB) / 16);
    minR = clamp(minR + insetR, 0, 255);
    minG = clamp(minG + insetG, 0, 255);
    minB = clamp(minB + insetB, 0, 255);
    maxR = clamp(maxR - insetR, 0, 255);
    maxG = clamp(maxG - insetG, 0, 255);
    maxB = clamp(maxB - insetB, 0, 255);

    let c0 = toRGB565(maxR, maxG, maxB);
    let c1 = toRGB565(minR, minG, minB);

    // Ensure c0 > c1 for 4-color mode
    if (c0 < c1) {
        const tmp = c0; c0 = c1; c1 = tmp;
    }
    if (c0 === c1) {
        // Nudge to ensure 4-color mode
        if (c0 < 0xFFFF) { c0++; } else { c1--; }
    }

    return [c0, c1];
}

function squaredDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
    const dr = r1 - r2;
    const dg = g1 - g2;
    const db = b1 - b2;
    return dr * dr + dg * dg + db * db;
}

/**
 * Encode a 4x4 block as DXT1 (8 bytes).
 */
function encodeDXT1Block(block: Uint8Array): Uint8Array {
    const out = new Uint8Array(8);
    const view = new DataView(out.buffer);

    // Check if any pixel has transparency
    let hasAlpha = false;
    for (let i = 0; i < 16; i++) {
        if (block[i * 4 + 3] < 128) { hasAlpha = true; break; }
    }

    const [ep0, ep1] = findColorEndpoints(block);
    let c0 = ep0, c1 = ep1;

    if (hasAlpha) {
        // Use c0 <= c1 mode for transparency
        if (c0 > c1) { const t = c0; c0 = c1; c1 = t; }
        if (c0 === c1 && c0 > 0) { c0--; }
    }

    const [r0, g0, b0] = fromRGB565(c0);
    const [r1, g1, b1] = fromRGB565(c1);

    // Build palette
    const palette: number[][] = [[r0, g0, b0], [r1, g1, b1]];
    if (c0 > c1) {
        palette.push([Math.round((2 * r0 + r1) / 3), Math.round((2 * g0 + g1) / 3), Math.round((2 * b0 + b1) / 3)]);
        palette.push([Math.round((r0 + 2 * r1) / 3), Math.round((g0 + 2 * g1) / 3), Math.round((b0 + 2 * b1) / 3)]);
    } else {
        palette.push([Math.round((r0 + r1) / 2), Math.round((g0 + g1) / 2), Math.round((b0 + b1) / 2)]);
        palette.push([0, 0, 0]); // transparent
    }

    // Assign indices
    let indices = 0;
    for (let i = 0; i < 16; i++) {
        const r = block[i * 4];
        const g = block[i * 4 + 1];
        const b = block[i * 4 + 2];
        const a = block[i * 4 + 3];

        let bestIdx = 0;
        if (hasAlpha && a < 128) {
            bestIdx = 3; // transparent
        } else {
            let bestDist = Infinity;
            const limit = hasAlpha ? 3 : 4; // don't pick transparent index for opaque pixels
            for (let ci = 0; ci < limit; ci++) {
                const d = squaredDist(r, g, b, palette[ci][0], palette[ci][1], palette[ci][2]);
                if (d < bestDist) { bestDist = d; bestIdx = ci; }
            }
        }
        indices |= (bestIdx << (i * 2));
    }

    view.setUint16(0, c0, true);
    view.setUint16(2, c1, true);
    view.setUint32(4, indices, true);

    return out;
}

/**
 * Encode a 4x4 block as DXT5 (16 bytes): 8 alpha + 8 color.
 */
function encodeDXT5Block(block: Uint8Array): Uint8Array {
    const out = new Uint8Array(16);
    const view = new DataView(out.buffer);

    // ── Alpha encoding (bytes 0-7) ──
    let minA = 255, maxA = 0;
    for (let i = 0; i < 16; i++) {
        const a = block[i * 4 + 3];
        if (a < minA) { minA = a; }
        if (a > maxA) { maxA = a; }
    }

    let alpha0 = maxA;
    let alpha1 = minA;

    // Build 8-level alpha table (alpha0 > alpha1 mode)
    const alphaTable = new Uint8Array(8);
    alphaTable[0] = alpha0;
    alphaTable[1] = alpha1;
    if (alpha0 > alpha1) {
        for (let i = 0; i < 6; i++) {
            alphaTable[2 + i] = Math.round(((6 - i) * alpha0 + (1 + i) * alpha1) / 7);
        }
    } else {
        // alpha0 == alpha1, all indices will be 0
        for (let i = 2; i < 8; i++) { alphaTable[i] = alpha0; }
    }

    // Assign alpha indices
    const alphaIndices = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        const a = block[i * 4 + 3];
        let bestIdx = 0;
        let bestDist = Math.abs(a - alphaTable[0]);
        for (let ai = 1; ai < 8; ai++) {
            const d = Math.abs(a - alphaTable[ai]);
            if (d < bestDist) { bestDist = d; bestIdx = ai; }
        }
        alphaIndices[i] = bestIdx;
    }

    // Pack alpha: 2 endpoint bytes + 6 index bytes (48 bits)
    out[0] = alpha0;
    out[1] = alpha1;

    // Pack 16 x 3-bit indices into 6 bytes (two groups of 24 bits)
    let bits = 0;
    for (let i = 0; i < 8; i++) {
        bits |= (alphaIndices[i] & 0x7) << (i * 3);
    }
    out[2] = bits & 0xFF;
    out[3] = (bits >> 8) & 0xFF;
    out[4] = (bits >> 16) & 0xFF;

    bits = 0;
    for (let i = 0; i < 8; i++) {
        bits |= (alphaIndices[8 + i] & 0x7) << (i * 3);
    }
    out[5] = bits & 0xFF;
    out[6] = (bits >> 8) & 0xFF;
    out[7] = (bits >> 16) & 0xFF;

    // ── Color encoding (bytes 8-15) ── same as DXT1 but always 4-color mode
    const [c0, c1] = findColorEndpoints(block);
    const [r0, g0, b0] = fromRGB565(c0);
    const [r1, g1, b1] = fromRGB565(c1);

    const palette = [
        [r0, g0, b0],
        [r1, g1, b1],
        [Math.round((2 * r0 + r1) / 3), Math.round((2 * g0 + g1) / 3), Math.round((2 * b0 + b1) / 3)],
        [Math.round((r0 + 2 * r1) / 3), Math.round((g0 + 2 * g1) / 3), Math.round((b0 + 2 * b1) / 3)]
    ];

    let colorIndices = 0;
    for (let i = 0; i < 16; i++) {
        const r = block[i * 4];
        const g = block[i * 4 + 1];
        const b = block[i * 4 + 2];
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let ci = 0; ci < 4; ci++) {
            const d = squaredDist(r, g, b, palette[ci][0], palette[ci][1], palette[ci][2]);
            if (d < bestDist) { bestDist = d; bestIdx = ci; }
        }
        colorIndices |= (bestIdx << (i * 2));
    }

    view.setUint16(8, c0, true);
    view.setUint16(10, c1, true);
    view.setUint32(12, colorIndices, true);

    return out;
}

// ─── Mipmap Generation ───────────────────────────────────────────────────────

interface MipLevel {
    data: Uint8Array;
    width: number;
    height: number;
}

function downscale2x(src: Uint8Array, srcW: number, srcH: number): MipLevel {
    const dstW = Math.max(1, srcW >> 1);
    const dstH = Math.max(1, srcH >> 1);
    const dst = new Uint8Array(dstW * dstH * 4);

    for (let dy = 0; dy < dstH; dy++) {
        for (let dx = 0; dx < dstW; dx++) {
            const sx = dx * 2;
            const sy = dy * 2;
            const sx1 = Math.min(sx + 1, srcW - 1);
            const sy1 = Math.min(sy + 1, srcH - 1);
            for (let c = 0; c < 4; c++) {
                const v = (
                    src[(sy * srcW + sx) * 4 + c] +
                    src[(sy * srcW + sx1) * 4 + c] +
                    src[(sy1 * srcW + sx) * 4 + c] +
                    src[(sy1 * srcW + sx1) * 4 + c]
                ) / 4;
                dst[(dy * dstW + dx) * 4 + c] = Math.round(v);
            }
        }
    }

    return { data: dst, width: dstW, height: dstH };
}

function generateMipmaps(rgba: Uint8Array, width: number, height: number): MipLevel[] {
    const levels: MipLevel[] = [{ data: rgba, width, height }];
    let w = width, h = height;
    let current = rgba;

    while (w > 1 || h > 1) {
        const mip = downscale2x(current, w, h);
        levels.push(mip);
        w = mip.width;
        h = mip.height;
        current = mip.data;
    }

    return levels;
}

// ─── Compress a full mip level ───────────────────────────────────────────────

function compressMipLevel(rgba: Uint8Array, width: number, height: number, fourCC: string): Uint8Array {
    const blocksX = Math.max(1, Math.ceil(width / 4));
    const blocksY = Math.max(1, Math.ceil(height / 4));
    const blockSize = (fourCC === 'DXT1') ? 8 : 16;
    const out = new Uint8Array(blocksX * blocksY * blockSize);

    let offset = 0;
    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const block = extractBlock(rgba, width, height, bx, by);
            const compressed = (fourCC === 'DXT1')
                ? encodeDXT1Block(block)
                : encodeDXT5Block(block);
            out.set(compressed, offset);
            offset += blockSize;
        }
    }

    return out;
}

// ─── Header Writing ──────────────────────────────────────────────────────────

function writeHeader(view: DataView, width: number, height: number, fourCC: string, mipCount: number): void {
    const blockSize = (fourCC === 'DXT1') ? 8 : 16;
    const blocksX = Math.max(1, Math.ceil(width / 4));
    const blocksY = Math.max(1, Math.ceil(height / 4));
    const linearSize = blocksX * blocksY * blockSize;

    view.setUint32(0, DDS_MAGIC, true);
    view.setUint32(4, 124, true);            // dwSize
    view.setUint32(8, DDSD_FLAGS, true);     // dwFlags
    view.setUint32(12, height, true);
    view.setUint32(16, width, true);
    view.setUint32(20, linearSize, true);
    view.setUint32(24, 0, true);             // depth
    view.setUint32(28, mipCount, true);
    // reserved1[11] at bytes 32-75 = zeros (already from ArrayBuffer)
    view.setUint32(76, 32, true);            // pf_dwSize
    view.setUint32(80, DDPF_FOURCC, true);   // pf_dwFlags
    // FourCC at offset 84
    for (let i = 0; i < 4; i++) {
        view.setUint8(84 + i, fourCC.charCodeAt(i));
    }
    // pf rgb bits/masks at 88-104 = zeros (compressed format)
    view.setUint32(108, DDSCAPS, true);      // dwCaps
    // caps2..4 + reserved2 at 112-127 = zeros
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Decode a DDS file to RGBA pixel data.
 */
export function decodeDDS(fileData: Uint8Array): DDSImage {
    if (fileData.length < 128) {
        throw new Error('Not a DDS file: too small (' + fileData.length + ' bytes)');
    }

    const header = parseHeader(fileData);
    if (!header) {
        throw new Error('Invalid DDS file: bad header or magic number');
    }

    // Validate dimensions before allocating
    if (header.width <= 0 || header.height <= 0) {
        throw new Error('Invalid DDS dimensions: ' + header.width + 'x' + header.height);
    }
    if (header.width > MAX_DIMENSION || header.height > MAX_DIMENSION) {
        throw new Error('DDS texture too large: ' + header.width + 'x' + header.height + ' (max ' + MAX_DIMENSION + 'x' + MAX_DIMENSION + ')');
    }
    if (header.width * header.height > MAX_PIXELS) {
        throw new Error('DDS texture too many pixels: ' + (header.width * header.height).toLocaleString());
    }

    const supportedFourCC = ['DXT1', 'DXT3', 'DXT5'];
    const isCompressed = supportedFourCC.includes(header.fourCC);
    const isUncompressed = !header.fourCC && header.rgbBitCount > 0;

    if (!isCompressed && !isUncompressed) {
        throw new Error('Unsupported DDS format: ' + (header.fourCC || 'unknown') + '. Supported: DXT1, DXT3, DXT5, uncompressed RGBA');
    }

    // Validate that compressed data is large enough
    if (isCompressed) {
        const blocksX = Math.max(1, Math.ceil(header.width / 4));
        const blocksY = Math.max(1, Math.ceil(header.height / 4));
        const blockSize = (header.fourCC === 'DXT1') ? 8 : 16;
        const expectedMin = 128 + blocksX * blocksY * blockSize;
        if (fileData.length < expectedMin) {
            throw new Error('DDS file truncated: expected at least ' + expectedMin + ' bytes, got ' + fileData.length);
        }
    }

    const rgba = decompress(fileData, header);

    return {
        info: {
            width: header.width,
            height: header.height,
            mipCount: header.mipCount,
            fourCC: header.fourCC || 'RGBA',
            fileSize: fileData.length
        },
        rgba
    };
}

/**
 * Encode RGBA pixels to DDS with full mipmap chain.
 */
export function encodeDDS(rgba: Uint8Array, width: number, height: number, fourCC: string): Uint8Array {
    if (fourCC !== 'DXT1' && fourCC !== 'DXT5') {
        // Default unsupported formats to DXT5
        fourCC = 'DXT5';
    }

    const mips = generateMipmaps(rgba, width, height);

    // Calculate total compressed data size
    const blockSize = (fourCC === 'DXT1') ? 8 : 16;
    let dataSize = 0;
    for (const mip of mips) {
        const bx = Math.max(1, Math.ceil(mip.width / 4));
        const by = Math.max(1, Math.ceil(mip.height / 4));
        dataSize += bx * by * blockSize;
    }

    const fileSize = 128 + dataSize;
    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);
    const out = new Uint8Array(buffer);

    writeHeader(view, width, height, fourCC, mips.length);

    let offset = 128;
    for (const mip of mips) {
        const compressed = compressMipLevel(mip.data, mip.width, mip.height, fourCC);
        out.set(compressed, offset);
        offset += compressed.length;
    }

    return out;
}
