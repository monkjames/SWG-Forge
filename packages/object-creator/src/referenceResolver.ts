import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ResolvedPaths {
    workspaceRoot: string;
    treWorking: string;
    treInfinity: string;
    treVanilla: string;
    scriptsPath: string;
    customScriptsPath: string;
    customScriptsFolder: string;
}

/** Read SWG Forge config and resolve all paths */
export function getResolvedPaths(): ResolvedPaths | null {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) { return null; }

    const forge = vscode.workspace.getConfiguration('swgForge');
    const scriptsRel = forge.get<string>('serverScriptsPath', 'infinity_wicked/MMOCoreORB/bin/scripts')!;
    const csFolder = forge.get<string>('customScriptsFolder', 'custom_scripts')!;

    return {
        workspaceRoot: wsRoot,
        treWorking: path.join(wsRoot, forge.get<string>('tre.workingPath', 'tre/working')!),
        treInfinity: path.join(wsRoot, forge.get<string>('tre.referencePath', 'tre/infinity')!),
        treVanilla: path.join(wsRoot, forge.get<string>('tre.vanillaPath', 'tre/vanilla')!),
        scriptsPath: path.join(wsRoot, scriptsRel),
        customScriptsPath: path.join(wsRoot, scriptsRel, csFolder),
        customScriptsFolder: csFolder,
    };
}

/** Scan for .apt files in tre/working/appearance/ */
export function scanAppearances(paths: ResolvedPaths): string[] {
    const appearanceDir = path.join(paths.treWorking, 'appearance');
    if (!fs.existsSync(appearanceDir)) { return []; }

    const results: string[] = [];
    function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.apt')) {
                // Return relative to tre/working, e.g. "appearance/my_model.apt"
                results.push(path.relative(paths.treWorking, full).replace(/\\/g, '/'));
            }
        }
    }
    walk(appearanceDir);
    results.sort();
    return results;
}

/** Find all object folders that contain shared_*.iff across all three tiers */
export function scanObjectFolders(paths: ResolvedPaths): string[] {
    const folders = new Set<string>();

    for (const root of [paths.treWorking, paths.treInfinity, paths.treVanilla]) {
        const objDir = path.join(root, 'object');
        if (!fs.existsSync(objDir)) { continue; }
        walkForSharedIff(objDir, root, folders);
    }

    const sorted = Array.from(folders).sort();
    return sorted;
}

function walkForSharedIff(dir: string, rootDir: string, folders: Set<string>) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    let hasShared = false;
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkForSharedIff(full, rootDir, folders);
        } else if (entry.name.startsWith('shared_') && entry.name.endsWith('.iff')) {
            hasShared = true;
        }
    }
    if (hasShared) {
        folders.add(path.relative(rootDir, dir).replace(/\\/g, '/'));
    }
}

/** Find a reference shared_*.iff in the target folder (working → infinity → vanilla) */
export function findReferenceIFF(paths: ResolvedPaths, targetFolder: string): { absolutePath: string; filename: string } | null {
    for (const root of [paths.treWorking, paths.treInfinity, paths.treVanilla]) {
        const dir = path.join(root, targetFolder);
        if (!fs.existsSync(dir)) { continue; }
        try {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                if (entry.startsWith('shared_') && entry.endsWith('.iff')) {
                    return { absolutePath: path.join(dir, entry), filename: entry };
                }
            }
        } catch { /* continue */ }
    }
    return null;
}

/** List existing menu component .lua files in custom_scripts/screenplays/menus/ */
export function scanMenuComponents(paths: ResolvedPaths): string[] {
    const menusDir = path.join(paths.customScriptsPath, 'screenplays', 'menus');
    if (!fs.existsSync(menusDir)) { return []; }

    const results: string[] = [];
    try {
        for (const entry of fs.readdirSync(menusDir)) {
            if (entry.endsWith('.lua') && entry !== 'serverobjects.lua') {
                // Return the component name (filename without .lua)
                results.push(entry.replace(/\.lua$/, ''));
            }
        }
    } catch { /* empty */ }
    results.sort();
    return results;
}

/** Check if a name already exists in the target folder (CRC, Lua, or IFF) */
export function checkNameCollision(paths: ResolvedPaths, targetFolder: string, objectName: string): string[] {
    const collisions: string[] = [];

    // Check IFF existence
    const iffPath = path.join(paths.treWorking, targetFolder, 'shared_' + objectName + '.iff');
    if (fs.existsSync(iffPath)) {
        collisions.push('IFF already exists: ' + iffPath);
    }

    // Check Lua existence
    const luaPath = path.join(paths.customScriptsPath, targetFolder, objectName + '.lua');
    if (fs.existsSync(luaPath)) {
        collisions.push('Lua template already exists: ' + luaPath);
    }

    return collisions;
}
