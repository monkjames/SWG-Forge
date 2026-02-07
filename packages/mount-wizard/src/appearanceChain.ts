/**
 * Appearance Chain Resolver
 * Follows SAT → LMG → MGN chain to find all LOD mesh files
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseIFF, findForm, findChunk, readNullString, extractStringProperty } from './iffUtils';
import { AppearanceChain, MgnFileInfo, SaddleHardpoint } from './types';
import { readHardpoints } from './mgnHardpoint';

const TRE_SEARCH_ORDER = ['working', 'vanilla', 'infinity'] as const;

/**
 * Resolve a TRE-relative path to an absolute file path, searching working → vanilla → infinity.
 * Returns the absolute path and source location.
 */
export function resolveTrePath(workspaceRoot: string, relativePath: string): { absolutePath: string; source: 'working' | 'vanilla' | 'infinity' } | null {
    for (const dir of TRE_SEARCH_ORDER) {
        const fullPath = path.join(workspaceRoot, 'tre', dir, relativePath);
        if (fs.existsSync(fullPath)) {
            return { absolutePath: fullPath, source: dir };
        }
    }
    return null;
}

/**
 * Find the appearance filename and slot descriptor from the Lua shared object template.
 * Searches objects.lua for the shared template matching the creature's IFF path.
 */
export function findObjectTemplateInfo(workspaceRoot: string, objectIffPath: string): {
    appearanceFilename: string;
    slotDescriptorFilename: string;
    objectsLuaPath: string;
    sharedVarName: string;
} | null {
    // Derive the shared variable name: object/mobile/kaadu_hue.iff → object_mobile_shared_kaadu_hue
    const dirPart = objectIffPath.substring(0, objectIffPath.lastIndexOf('/'));
    const filePart = objectIffPath.substring(objectIffPath.lastIndexOf('/') + 1).replace(/\.iff$/, '');
    const sharedVarName = dirPart.replace(/\//g, '_') + '_shared_' + filePart;

    // Search in both vanilla and custom_scripts objects.lua
    const scriptsBase = path.join(workspaceRoot, 'infinity4.0.0/MMOCoreORB/bin/scripts');
    const searchPaths = [
        path.join(scriptsBase, 'object/mobile/objects.lua'),
        path.join(scriptsBase, 'custom_scripts/object/mobile/objects.lua'),
    ];

    // Track Lua match info even if it lacks appearanceFilename (needed for slot descriptor edits)
    let matchedLuaPath = '';
    let clientTemplateFileName = '';

    for (const luaPath of searchPaths) {
        if (!fs.existsSync(luaPath)) continue;
        const content = fs.readFileSync(luaPath, 'utf-8');

        // Find the shared template block
        const varRegex = new RegExp(
            `${sharedVarName}\\s*=\\s*SharedCreatureObjectTemplate:new\\s*\\{([\\s\\S]*?)\\}`,
            'm'
        );
        const match = content.match(varRegex);
        if (!match) continue;

        const block = match[1];
        matchedLuaPath = luaPath;

        // Extract appearanceFilename
        const appMatch = block.match(/appearanceFilename\s*=\s*"([^"]+)"/);
        const appearanceFilename = appMatch ? appMatch[1] : '';

        // Extract slotDescriptorFilename
        const slotMatch = block.match(/slotDescriptorFilename\s*=\s*"([^"]+)"/);
        const slotDescriptorFilename = slotMatch ? slotMatch[1] : '';

        // Extract clientTemplateFileName (for IFF fallback)
        const ctfMatch = block.match(/clientTemplateFileName\s*=\s*"([^"]+)"/);
        if (ctfMatch) clientTemplateFileName = ctfMatch[1];

        if (appearanceFilename) {
            return { appearanceFilename, slotDescriptorFilename, objectsLuaPath: luaPath, sharedVarName };
        }
    }

    // Fallback: read appearance from the shared IFF file in TRE.
    // Many custom creatures (varactyls, nexu, etc.) only have clientTemplateFileName
    // in Lua with no appearanceFilename - the appearance is embedded in the IFF.
    // Build the shared IFF path: object/mobile/foo.iff → object/mobile/shared_foo.iff
    const sharedIffPath = clientTemplateFileName ||
        (dirPart + '/shared_' + filePart + '.iff');

    const iffResolved = resolveTrePath(workspaceRoot, sharedIffPath);
    if (iffResolved) {
        try {
            const data = new Uint8Array(fs.readFileSync(iffResolved.absolutePath));
            const root = parseIFF(data);
            const appearance = extractStringProperty(root, 'appearanceFilename');
            const slot = extractStringProperty(root, 'slotDescriptorFilename');
            return {
                appearanceFilename: appearance || '',
                slotDescriptorFilename: slot || '',
                objectsLuaPath: matchedLuaPath || searchPaths[0],
                sharedVarName,
            };
        } catch {
            // Ignore parse errors
        }
    }

    return null;
}

