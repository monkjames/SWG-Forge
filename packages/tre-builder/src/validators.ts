import * as fs from 'fs';
import * as path from 'path';
import { parseCRCTable as coreParseCRCTable } from '@swgemu/core';

export interface ValidationResult {
    severity: 'error' | 'warning' | 'ok';
    message: string;
    file?: string;
}

interface FileInfo {
    relativePath: string;
    absolutePath: string;
}

export class Validator {
    private workspaceFolder: string;
    private workingFolder: string;
    private scriptsPath: string;
    private customScriptsFolder: string;

    constructor(workspaceFolder: string, scriptsPath?: string, customScriptsFolder?: string) {
        this.workspaceFolder = workspaceFolder;
        this.workingFolder = path.join(workspaceFolder, 'tre/working');
        this.scriptsPath = path.join(workspaceFolder, scriptsPath || 'infinity_wicked/MMOCoreORB/bin/scripts');
        this.customScriptsFolder = customScriptsFolder || 'custom_scripts';
    }

    async runAll(files: FileInfo[]): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];

        results.push(...await this.validateCRCTable(files));

        if (results.length === 0) {
            results.push({
                severity: 'ok',
                message: 'All validations passed'
            });
        }

        return results;
    }

    /**
     * Check if all object templates are registered in the CRC table.
     * Checks working first, then falls back to infinity and vanilla.
     * An object is valid if it appears in ANY of the available CRC tables.
     * Each missing object is reported individually.
     */
    private async validateCRCTable(files: FileInfo[]): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];

        const objectFiles = files.filter(f =>
            f.relativePath.startsWith('object/') &&
            f.relativePath.endsWith('.iff')
        );

        if (objectFiles.length === 0) {
            return results;
        }

        // Collect CRC entries from all available tables (working > infinity > vanilla)
        const crcTablePaths = [
            path.join(this.workingFolder, 'misc/object_template_crc_string_table.iff'),
            path.join(this.workspaceFolder, 'tre/infinity/misc/object_template_crc_string_table.iff'),
            path.join(this.workspaceFolder, 'tre/vanilla/misc/object_template_crc_string_table.iff')
        ];

        const allEntries = new Set<string>();
        let tableFound = false;

        for (const tablePath of crcTablePaths) {
            if (!fs.existsSync(tablePath)) { continue; }
            tableFound = true;
            try {
                const entries = await this.parseCRCTable(tablePath);
                for (const entry of entries) {
                    allEntries.add(entry);
                }
            } catch (e) {
                // Continue to next table
            }
        }

        if (!tableFound) {
            results.push({
                severity: 'warning',
                message: 'CRC table not found - cannot validate object registration'
            });
            return results;
        }

        // Check each object individually
        for (const objFile of objectFiles) {
            if (!allEntries.has(objFile.relativePath)) {
                const luaPath = this.findLuaTemplate(objFile.relativePath);
                const luaNote = luaPath
                    ? ` — Lua found`
                    : ` — no Lua found (check path?)`;
                results.push({
                    severity: 'error',
                    message: `Missing from CRC: ${objFile.relativePath}${luaNote}`,
                    file: objFile.relativePath
                });
            }
        }

        return results;
    }

    /**
     * Convert a TRE object path to its Lua template path and check if it exists.
     * e.g. object/tangible/item/shared_foo.iff → object/tangible/item/foo.lua
     * Searches: custom_scripts first, then vanilla scripts.
     */
    private findLuaTemplate(trePath: string): string | null {
        const dir = path.dirname(trePath);
        const basename = path.basename(trePath, '.iff');
        // Strip shared_ prefix
        const luaName = basename.startsWith('shared_')
            ? basename.slice(7) + '.lua'
            : basename + '.lua';
        const luaRelative = path.join(dir, luaName);

        // Check custom_scripts first, then vanilla scripts
        const candidates = [
            path.join(this.scriptsPath, this.customScriptsFolder, luaRelative),
            path.join(this.scriptsPath, luaRelative),
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * Parse CRC table and return set of registered paths.
     * Uses the core library's CSTB parser (CRCT/STRT/STNG chunks).
     */
    private async parseCRCTable(tablePath: string): Promise<Set<string>> {
        const entries = new Set<string>();

        if (!fs.existsSync(tablePath)) {
            return entries;
        }

        try {
            const data = fs.readFileSync(tablePath);
            const table = coreParseCRCTable(new Uint8Array(data));
            for (const entry of table.entries) {
                entries.add(entry.path);
            }
        } catch (e) {
            console.error('Error parsing CRC table:', e);
        }

        return entries;
    }
}
