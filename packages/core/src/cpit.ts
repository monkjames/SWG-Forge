/**
 * CPIT (Cockpit) IFF parser/serializer
 *
 * Format: FORM CPIT → FORM 0000
 *   FRAM  — null-terminated appearance path string
 *   ZOOM  — variable-length LE float array (zoom levels)
 *   FRST  — 1 LE float (default first-person zoom)
 *   3OFF  — 3 LE floats (third-person camera offset x/y/z)
 *   1OFF  — 3 LE floats (first-person camera offset x/y/z)
 *   [optional] FORM ISPB → HYPR — 3 LE floats (hyperspace params, POB ships)
 *
 * IFF framing is big-endian; chunk DATA is little-endian.
 */

import { parseIFF, serializeIFF, readNullString } from './iff';
import type { IFFNode } from './iff';

export interface CPITOffset {
    x: number;
    y: number;
    z: number;
}

export interface CPITData {
    frame: string;
    zoomLevels: number[];
    firstPersonZoom: number;
    thirdPersonOffset: CPITOffset;
    firstPersonOffset: CPITOffset;
    hyperspace?: CPITOffset;
}

export function parseCPIT(data: Uint8Array): CPITData {
    const root = parseIFF(data);

    if (root.type !== 'form' || root.formName !== 'CPIT') {
        throw new Error('Not a CPIT file (expected FORM CPIT, got ' + (root.formName || root.tag) + ')');
    }

    const form0000 = root.children?.find(c => c.type === 'form' && c.formName === '0000');
    if (!form0000 || !form0000.children) {
        throw new Error('Missing FORM 0000 inside CPIT');
    }

    const kids = form0000.children;

    // FRAM — appearance path
    const framChunk = kids.find(c => c.type === 'chunk' && c.tag === 'FRAM');
    let frame = '';
    if (framChunk?.data && framChunk.data.length > 1) {
        frame = readNullString(framChunk.data, 0);
    }

    // ZOOM — variable-length float array (LE)
    const zoomChunk = kids.find(c => c.type === 'chunk' && c.tag === 'ZOOM');
    const zoomLevels: number[] = [];
    if (zoomChunk?.data) {
        const dv = new DataView(zoomChunk.data.buffer, zoomChunk.data.byteOffset, zoomChunk.data.byteLength);
        const count = Math.floor(zoomChunk.data.byteLength / 4);
        for (let i = 0; i < count; i++) {
            zoomLevels.push(dv.getFloat32(i * 4, true));
        }
    }

    // FRST — single float (LE)
    const frstChunk = kids.find(c => c.type === 'chunk' && c.tag === 'FRST');
    let firstPersonZoom = 0;
    if (frstChunk?.data) {
        const dv = new DataView(frstChunk.data.buffer, frstChunk.data.byteOffset, frstChunk.data.byteLength);
        firstPersonZoom = dv.getFloat32(0, true);
    }

    // 3OFF — 3 floats (LE)
    const thirdChunk = kids.find(c => c.type === 'chunk' && c.tag === '3OFF');
    const thirdPersonOffset: CPITOffset = { x: 0, y: 0, z: 0 };
    if (thirdChunk?.data) {
        const dv = new DataView(thirdChunk.data.buffer, thirdChunk.data.byteOffset, thirdChunk.data.byteLength);
        thirdPersonOffset.x = dv.getFloat32(0, true);
        thirdPersonOffset.y = dv.getFloat32(4, true);
        thirdPersonOffset.z = dv.getFloat32(8, true);
    }

    // 1OFF — 3 floats (LE)
    const firstChunk = kids.find(c => c.type === 'chunk' && c.tag === '1OFF');
    const firstPersonOffset: CPITOffset = { x: 0, y: 0, z: 0 };
    if (firstChunk?.data) {
        const dv = new DataView(firstChunk.data.buffer, firstChunk.data.byteOffset, firstChunk.data.byteLength);
        firstPersonOffset.x = dv.getFloat32(0, true);
        firstPersonOffset.y = dv.getFloat32(4, true);
        firstPersonOffset.z = dv.getFloat32(8, true);
    }

    // Optional: FORM ISPB → HYPR — 3 floats (LE)
    let hyperspace: CPITOffset | undefined;
    const ispbForm = kids.find(c => c.type === 'form' && c.formName === 'ISPB');
    if (ispbForm?.children) {
        const hyprChunk = ispbForm.children.find(c => c.type === 'chunk' && c.tag === 'HYPR');
        if (hyprChunk?.data) {
            const dv = new DataView(hyprChunk.data.buffer, hyprChunk.data.byteOffset, hyprChunk.data.byteLength);
            hyperspace = {
                x: dv.getFloat32(0, true),
                y: dv.getFloat32(4, true),
                z: dv.getFloat32(8, true)
            };
        }
    }

    return { frame, zoomLevels, firstPersonZoom, thirdPersonOffset, firstPersonOffset, hyperspace };
}

