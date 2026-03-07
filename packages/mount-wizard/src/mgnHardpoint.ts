/**
 * MGN Hardpoint Editor
 * Reads and writes HPTS (Hardpoints) blocks in MGN (Mesh Generator) files.
 *
 * HPTS binary format:
 *   FORM HPTS
 *     STAT chunk:
 *       uint16_le count
 *       [for each hardpoint]:
 *         string name\0        (e.g., "saddle")
 *         string parentJoint\0 (e.g., "root", "shoulder", "spine1")
 *         float32_le quat_w, quat_x, quat_y, quat_z  (rotation quaternion)
 *         float32_le pos_x, pos_y, pos_z              (position offset)
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseIFF, serializeIFF, IFFNode, findForm } from './iffUtils';
import { SaddleHardpoint } from './types';

/**
 * Read hardpoints from an MGN file's HPTS block.
 * Returns empty array if no HPTS block exists.
 */
export function readHardpoints(data: Uint8Array): SaddleHardpoint[] {
    const root = parseIFF(data);
    return extractHardpointsFromTree(root);
}

function extractHardpointsFromTree(node: IFFNode): SaddleHardpoint[] {
    const hptsForm = findForm(node, 'HPTS');
    if (!hptsForm?.children) return [];

    // Look for STAT chunk (static hardpoints)
    for (const child of hptsForm.children) {
        if (child.type === 'chunk' && child.tag === 'STAT' && child.data) {
            return parseStatChunk(child.data);
        }
    }
    return [];
}

function parseStatChunk(data: Uint8Array): SaddleHardpoint[] {
    if (data.length < 2) return [];

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint16(0, true); // little-endian
    let pos = 2;
    const hardpoints: SaddleHardpoint[] = [];

    for (let i = 0; i < count; i++) {
        if (pos >= data.length) break;

        // Read name (null-terminated)
        const name = readCString(data, pos);
        pos += name.length + 1;

        // Read parent joint (null-terminated)
        const parentJoint = readCString(data, pos);
        pos += parentJoint.length + 1;

        // Read rider facing quaternion (4 floats, LE)
        // Binary order: ox, oy, oz, ow (x, y, z, w)
        if (pos + 28 > data.length) break;
        const ox = view.getFloat32(pos, true); pos += 4;
        const oy = view.getFloat32(pos, true); pos += 4;
        const oz = view.getFloat32(pos, true); pos += 4;
        const ow = view.getFloat32(pos, true); pos += 4;

        // Read saddle position (3 floats, LE): right/left, up/down, forward/back
        const rl = view.getFloat32(pos, true); pos += 4;
        const ud = view.getFloat32(pos, true); pos += 4;
        const fb = view.getFloat32(pos, true); pos += 4;

        hardpoints.push({
            name,
            parentJoint,
            quaternion: [ow, ox, oy, oz],  // Store internally as [w, x, y, z]
            position: [rl, ud, fb],
        });
    }

    return hardpoints;
}

function readCString(data: Uint8Array, pos: number): string {
    let end = pos;
    while (end < data.length && data[end] !== 0) end++;
    let result = '';
    for (let i = pos; i < end; i++) result += String.fromCharCode(data[i]);
    return result;
}

/**
 * Build an HPTS FORM IFFNode from hardpoint data
 */
