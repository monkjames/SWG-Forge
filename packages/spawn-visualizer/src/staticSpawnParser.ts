/**
 * Screenplay Index Scanner — VSCode filesystem + caching layer.
 *
 * Uses @swgemu/core's pure parser and adds:
 *   - Recursive filesystem scanning of all screenplay directories
 *   - Timestamp-based delta caching (only re-parse changed files)
 *   - Override awareness (custom_scripts/ overrides vanilla screenplays/)
 *   - Query interface for consumers
 *
 * The index is stored in VSCode globalState and survives restarts.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {
    parseScreenplay,
    buildIndexEntry,
    createEmptyIndex,
    queryByPlanet,
    ScreenplayIndexData,
    ScreenplayCacheEntry,
    CoordinateEntry,
    ScreenplayCategory,
} from '@swgemu/core';

// Re-export types consumers need
export type { ScreenplayIndexData, ScreenplayCacheEntry, CoordinateEntry };

const CACHE_KEY = 'screenplay-index-v1';

/** Directories to scan (relative to scriptsPath) */
const SCREENPLAY_DIRS = [
    // Vanilla screenplays (change rarely — cache stays warm)
    'screenplays/static_spawns',
    'screenplays/caves',
    'screenplays/poi',
    'screenplays/cities',
    'screenplays/dungeon',
    'screenplays/themepark',
    'screenplays/events',
    'screenplays/gcw',
    // Custom scripts (override vanilla; may change more often)
    'custom_scripts/screenplays',
];

export interface ScanProgress {
    phase: string;
    filesScanned: number;
    filesTotal: number;
    filesUpdated: number;
}

/**
 * Load the screenplay index from cache, or build from scratch.
 * Uses delta refresh: only re-parses files whose mtime has changed.
 */
export async function loadScreenplayIndex(
    context: vscode.ExtensionContext,
    scriptsPath: string,
    progress?: (p: ScanProgress) => void
): Promise<ScreenplayIndexData> {
    // Load cached index
    let index = context.globalState.get<ScreenplayIndexData>(CACHE_KEY);
    if (!index || index.version !== 1) {
        index = createEmptyIndex();
    }

    // Discover all Lua files across screenplay directories
    progress?.({ phase: 'Discovering screenplay files...', filesScanned: 0, filesTotal: 0, filesUpdated: 0 });
    const allFiles = await discoverAllFiles(scriptsPath);
    const totalFiles = allFiles.length;

    // Build override map: basename → custom path (custom_scripts overrides vanilla)
    const overrideMap = buildOverrideMap(allFiles, scriptsPath);

    // Delta scan: check each file's mtime vs cache
    let scanned = 0;
    let updated = 0;
    const seenPaths = new Set<string>();

    for (const filePath of allFiles) {
        scanned++;
        seenPaths.add(filePath);

        // Skip vanilla files that have a custom override
        if (isOverridden(filePath, overrideMap, scriptsPath)) continue;

        if (scanned % 50 === 0) {
            progress?.({ phase: 'Scanning screenplays...', filesScanned: scanned, filesTotal: totalFiles, filesUpdated: updated });
        }

        const cached = index.files[filePath];
        let mtime: number;
        try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
            mtime = stat.mtime;
        } catch {
            continue;
        }

        // Skip if cached and unchanged
        if (cached && cached.index.mtime === mtime) continue;

        // Read and parse
        let content: string;
        try {
            content = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))).toString('utf-8');
        } catch {
            continue;
        }

        const result = parseScreenplay(content, filePath, mtime);
        if (result) {
            const idxEntry = buildIndexEntry(result);
            index.files[filePath] = { index: idxEntry, entries: result.entries };
            updated++;
        } else {
            // File has no coordinate data — remove from cache if it was there
            delete index.files[filePath];
        }
    }

    // Prune deleted files from cache
    for (const cachedPath of Object.keys(index.files)) {
        if (!seenPaths.has(cachedPath)) {
            delete index.files[cachedPath];
            updated++;
        }
    }

    // Save updated index
    if (updated > 0) {
        index.buildTimestamp = Date.now();
        await context.globalState.update(CACHE_KEY, index);
    }

    progress?.({ phase: 'Index ready', filesScanned: scanned, filesTotal: totalFiles, filesUpdated: updated });
    return index;
}

/**
 * Force a full rebuild of the index (clears cache first).
 */
export async function rebuildScreenplayIndex(
    context: vscode.ExtensionContext,
    scriptsPath: string,
    progress?: (p: ScanProgress) => void
): Promise<ScreenplayIndexData> {
    await context.globalState.update(CACHE_KEY, undefined);
    return loadScreenplayIndex(context, scriptsPath, progress);
}

/**
 * Query the index for all screenplay data matching a planet.
 * Returns entries sorted by category, then name.
 */
export function queryPlanetScreenplays(index: ScreenplayIndexData, planet: string): ScreenplayCacheEntry[] {
    const results = queryByPlanet(index, planet);
    const catOrder: { [k: string]: number } = { cave: 0, poi: 1, city: 2, static: 3, dungeon: 4, themepark: 5, event: 6, custom: 7, other: 8 };
    results.sort((a, b) => {
        const ca = catOrder[a.index.category] ?? 9;
        const cb = catOrder[b.index.category] ?? 9;
        if (ca !== cb) return ca - cb;
        return a.index.name < b.index.name ? -1 : a.index.name > b.index.name ? 1 : 0;
    });
    return results;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Recursively find all .lua files across all screenplay directories.
 */
async function discoverAllFiles(scriptsPath: string): Promise<string[]> {
    const allFiles: string[] = [];
    for (const relDir of SCREENPLAY_DIRS) {
        const absDir = path.join(scriptsPath, relDir);
        const files = await findLuaFilesRecursive(absDir);
        allFiles.push(...files);
    }
    return allFiles;
}

async function findLuaFilesRecursive(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
        for (const [name, type] of entries) {
            const fullPath = path.join(dir, name);
            if (type === vscode.FileType.File && name.endsWith('.lua')) {
                results.push(fullPath);
            } else if (type === vscode.FileType.Directory) {
                const sub = await findLuaFilesRecursive(fullPath);
                results.push(...sub);
            }
        }
    } catch { /* directory doesn't exist */ }
    return results;
}

/**
 * Build a map of overrides: for each vanilla screenplay basename, record the
 * custom_scripts path that overrides it (if any).
 *
 * Override logic: if custom_scripts/screenplays/.../foo.lua exists,
 * it overrides screenplays/.../foo.lua (same basename).
 */
function buildOverrideMap(allFiles: string[], scriptsPath: string): Map<string, string> {
    const customPrefix = path.join(scriptsPath, 'custom_scripts', 'screenplays');
    const overrides = new Map<string, string>();

    // Collect all custom basenames
    for (const f of allFiles) {
        if (f.startsWith(customPrefix)) {
            const base = path.basename(f);
            overrides.set(base, f);
        }
    }

    return overrides;
}

/**
 * Check if a vanilla file is overridden by a custom_scripts version.
 */
function isOverridden(filePath: string, overrideMap: Map<string, string>, scriptsPath: string): boolean {
    const customPrefix = path.join(scriptsPath, 'custom_scripts', 'screenplays');
    // Only vanilla files can be overridden
    if (filePath.startsWith(customPrefix)) return false;

    const base = path.basename(filePath);
    const customPath = overrideMap.get(base);
    // Overridden if a custom file with the same basename exists and it's not the same file
    return customPath !== undefined && customPath !== filePath;
}