/**
 * Parse a SAT file to extract the LMG reference.
 * SAT files contain a reference to an LMG (LOD Mesh Group) file.
 */
function parseSATForLMG(data: Uint8Array): string | null {
    const root = parseIFF(data);

    // SAT → FORM SMAT or similar. The LMG path is usually in an MSGN or similar chunk
    // Actually, for SWG SAT files, the structure varies. Let's search for LMG path strings.
    // SAT files reference LMG via embedded paths.
    function searchForLMGPath(node: typeof root): string | null {
        if (node.type === 'chunk' && node.data) {
            // Look for .lmg path in chunk data
            const str = readNullString(node.data, 0);
            if (str.endsWith('.lmg')) return str;

            // Also search within the data for embedded paths
            for (let i = 0; i < node.data.length - 4; i++) {
                const substr = readNullString(node.data, i);
                if (substr.endsWith('.lmg') && substr.length > 4) {
                    return substr;
                }
            }
        }
        if (node.children) {
            for (const child of node.children) {
                const result = searchForLMGPath(child);
                if (result) return result;
            }
        }
        return null;
    }

    return searchForLMGPath(root);
}

/**
 * Parse an LMG file to extract all MGN file references.
 */
function parseLMGForMGNs(data: Uint8Array): string[] {
    const root = parseIFF(data);
    const mgnPaths: string[] = [];

    function searchForMGNPaths(node: typeof root): void {
        if (node.type === 'chunk' && node.data) {
            // MGN paths are typically in CHLD or NAME chunks
            for (let i = 0; i < node.data.length - 4; i++) {
                const substr = readNullString(node.data, i);
                if (substr.endsWith('.mgn') && substr.length > 4 && !mgnPaths.includes(substr)) {
                    mgnPaths.push(substr);
                    i += substr.length; // skip past this string
                }
            }
        }
        if (node.children) {
            for (const child of node.children) {
                searchForMGNPaths(child);
            }
        }
    }

    searchForMGNPaths(root);
    return mgnPaths;
}

/**
 * Resolve the full appearance chain for a creature.
 * Given an object template IFF path, follows SAT → LMG → MGN
 * and returns info about all MGN LOD files including HPTS status.
 */
export function resolveAppearanceChain(workspaceRoot: string, objectIffPath: string): AppearanceChain | null {
    // Step 1: Find appearance filename from Lua object template
    const templateInfo = findObjectTemplateInfo(workspaceRoot, objectIffPath);
    if (!templateInfo || !templateInfo.appearanceFilename) return null;

    const appearanceFilename = templateInfo.appearanceFilename;

    // Step 2: Resolve SAT file
    const satResolved = resolveTrePath(workspaceRoot, appearanceFilename);
    if (!satResolved) return null;

    // Step 3: Parse SAT to find LMG
    const satData = new Uint8Array(fs.readFileSync(satResolved.absolutePath));
    const lmgRelative = parseSATForLMG(satData);
    if (!lmgRelative) return null;

    // LMG paths in SAT may need "appearance/" prefix
    let lmgPath = lmgRelative;
    if (!lmgPath.startsWith('appearance/')) {
        lmgPath = 'appearance/' + lmgPath;
    }

    const lmgResolved = resolveTrePath(workspaceRoot, lmgPath);
    if (!lmgResolved) return null;

    // Step 4: Parse LMG to find all MGN files
    const lmgData = new Uint8Array(fs.readFileSync(lmgResolved.absolutePath));
    const mgnRelativePaths = parseLMGForMGNs(lmgData);

    // Step 5: Resolve each MGN and check for HPTS
    const mgnFiles: MgnFileInfo[] = [];
    for (const mgnRel of mgnRelativePaths) {
        let mgnPath = mgnRel;
        if (!mgnPath.startsWith('appearance/')) {
            mgnPath = 'appearance/' + mgnPath;
        }

        const resolved = resolveTrePath(workspaceRoot, mgnPath);
        if (resolved) {
            const mgnData = new Uint8Array(fs.readFileSync(resolved.absolutePath));
            const hardpoints = readHardpoints(mgnData);

            mgnFiles.push({
                relativePath: mgnPath,
                absolutePath: resolved.absolutePath,
                source: resolved.source,
                hasHpts: hardpoints.length > 0,
                hardpoints,
            });
        }
    }

    // Sort by LOD level (l0, l1, l2, etc.)
    mgnFiles.sort((a, b) => {
        const aLevel = extractLodLevel(a.relativePath);
        const bLevel = extractLodLevel(b.relativePath);
        return aLevel - bLevel;
    });

    return {
        satPath: satResolved.absolutePath,
        lmgPath: lmgResolved.absolutePath,
        mgnFiles,
        appearanceFilename,
        slotDescriptorFilename: templateInfo.slotDescriptorFilename,
    };
}

function extractLodLevel(filePath: string): number {
    const match = filePath.match(/_l(\d+)\./);
    return match ? parseInt(match[1], 10) : 0;
}
