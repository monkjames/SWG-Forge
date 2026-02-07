import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

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

    constructor(workspaceFolder: string) {
        this.workspaceFolder = workspaceFolder;
        this.workingFolder = path.join(workspaceFolder, 'tre/working');
    }

    async runAll(files: FileInfo[]): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];

        // Run each validation
        results.push(...await this.validateCRCTable(files));
        results.push(...await this.validateObjectStrings(files));
        results.push(...await this.validateSchematicStrings(files));

        // Add summary if all ok
        if (results.length === 0) {
            results.push({
                severity: 'ok',
                message: 'All validations passed'
            });
        }

        return results;
    }

    /**
     * Check if all object templates are registered in the CRC table
     */
    private async validateCRCTable(files: FileInfo[]): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];

        // Find object files (IFF files under object/)
        const objectFiles = files.filter(f =>
            f.relativePath.startsWith('object/') &&
            f.relativePath.endsWith('.iff')
        );

        if (objectFiles.length === 0) {
            return results;
        }

        // Load CRC table from working folder
        const crcTablePath = path.join(this.workingFolder, 'misc/object_template_crc_string_table.iff');
        if (!fs.existsSync(crcTablePath)) {
            // Try alternate locations
            const altPaths = [
                path.join(this.workspaceFolder, 'tre/infinity/misc/object_template_crc_string_table.iff'),
                path.join(this.workspaceFolder, 'tre/vanilla/misc/object_template_crc_string_table.iff')
            ];

            let found = false;
            for (const altPath of altPaths) {
                if (fs.existsSync(altPath)) {
                    found = true;
                    break;
                }
            }

            if (!found) {
                results.push({
                    severity: 'warning',
                    message: 'CRC table not found - cannot validate object registration'
                });
                return results;
            }
        }

        // Parse CRC table and check each object
        try {
            const crcEntries = await this.parseCRCTable(crcTablePath);
            const missingObjects: string[] = [];

            for (const objFile of objectFiles) {
                // Convert path to template path format
                const templatePath = objFile.relativePath.replace(/\.iff$/, '');

                if (!crcEntries.has(templatePath)) {
                    missingObjects.push(templatePath);
                }
            }

            if (missingObjects.length > 0) {
                if (missingObjects.length <= 3) {
                    results.push({
                        severity: 'error',
                        message: `Objects missing from CRC table: ${missingObjects.join(', ')}`
                    });
                } else {
                    results.push({
                        severity: 'error',
                        message: `${missingObjects.length} objects missing from CRC table (e.g., ${missingObjects.slice(0, 2).join(', ')}...)`
                    });
                }
            }
        } catch (e: any) {
            results.push({
                severity: 'warning',
                message: `Could not parse CRC table: ${e.message}`
            });
        }

        return results;
    }

    /**
     * Check if object templates have their strings defined
     */
    private async validateObjectStrings(files: FileInfo[]): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];

        // Find object files
        const objectFiles = files.filter(f =>
            f.relativePath.startsWith('object/') &&
            f.relativePath.endsWith('.iff') &&
            !f.relativePath.includes('/base/') &&
            f.relativePath.includes('shared_')  // Only check shared templates (client-visible)
        );

        if (objectFiles.length === 0) {
            return results;
        }

        // Load string tables
        const stringTables = await this.loadStringTables();

        if (stringTables.size === 0) {
            results.push({
                severity: 'warning',
                message: 'No string tables found - cannot validate object strings'
            });
            return results;
        }

        const missingStrings: string[] = [];

        for (const objFile of objectFiles) {
            // Extract expected string references from object path
            // e.g., object/tangible/food/shared_my_food.iff -> @obj_n:my_food, @obj_d:my_food
            const filename = path.basename(objFile.relativePath, '.iff').replace('shared_', '');

            // Check common string tables
            const expectedStrings = [
                { table: 'obj_n', key: filename },  // Object name
                { table: 'obj_d', key: filename },  // Object description
            ];

            for (const expected of expectedStrings) {
                const table = stringTables.get(expected.table);
                if (table && !table.has(expected.key)) {
                    // Only warn about missing name strings (descriptions optional)
                    if (expected.table === 'obj_n') {
                        missingStrings.push(`@${expected.table}:${expected.key}`);
                    }
                }
            }
        }

        if (missingStrings.length > 0) {
            if (missingStrings.length <= 3) {
                results.push({
                    severity: 'warning',
                    message: `Missing object strings: ${missingStrings.join(', ')}`
                });
            } else {
                results.push({
                    severity: 'warning',
                    message: `${missingStrings.length} objects missing name strings`
                });
            }
        }

        return results;
    }

    /**
     * Check if draft schematics have their LUA string references in the TRE
     */
    private async validateSchematicStrings(files: FileInfo[]): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];

        // Find draft schematic files
        const schematicFiles = files.filter(f =>
            f.relativePath.includes('draft_schematic') &&
            f.relativePath.endsWith('.iff')
        );

        if (schematicFiles.length === 0) {
            return results;
        }

        // Load string tables
        const stringTables = await this.loadStringTables();

        if (stringTables.size === 0) {
            return results;
        }

        const missingStrings: string[] = [];

        for (const schematicFile of schematicFiles) {
            const filename = path.basename(schematicFile.relativePath, '.iff').replace('shared_', '');

            // Check draft schematic string tables
            const expectedStrings = [
                { table: 'craft_n', key: filename },   // Schematic name
                { table: 'craft_d', key: filename },   // Schematic description
            ];

            for (const expected of expectedStrings) {
                const table = stringTables.get(expected.table);
                if (table && !table.has(expected.key)) {
                    if (expected.table === 'craft_n') {
                        missingStrings.push(`@${expected.table}:${expected.key}`);
                    }
                }
            }
        }

        if (missingStrings.length > 0) {
            if (missingStrings.length <= 3) {
                results.push({
                    severity: 'warning',
                    message: `Missing schematic strings: ${missingStrings.join(', ')}`
                });
            } else {
                results.push({
                    severity: 'warning',
                    message: `${missingStrings.length} schematics missing name strings`
                });
            }
        }

        return results;
    }

    /**
     * Parse CRC table and return set of registered paths
     */
    private async parseCRCTable(tablePath: string): Promise<Set<string>> {
        const entries = new Set<string>();

        if (!fs.existsSync(tablePath)) {
            return entries;
        }

        try {
            const data = fs.readFileSync(tablePath);

            // Parse IFF structure to find the string table
            // CRC table is an IFF with FORM CSTB containing DATA with CRC + string pairs
            let offset = 0;

            // Skip FORM header
            if (data.toString('ascii', 0, 4) === 'FORM') {
                offset = 12; // Skip FORM + size + type
            }

            // Look for DATA chunk
            while (offset < data.length - 8) {
                const chunkType = data.toString('ascii', offset, offset + 4);
                const chunkSize = data.readUInt32BE(offset + 4);

                if (chunkType === 'DATA') {
                    // Parse CRC entries
                    let dataOffset = offset + 8;
                    const dataEnd = dataOffset + chunkSize;

                    while (dataOffset < dataEnd - 4) {
                        // Skip CRC (4 bytes)
                        dataOffset += 4;

                        // Read null-terminated string
                        let strEnd = dataOffset;
                        while (strEnd < dataEnd && data[strEnd] !== 0) {
                            strEnd++;
                        }

                        if (strEnd > dataOffset) {
                            const str = data.toString('utf8', dataOffset, strEnd);
                            entries.add(str);
                        }

                        dataOffset = strEnd + 1;
                    }
                    break;
                }

                offset += 8 + chunkSize;
                // Align to 2-byte boundary
                if (chunkSize % 2 === 1) offset++;
            }
        } catch (e) {
            console.error('Error parsing CRC table:', e);
        }

        return entries;
    }

    /**
     * Load all string tables from working folder
     */
    private async loadStringTables(): Promise<Map<string, Set<string>>> {
        const tables = new Map<string, Set<string>>();

        // Look for string tables in working folder and infinity folder
        const searchPaths = [
            path.join(this.workingFolder, 'string/en'),
            path.join(this.workspaceFolder, 'tre/infinity/string/en'),
            path.join(this.workspaceFolder, 'tre/vanilla/string/en')
        ];

        for (const searchPath of searchPaths) {
            if (!fs.existsSync(searchPath)) continue;

            const files = fs.readdirSync(searchPath);
            for (const file of files) {
                if (!file.endsWith('.stf')) continue;

                const tableName = file.replace('.stf', '');
                if (tables.has(tableName)) continue; // Working takes priority

                try {
                    const keys = await this.parseSTF(path.join(searchPath, file));
                    tables.set(tableName, keys);
                } catch (e) {
                    // Ignore parse errors
                }
            }
        }

        return tables;
    }

    /**
     * Parse STF file and return set of string keys
     */
    private async parseSTF(stfPath: string): Promise<Set<string>> {
        const keys = new Set<string>();

        try {
            const data = fs.readFileSync(stfPath);

            // STF format: header + entries
            // Each entry has: id (4 bytes) + null-term string key + null-term unicode value

            if (data.length < 8) return keys;

            // Read header
            const magic = data.readUInt32LE(0);
            if (magic !== 0x00ABCD00) {
                // Try alternate format
                return keys;
            }

            const entryCount = data.readUInt32LE(4);
            let offset = 8;

            for (let i = 0; i < entryCount && offset < data.length; i++) {
                // Skip ID
                offset += 4;

                // Read key (null-terminated ASCII)
                let keyEnd = offset;
                while (keyEnd < data.length && data[keyEnd] !== 0) {
                    keyEnd++;
                }

                if (keyEnd > offset) {
                    const key = data.toString('ascii', offset, keyEnd);
                    keys.add(key);
                }

                offset = keyEnd + 1;

                // Skip value (null-terminated UTF-16LE)
                while (offset < data.length - 1) {
                    if (data[offset] === 0 && data[offset + 1] === 0) {
                        offset += 2;
                        break;
                    }
                    offset += 2;
                }
            }
        } catch (e) {
            // Ignore parse errors
        }

        return keys;
    }
}
