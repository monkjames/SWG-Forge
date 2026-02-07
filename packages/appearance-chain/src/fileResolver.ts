import * as fs from 'fs';
import * as path from 'path';
import { FileType } from './types';

const TRE_DIRS = ['tre/working', 'tre/vanilla', 'tre/infinity'] as const;
export type TRESource = 'working' | 'vanilla' | 'infinity';

export interface ResolvedFile {
    absolutePath: string;
    source: TRESource;
    fileSize: number;
}

/**
 * Given a TRE-relative path (e.g., "appearance/lod/foo.lod"),
 * search through working > vanilla > infinity and return the first match.
 */
export function resolveFile(trePath: string, workspaceRoot: string): ResolvedFile | null {
    const normalized = trePath.replace(/\\/g, '/');

    for (const dir of TRE_DIRS) {
        const fullPath = path.join(workspaceRoot, dir, normalized);
        if (fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            const source = dir.split('/')[1] as TRESource; // 'working', 'vanilla', or 'infinity'
            return {
                absolutePath: fullPath,
                source,
                fileSize: stats.size
            };
        }
    }

    return null;
}

/**
 * Determine the TRE-relative path from an absolute filesystem path.
 * E.g., /home/.../tre/vanilla/appearance/foo.apt -> "appearance/foo.apt"
 */
export function toTREPath(absolutePath: string, workspaceRoot: string): string | null {
    const normalized = absolutePath.replace(/\\/g, '/');
    const wsRoot = workspaceRoot.replace(/\\/g, '/');

    for (const dir of TRE_DIRS) {
        const prefix = path.join(wsRoot, dir).replace(/\\/g, '/') + '/';
        if (normalized.startsWith(prefix)) {
            return normalized.slice(prefix.length);
        }
    }

    return null;
}

/**
 * Determine the file type from a file path extension.
 */
export function getFileType(filePath: string): FileType {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.apt': return 'apt';
        case '.sat': return 'sat';
        case '.lod': return 'lod';
        case '.lmg': return 'lmg';
        case '.msh': return 'msh';
        case '.mgn': return 'mgn';
        case '.sht': return 'sht';
        case '.dds': return 'dds';
        case '.eft': return 'eft';
        case '.skt': return 'skt';
        case '.lat': return 'lat';
        case '.iff': return 'object';
        default: return 'unknown';
    }
}

/**
 * Check if a file is in the editable tre/working/ folder.
 */
export function isInWorkingFolder(absolutePath: string): boolean {
    return absolutePath.replace(/\\/g, '/').includes('/tre/working/');
}

/**
 * Normalize a reference path extracted from an IFF chunk.
 *
 * LOD CHLD/DATACHLD chunks use paths like "mesh/foo.msh" that need
 * "appearance/" prepended to become TRE-root-relative.
 * SHT .eft references may use backslashes.
 */
export function normalizeReferencePath(refPath: string, parentFileType: FileType): string {
    // Normalize backslashes to forward slashes
    let normalized = refPath.replace(/\\/g, '/');

    // LOD CHLD references: "mesh/foo.msh" -> "appearance/mesh/foo.msh"
    if (parentFileType === 'lod' && normalized.startsWith('mesh/')) {
        normalized = 'appearance/' + normalized;
    }

    return normalized;
}