function buildHptsNode(hardpoints: SaddleHardpoint[]): IFFNode {
    // Calculate STAT chunk data size
    let statSize = 2; // uint16 count
    for (const hp of hardpoints) {
        statSize += hp.name.length + 1;       // name + null
        statSize += hp.parentJoint.length + 1; // parent + null
        statSize += 28;                        // 4 quat floats + 3 pos floats
    }

    const statData = new Uint8Array(statSize);
    const statView = new DataView(statData.buffer);
    let pos = 0;

    // Count
    statView.setUint16(0, hardpoints.length, true);
    pos = 2;

    for (const hp of hardpoints) {
        // Name
        for (let i = 0; i < hp.name.length; i++) {
            statData[pos++] = hp.name.charCodeAt(i);
        }
        statData[pos++] = 0;

        // Parent joint
        for (let i = 0; i < hp.parentJoint.length; i++) {
            statData[pos++] = hp.parentJoint.charCodeAt(i);
        }
        statData[pos++] = 0;

        // Rider facing quaternion: binary order is ox, oy, oz, ow (x, y, z, w)
        // Internal storage is [w, x, y, z], so write [1]=x, [2]=y, [3]=z, [0]=w
        statView.setFloat32(pos, hp.quaternion[1], true); pos += 4; // ox
        statView.setFloat32(pos, hp.quaternion[2], true); pos += 4; // oy
        statView.setFloat32(pos, hp.quaternion[3], true); pos += 4; // oz
        statView.setFloat32(pos, hp.quaternion[0], true); pos += 4; // ow

        // Saddle position: right/left, up/down, forward/back
        statView.setFloat32(pos, hp.position[0], true); pos += 4; // r/l
        statView.setFloat32(pos, hp.position[1], true); pos += 4; // u/d
        statView.setFloat32(pos, hp.position[2], true); pos += 4; // f/b
    }

    return {
        type: 'form',
        tag: 'FORM',
        formName: 'HPTS',
        children: [{
            type: 'chunk',
            tag: 'STAT',
            data: statData,
            offset: 0,
            size: statSize,
        }],
        offset: 0,
        size: 0,
    };
}

/**
 * Inject an HPTS block into an MGN file.
 * If an HPTS block already exists, it is replaced.
 * Returns the modified file data.
 */
export function injectHardpoints(data: Uint8Array, hardpoints: SaddleHardpoint[]): Uint8Array {
    const root = parseIFF(data);

    // Find the top-level SKMG form (Skeletal Mesh Generator)
    const skmgForm = findForm(root, 'SKMG');
    if (!skmgForm?.children) {
        throw new Error('Not a valid MGN file: no SKMG form found');
    }

    // Find the version form inside SKMG (e.g., FORM 0004)
    let versionForm: IFFNode | null = null;
    for (const child of skmgForm.children) {
        if (child.type === 'form' && child.formName && /^\d{4}$/.test(child.formName)) {
            versionForm = child;
            break;
        }
    }

    if (!versionForm?.children) {
        throw new Error('Not a valid MGN file: no version form found inside SKMG');
    }

    // Remove existing HPTS if present
    versionForm.children = versionForm.children.filter(
        c => !(c.type === 'form' && c.formName === 'HPTS')
    );

    // Build new HPTS node
    const hptsNode = buildHptsNode(hardpoints);

    // Insert HPTS at the end of the version form's children
    versionForm.children.push(hptsNode);

    return serializeIFF(root);
}

/**
 * Inject HPTS into an MGN file on disk.
 * If the file is in vanilla/infinity, copies to working first.
 */
export function injectHardpointsToFile(
    workspaceRoot: string,
    mgnRelativePath: string,
    hardpoints: SaddleHardpoint[]
): string {
    const workingPath = path.join(workspaceRoot, 'tre/working', mgnRelativePath);

    // Ensure we have a working copy
    if (!fs.existsSync(workingPath)) {
        const sources = ['vanilla', 'infinity'];
        let copied = false;
        for (const src of sources) {
            const srcPath = path.join(workspaceRoot, 'tre', src, mgnRelativePath);
            if (fs.existsSync(srcPath)) {
                const dir = path.dirname(workingPath);
                fs.mkdirSync(dir, { recursive: true });
                fs.copyFileSync(srcPath, workingPath);
                copied = true;
                break;
            }
        }
        if (!copied) throw new Error(`MGN file not found: ${mgnRelativePath}`);
    }

    const data = new Uint8Array(fs.readFileSync(workingPath));
    const modified = injectHardpoints(data, hardpoints);
    fs.writeFileSync(workingPath, modified);
    return workingPath;
}
