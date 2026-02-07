/**
 * DDS Texture Decoder - Pure TypeScript DXT5/DXT1 decompression.
 * Decodes SWG DDS textures to base64 BMP data URIs for webview thumbnails.
 */

import * as fs from 'fs';

const DDS_MAGIC = 0x20534444; // "DDS "

interface DDSHeader {
    width: number;
    height: number;
    mipCount: number;
    fourcc: string;
}

/**
 * Parse DDS header from file buffer.
 */
function parseHeader(buf: Buffer): DDSHeader | null {
    if (buf.length < 128) return null;
    const magic = buf.readUInt32LE(0);
    if (magic !== DDS_MAGIC) return null;

    const height = buf.readUInt32LE(12);
    const width = buf.readUInt32LE(16);
    const mipCount = buf.readUInt32LE(28) || 1;
    const fourcc = buf.toString('ascii', 84, 88);

    return { width, height, mipCount, fourcc };
}

/**
 * Decode a DXT5 (BC3) 4x4 block into RGBA pixels.
 * 16 bytes per block: 8 bytes alpha + 8 bytes color (DXT1).
 */
function decodeDXT5Block(block: Buffer, offset: number): Uint8Array {
    const pixels = new Uint8Array(4 * 4 * 4); // 16 pixels, 4 bytes each

    // Alpha block (8 bytes)
    const a0 = block[offset];
    const a1 = block[offset + 1];

    // 6 bytes = 48 bits = 16 x 3-bit alpha indices
    const alphaBits =
        block[offset + 2] | (block[offset + 3] << 8) | (block[offset + 4] << 16) |
        ((block[offset + 5] | (block[offset + 6] << 8) | (block[offset + 7] << 16)) * 0x1000000);

    // Build alpha lookup table
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

    // Extract 3-bit alpha indices from 48-bit field
    // We need to read the 6 bytes as individual 3-bit lookups
    const alphaBytes = [
        block[offset + 2], block[offset + 3], block[offset + 4],
        block[offset + 5], block[offset + 6], block[offset + 7]
    ];
    let alphaBitPos = 0;
    const alphaIndices = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        const byteIdx = Math.floor(alphaBitPos / 8);
        const bitIdx = alphaBitPos % 8;
        let val: number;
        if (bitIdx <= 5) {
            val = (alphaBytes[byteIdx] >> bitIdx) & 0x7;
        } else {
            // Spans two bytes
            val = ((alphaBytes[byteIdx] >> bitIdx) | (alphaBytes[byteIdx + 1] << (8 - bitIdx))) & 0x7;
        }
        alphaIndices[i] = val;
        alphaBitPos += 3;
    }

    // Color block (8 bytes at offset+8)
    const c0 = block.readUInt16LE(offset + 8);
    const c1 = block.readUInt16LE(offset + 10);

    // RGB565 -> RGB888
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

    // 4 bytes = 16 x 2-bit color indices
    const colorBits = block.readUInt32LE(offset + 12);

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

/**
 * Decode a DXT1 (BC1) 4x4 block into RGBA pixels.
 * 8 bytes per block.
 */
function decodeDXT1Block(block: Buffer, offset: number): Uint8Array {
    const pixels = new Uint8Array(4 * 4 * 4);

    const c0 = block.readUInt16LE(offset);
    const c1 = block.readUInt16LE(offset + 2);

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
        colors[3] = [0, 0, 0, 0]; // transparent
    }

    const bits = block.readUInt32LE(offset + 4);
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

/**
 * Decompress a full DDS texture to RGBA pixel data.
 */
