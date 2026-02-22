/**
 * Clones complete appearance chains (SAT→LOD→MGN→MSH→SHT→DDS)
 * Skips skeleton files (.skt) as requested
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AppearanceChain {
    sat?: string;
    lod?: string[];
    mgn?: string[];
    msh?: string[];
    sht?: string[];
    dds?: string[];
}

export interface CloneResult {
    cloned: string[];
    errors: string[];
}

/**
 * Clone an entire appearance chain from source to target
 */
export function cloneAppearanceChain(
    sourceSat: string,
    newCreatureName: string,
    treWorking: string,
    treInfinity: string,
    treVanilla: string
): CloneResult {
    const result: CloneResult = { cloned: [], errors: [] };

    try {
        // Parse the appearance chain
        const chain = parseAppearanceChain(sourceSat, [treWorking, treInfinity, treVanilla]);

        // Clone SAT
        if (chain.sat) {
            cloneFile(chain.sat, newCreatureName, treWorking, [treWorking, treInfinity, treVanilla], result);
        }

        // Clone LOD files
        for (const lod of chain.lod || []) {
            cloneFile(lod, newCreatureName, treWorking, [treWorking, treInfinity, treVanilla], result);
        }

        // Clone MGN files (important for mounts!)
        for (const mgn of chain.mgn || []) {
            cloneFile(mgn, newCreatureName, treWorking, [treWorking, treInfinity, treVanilla], result);
        }

        // Clone MSH files
        for (const msh of chain.msh || []) {
            cloneFile(msh, newCreatureName, treWorking, [treWorking, treInfinity, treVanilla], result);
        }

        // Clone SHT files
        for (const sht of chain.sht || []) {
            cloneFile(sht, newCreatureName, treWorking, [treWorking, treInfinity, treVanilla], result);
        }

        // Clone DDS files
        for (const dds of chain.dds || []) {
            cloneFile(dds, newCreatureName, treWorking, [treWorking, treInfinity, treVanilla], result);
        }

    } catch (e: any) {
        result.errors.push('Appearance chain cloning failed: ' + e.message);
    }

    return result;
}

/**
 * Parse appearance chain by reading SAT/LOD/MGN files and extracting references
 */
function parseAppearanceChain(satPath: string, trePaths: string[]): AppearanceChain {
    const chain: AppearanceChain = {
        sat: satPath,
        lod: [],
        mgn: [],
        msh: [],
        sht: [],
        dds: [],
    };

    // Find and read SAT file
    const satFile = findFile(satPath, trePaths);
    if (satFile) {
        const satRefs = extractReferences(satFile, ['.lod', '.lmg', '.mgn']);
        chain.lod!.push(...satRefs.filter(r => r.endsWith('.lod')));
        chain.mgn!.push(...satRefs.filter(r => r.endsWith('.mgn') || r.endsWith('.lmg')));
    }

    // Parse LOD files for mesh references
    for (const lodPath of chain.lod || []) {
        const lodFile = findFile(lodPath, trePaths);
        if (lodFile) {
            const meshRefs = extractReferences(lodFile, ['.msh']);
            chain.msh!.push(...meshRefs);
        }
    }

    // Parse MGN files for mesh and shader references
    for (const mgnPath of chain.mgn || []) {
        const mgnFile = findFile(mgnPath, trePaths);
        if (mgnFile) {
            const meshRefs = extractReferences(mgnFile, ['.msh']);
            const shaderRefs = extractReferences(mgnFile, ['.sht']);
            chain.msh!.push(...meshRefs);
            chain.sht!.push(...shaderRefs);
        }
    }

    // Parse SHT files for texture references
    for (const shtPath of chain.sht || []) {
        const shtFile = findFile(shtPath, trePaths);
        if (shtFile) {
            const texRefs = extractReferences(shtFile, ['.dds']);
            chain.dds!.push(...texRefs);
        }
    }

    // Deduplicate all arrays
    chain.lod = [...new Set(chain.lod)];
    chain.mgn = [...new Set(chain.mgn)];
    chain.msh = [...new Set(chain.msh)];
    chain.sht = [...new Set(chain.sht)];
    chain.dds = [...new Set(chain.dds)];

    return chain;
}

/**
 * Find a file in the TRE hierarchy (working → infinity → vanilla)
 */
function findFile(relativePath: string, trePaths: string[]): string | null {
    for (const treRoot of trePaths) {
        const fullPath = path.join(treRoot, relativePath);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }
    return null;
}

/**
 * Extract file references from a binary IFF file
 */
function extractReferences(filePath: string, extensions: string[]): string[] {
    try {
        const data = fs.readFileSync(filePath);
        const content = data.toString('latin1'); // Binary-safe string

        const refs: string[] = [];
        for (const ext of extensions) {
            // Match paths like "appearance/foo.ext" or "mesh/bar.ext"
            const pattern = new RegExp(`[a-z_/]+${ext.replace('.', '\\.')}`, 'gi');
            const matches = content.match(pattern);
            if (matches) {
                refs.push(...matches);
            }
        }

        return refs;
    } catch (e) {
        return [];
    }
}

/**
 * Clone a single file with name replacement
 */
function cloneFile(
    relativePath: string,
    newCreatureName: string,
    targetTreRoot: string,
    sourceTrePaths: string[],
    result: CloneResult
): void {
    // Find source file
    const sourceFile = findFile(relativePath, sourceTrePaths);
    if (!sourceFile) {
        result.errors.push('Source file not found: ' + relativePath);
        return;
    }

    // Generate new path by replacing creature name
    const newRelativePath = replaceCreatureName(relativePath, newCreatureName);
    const targetFile = path.join(targetTreRoot, newRelativePath);

    // Skip if already exists
    if (fs.existsSync(targetFile)) {
        result.errors.push('Target already exists (skipped): ' + newRelativePath);
        return;
    }

    // Read source data
    const data = fs.readFileSync(sourceFile);

    // Replace all references inside the file
    const updatedData = replaceReferencesInBinary(data, getOriginalCreatureName(relativePath), newCreatureName);

    // Write to target
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, updatedData);

    result.cloned.push(newRelativePath);
}

/**
 * Replace creature name in a file path
 * Example: appearance/rancor.sat → appearance/my_rancor.sat
 */
function replaceCreatureName(filePath: string, newName: string): string {
    const basename = path.basename(filePath);
    const dirname = path.dirname(filePath);

    // Try to intelligently replace the creature name
    // This assumes the filename contains the creature name
    const ext = path.extname(basename);
    const nameWithoutExt = basename.slice(0, -ext.length);

    // Replace the base name with new name
    return path.join(dirname, newName + ext);
}

/**
 * Extract original creature name from file path
 */
function getOriginalCreatureName(filePath: string): string {
    const basename = path.basename(filePath);
    const ext = path.extname(basename);
    return basename.slice(0, -ext.length);
}

/**
 * Replace all occurrences of old creature name with new name in binary data
 */
function replaceReferencesInBinary(data: Buffer, oldName: string, newName: string): Buffer {
    let content = data.toString('latin1');

    // Replace all case-insensitive occurrences
    const regex = new RegExp(oldName, 'gi');
    content = content.replace(regex, newName);

    return Buffer.from(content, 'latin1');
}
