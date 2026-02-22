/**
 * Scans mobile Lua files and extracts appearance information
 */

import * as fs from 'fs';
import * as path from 'path';

export interface MobileEntry {
    name: string;
    path: string;
    relativePath: string;
    folder: string;
    isCustom: boolean;
    appearancePath?: string;
    objectTemplatePath?: string;
}

export interface ScanPaths {
    scriptsPath: string;
    customScriptsPath: string;
    treWorking: string;
    treInfinity: string;
    treVanilla: string;
}

/**
 * Scan both scripts/mobile and custom_scripts/mobile for creature files
 */
export function scanMobiles(paths: ScanPaths): MobileEntry[] {
    const mobiles: MobileEntry[] = [];

    // Scan vanilla mobiles
    const vanillaDir = path.join(paths.scriptsPath, 'mobile');
    if (fs.existsSync(vanillaDir)) {
        scanMobileDir(vanillaDir, '', mobiles, false);
    }

    // Scan custom mobiles
    const customDir = path.join(paths.customScriptsPath, 'mobile');
    if (fs.existsSync(customDir)) {
        scanMobileDir(customDir, '', mobiles, true);
    }

    return mobiles.sort((a, b) => {
        // Custom mobiles first
        if (a.isCustom !== b.isCustom) return a.isCustom ? -1 : 1;
        // Then alphabetically
        return a.relativePath.localeCompare(b.relativePath);
    });
}

function scanMobileDir(dir: string, prefix: string, mobiles: MobileEntry[], isCustom: boolean): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return; // Skip directories we can't read
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            // Skip conversations folder
            if (entry.name === 'conversations') continue;
            // Recurse into subdirectories
            scanMobileDir(fullPath, relPath, mobiles, isCustom);
        } else if (entry.name.endsWith('.lua') && entry.name !== 'serverobjects.lua') {
            // OPTIMIZATION: Don't read file contents during scan
            // Just record that the mobile exists
            const name = path.basename(entry.name, '.lua');
            // Folder is the directory path (or "mobile" for root level)
            const folder = prefix ? prefix.replace(/\\/g, '/') : 'mobile';
            mobiles.push({
                name,
                path: fullPath,
                relativePath: relPath,
                folder,
                isCustom,
                objectTemplatePath: undefined, // Lazy load when needed
                appearancePath: undefined, // Lazy load when needed
            });
        }
    }
}

/**
 * Lazy-load object template path from a mobile Lua file
 * Call this only when needed (e.g., when generating preview)
 */
export function loadObjectTemplatePath(mobile: MobileEntry): string | undefined {
    try {
        const content = fs.readFileSync(mobile.path, 'utf-8');

        // Extract object template path
        // Look for: objectTemplates = {"object/mobile/..."}
        const objectTemplateMatch = content.match(/objectTemplates\s*=\s*\{([^}]+)\}/);

        if (objectTemplateMatch) {
            // Extract first template (index 0)
            const templates = objectTemplateMatch[1];
            const firstTemplate = templates.match(/"([^"]+)"/);
            if (firstTemplate) {
                return firstTemplate[1];
            }
        }

        return undefined;
    } catch (e) {
        return undefined;
    }
}

/**
 * Find the appearance path by reading the object template
 */
function findAppearancePath(objectTemplatePath: string, paths: ScanPaths): string | undefined {
    // Try to find and read the shared object template
    // Convert object/mobile/foo.iff → object/mobile/shared_foo.iff
    const sharedPath = objectTemplatePath.replace(/\/([^/]+)\.iff$/, '/shared_$1.iff');

    // Check in working, infinity, vanilla
    for (const treePath of [paths.treWorking, paths.treInfinity, paths.treVanilla]) {
        const iffPath = path.join(treePath, sharedPath);
        if (fs.existsSync(iffPath)) {
            try {
                // Read IFF and extract appearance path
                // For now, return placeholder - full IFF parsing can be added later
                // This would use parseIFF from @swgemu/core
                return extractAppearanceFromIFF(iffPath);
            } catch (e) {
                continue;
            }
        }
    }

    return undefined;
}

/**
 * Extract appearance path from shared object IFF
 */
function extractAppearanceFromIFF(iffPath: string): string | undefined {
    try {
        const data = fs.readFileSync(iffPath);
        const content = data.toString('latin1');

        // Quick and dirty: search for .sat in the binary data
        const satMatch = content.match(/appearance\/[a-z0-9_/]+\.sat/i);
        if (satMatch) {
            return satMatch[0];
        }

        return undefined;
    } catch (e) {
        return undefined;
    }
}

/**
 * Lazy-load appearance path for a mobile entry
 * Call this only when needed (e.g., when user selects a mobile)
 */
export function loadAppearancePath(mobile: MobileEntry, paths: ScanPaths): string | undefined {
    if (!mobile.objectTemplatePath) {
        return undefined;
    }
    return findAppearancePath(mobile.objectTemplatePath, paths);
}

/**
 * Build a tree structure from flat mobile list
 */
export function buildMobileTree(mobiles: MobileEntry[]): any {
    const tree: any = {
        vanilla: {},
        custom: {},
    };

    for (const mobile of mobiles) {
        const root = mobile.isCustom ? tree.custom : tree.vanilla;
        const parts = mobile.relativePath.split('/');
        let node = root;

        // Build path
        for (let i = 0; i < parts.length - 1; i++) {
            if (!node[parts[i]]) {
                node[parts[i]] = {};
            }
            node = node[parts[i]];
        }

        // Add mobile as leaf
        const filename = parts[parts.length - 1];
        node[filename] = mobile;
    }

    return tree;
}