function decompress(buf: Buffer, header: DDSHeader): Uint8Array {
    const { width, height, fourcc } = header;
    const rgba = new Uint8Array(width * height * 4);
    const data = buf.subarray(128); // Skip 128-byte header

    const blocksX = Math.max(1, Math.ceil(width / 4));
    const blocksY = Math.max(1, Math.ceil(height / 4));
    const blockSize = (fourcc === 'DXT1') ? 8 : 16;

    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const blockIdx = by * blocksX + bx;
            const blockOff = blockIdx * blockSize;

            if (blockOff + blockSize > data.length) break;

            let pixels: Uint8Array;
            if (fourcc === 'DXT1') {
                pixels = decodeDXT1Block(data as any, blockOff);
            } else {
                // DXT3/DXT5 both use 16-byte blocks; DXT5 is most common in SWG
                pixels = decodeDXT5Block(data as any, blockOff);
            }

            // Copy 4x4 block into output
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const destX = bx * 4 + px;
                    const destY = by * 4 + py;
                    if (destX >= width || destY >= height) continue;
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

/**
 * Simple downscale of RGBA pixels using nearest-neighbor.
 */
function downscale(rgba: Uint8Array, srcW: number, srcH: number, maxWidth: number): { data: Uint8Array; width: number; height: number } {
    if (srcW <= maxWidth) {
        return { data: rgba, width: srcW, height: srcH };
    }
    const scale = maxWidth / srcW;
    const dstW = Math.round(srcW * scale);
    const dstH = Math.round(srcH * scale);
    const out = new Uint8Array(dstW * dstH * 4);

    for (let y = 0; y < dstH; y++) {
        const srcY = Math.min(Math.floor(y / scale), srcH - 1);
        for (let x = 0; x < dstW; x++) {
            const srcX = Math.min(Math.floor(x / scale), srcW - 1);
            const si = (srcY * srcW + srcX) * 4;
            const di = (y * dstW + x) * 4;
            out[di] = rgba[si];
            out[di + 1] = rgba[si + 1];
            out[di + 2] = rgba[si + 2];
            out[di + 3] = rgba[si + 3];
        }
    }

    return { data: out, width: dstW, height: dstH };
}

/**
 * Encode RGBA pixel data as a BMP and return as base64 data URI.
 * Uses 32-bit BGRA BMP with alpha channel.
 */
function encodeBMP(rgba: Uint8Array, width: number, height: number): string {
    const pixelDataSize = width * height * 4;
    const headerSize = 14 + 40; // BMP header + DIB header
    const fileSize = headerSize + pixelDataSize;

    const buf = Buffer.alloc(fileSize);

    // BMP file header (14 bytes)
    buf[0] = 0x42; buf[1] = 0x4D; // "BM"
    buf.writeUInt32LE(fileSize, 2);
    buf.writeUInt32LE(headerSize, 10);

    // DIB header (BITMAPINFOHEADER, 40 bytes)
    buf.writeUInt32LE(40, 14);
    buf.writeInt32LE(width, 18);
    buf.writeInt32LE(-height, 22); // negative = top-down
    buf.writeUInt16LE(1, 26); // planes
    buf.writeUInt16LE(32, 28); // bits per pixel
    buf.writeUInt32LE(0, 30); // compression (BI_RGB)
    buf.writeUInt32LE(pixelDataSize, 34);

    // Pixel data: convert RGBA to BGRA
    let offset = headerSize;
    for (let i = 0; i < rgba.length; i += 4) {
        buf[offset] = rgba[i + 2];     // B
        buf[offset + 1] = rgba[i + 1]; // G
        buf[offset + 2] = rgba[i];     // R
        buf[offset + 3] = rgba[i + 3]; // A
        offset += 4;
    }

    return 'data:image/bmp;base64,' + buf.toString('base64');
}

/**
 * Decode a DDS file and return a base64 BMP data URI thumbnail.
 * Returns null if the file can't be decoded.
 */
export function decodeDDSThumbnail(filePath: string, maxWidth: number = 300): string | null {
    try {
        const buf = fs.readFileSync(filePath);
        const header = parseHeader(buf as any);
        if (!header) return null;
        if (header.fourcc !== 'DXT5' && header.fourcc !== 'DXT1' && header.fourcc !== 'DXT3') {
            return null;
        }

        const rgba = decompress(buf as any, header);
        const thumb = downscale(rgba, header.width, header.height, maxWidth);
        return encodeBMP(thumb.data, thumb.width, thumb.height);
    } catch {
        return null;
    }
}

/**
 * Get DDS file dimensions without full decode.
 */
export function getDDSInfo(filePath: string): { width: number; height: number; format: string } | null {
    try {
        const buf = Buffer.alloc(128);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buf, 0, 128, 0);
        fs.closeSync(fd);
        const header = parseHeader(buf);
        if (!header) return null;
        return { width: header.width, height: header.height, format: header.fourcc };
    } catch {
        return null;
    }
}