export function serializeCPIT(cpit: CPITData): Uint8Array {
    // FRAM — null-terminated string
    const frameBytes = new TextEncoder().encode(cpit.frame);
    const framData = new Uint8Array(frameBytes.length + 1);
    framData.set(frameBytes);

    // ZOOM — LE float array
    const zoomData = new Uint8Array(cpit.zoomLevels.length * 4);
    const zoomDv = new DataView(zoomData.buffer);
    for (let i = 0; i < cpit.zoomLevels.length; i++) {
        zoomDv.setFloat32(i * 4, cpit.zoomLevels[i], true);
    }

    // FRST — 1 LE float
    const frstData = new Uint8Array(4);
    new DataView(frstData.buffer).setFloat32(0, cpit.firstPersonZoom, true);

    // 3OFF — 3 LE floats
    const thirdData = new Uint8Array(12);
    const tdv = new DataView(thirdData.buffer);
    tdv.setFloat32(0, cpit.thirdPersonOffset.x, true);
    tdv.setFloat32(4, cpit.thirdPersonOffset.y, true);
    tdv.setFloat32(8, cpit.thirdPersonOffset.z, true);

    // 1OFF — 3 LE floats
    const firstData = new Uint8Array(12);
    const fdv = new DataView(firstData.buffer);
    fdv.setFloat32(0, cpit.firstPersonOffset.x, true);
    fdv.setFloat32(4, cpit.firstPersonOffset.y, true);
    fdv.setFloat32(8, cpit.firstPersonOffset.z, true);

    // Build IFF tree
    const children: IFFNode[] = [
        { type: 'chunk', tag: 'FRAM', data: framData, offset: 0, size: 0 },
        { type: 'chunk', tag: 'ZOOM', data: zoomData, offset: 0, size: 0 },
        { type: 'chunk', tag: 'FRST', data: frstData, offset: 0, size: 0 },
        { type: 'chunk', tag: '3OFF', data: thirdData, offset: 0, size: 0 },
        { type: 'chunk', tag: '1OFF', data: firstData, offset: 0, size: 0 }
    ];

    if (cpit.hyperspace) {
        const hyprData = new Uint8Array(12);
        const hdv = new DataView(hyprData.buffer);
        hdv.setFloat32(0, cpit.hyperspace.x, true);
        hdv.setFloat32(4, cpit.hyperspace.y, true);
        hdv.setFloat32(8, cpit.hyperspace.z, true);

        children.push({
            type: 'form',
            tag: 'FORM',
            formName: 'ISPB',
            children: [
                { type: 'chunk', tag: 'HYPR', data: hyprData, offset: 0, size: 0 }
            ],
            offset: 0,
            size: 0
        });
    }

    const root: IFFNode = {
        type: 'form',
        tag: 'FORM',
        formName: 'CPIT',
        children: [{
            type: 'form',
            tag: 'FORM',
            formName: '0000',
            children,
            offset: 0,
            size: 0
        }],
        offset: 0,
        size: 0
    };

    return serializeIFF(root);
}
