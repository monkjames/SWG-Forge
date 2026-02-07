/**
 * Staging Scanner - scans art_workshop/ folder tree for DDS files
 */

import * as fs from 'fs';
import * as path from 'path';
import { ART_TYPE_CONFIGS, ArtTypeConfig, StagedItem, PATHS } from './types';

/**
 * Read DDS header to extract width/height.
 * DDS format: 4-byte magic "DDS " then DDSURFACEDESC2 struct.
 * Height at offset 12, Width at offset 16 (little-endian uint32).
 */
function readDDSDimensions(filePath: string): { width: number; height: number } | null {
    try {
        const fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(20);
        fs.readSync(fd, header, 0, 20, 0);
        fs.closeSync(fd);

        // Check magic "DDS "
        if (header[0] !== 0x44 || header[1] !== 0x44 || header[2] !== 0x53 || header[3] !== 0x20) {
            return null;
        }

        const height = header.readUInt32LE(12);
        const width = header.readUInt32LE(16);
        return { width, height };
    } catch {
        return null;
    }
}

/**
 * Convert a DDS filename to a sanitized internal name.
 * "Sunset Over Theed.dds" → "sunset_over_theed"
 */
function sanitizeName(filename: string): string {
    return filename
        .replace(/\.dds$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * Convert a DDS filename to a human-readable display name suggestion.
 * "sunset_over_theed.dds" → "Sunset Over Theed"
 */
function humanizeName(filename: string): string {
    return filename
        .replace(/\.dds$/i, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
}

/**
 * Scan the staging folder and return all found DDS files with their type configs.
 */
export function scanStagingFolder(workspaceRoot: string): StagedItem[] {
    const stagingRoot = path.join(workspaceRoot, PATHS.STAGING_ROOT);
    const items: StagedItem[] = [];

    if (!fs.existsSync(stagingRoot)) {
        return items;
    }

    for (const config of ART_TYPE_CONFIGS) {
        const folderPath = path.join(stagingRoot, config.stagingFolder);
        if (!fs.existsSync(folderPath)) continue;

        const files = fs.readdirSync(folderPath)
            .filter(f => f.toLowerCase().endsWith('.dds'))
            .sort();

        for (const file of files) {
            const ddsPath = path.join(folderPath, file);
            const baseName = sanitizeName(file);
            const internalName = 'art_' + baseName;
            const warnings: string[] = [];

            // Read DDS dimensions
            const dims = readDDSDimensions(ddsPath);
            let ddsWidth: number | undefined;
            let ddsHeight: number | undefined;

            if (dims) {
                ddsWidth = dims.width;
                ddsHeight = dims.height;

                if (dims.width !== config.expectedWidth || dims.height !== config.expectedHeight) {
                    warnings.push(
                        `DDS is ${dims.width}x${dims.height}, expected ${config.expectedWidth}x${config.expectedHeight}`
                    );
                }
            } else {
                warnings.push('Could not read DDS header');
            }

            items.push({
                baseName,
                ddsPath,
                typeConfig: config,
                displayName: humanizeName(file),
                description: '',
                internalName,
                selected: true,
                ddsWidth,
                ddsHeight,
                warnings,
            });
        }
    }

    return items;
}

/**
 * Ensure the staging folder structure exists (create empty folders).
 */
export function ensureStagingFolders(workspaceRoot: string): void {
    const stagingRoot = path.join(workspaceRoot, PATHS.STAGING_ROOT);

    for (const config of ART_TYPE_CONFIGS) {
        const folderPath = path.join(stagingRoot, config.stagingFolder);
        fs.mkdirSync(folderPath, { recursive: true });
    }
}
