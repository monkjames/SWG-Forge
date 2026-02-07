/**
 * Parse mobile .lua templates to extract creature data
 */

import * as fs from 'fs';
import { MobileTemplate } from './types';

/**
 * Parse a mobile Lua template file and extract mount-relevant fields
 */
export function parseMobileTemplate(filePath: string): MobileTemplate {
    const content = fs.readFileSync(filePath, 'utf-8');

    const creatureName = extractCreatureName(content);
    const tamingChance = extractNumber(content, 'tamingChance') ?? 0;
    const controlDeviceTemplate = extractString(content, 'controlDeviceTemplate') ?? '';
    const objectTemplates = extractStringArray(content, 'templates');
    const ferocity = extractNumber(content, 'ferocity') ?? 0;
    const creatureBitmask = extractRawValue(content, 'creatureBitmask') ?? '';
    const objectName = extractString(content, 'objectName') ?? '';
    const mobType = extractRawValue(content, 'mobType') ?? '';

    return {
        creatureName,
        filePath,
        tamingChance,
        controlDeviceTemplate,
        objectTemplates,
        ferocity,
        creatureBitmask,
        objectName,
        mobType,
    };
}

/** Extract creature name from CreatureTemplates:addCreatureTemplate(varName, "name") */
function extractCreatureName(content: string): string {
    // Pattern: CreatureTemplates:addCreatureTemplate(varName, "name")
    const match = content.match(/CreatureTemplates:addCreatureTemplate\(\s*\w+\s*,\s*"([^"]+)"\s*\)/);
    if (match) return match[1];

    // Fallback: try to get the variable name from the assignment
    const assignMatch = content.match(/^(\w+)\s*=\s*Creature:new\s*\{/m);
    if (assignMatch) return assignMatch[1];

    return 'unknown';
}

/** Extract a numeric field like: tamingChance = 0.25 */
function extractNumber(content: string, field: string): number | null {
    const regex = new RegExp(`${field}\\s*=\\s*([\\d.]+)`);
    const match = content.match(regex);
    return match ? parseFloat(match[1]) : null;
}

/** Extract a quoted string field like: controlDeviceTemplate = "path/to/file.iff" */
function extractString(content: string, field: string): string | null {
    const regex = new RegExp(`${field}\\s*=\\s*"([^"]+)"`);
    const match = content.match(regex);
    return match ? match[1] : null;
}

/** Extract the raw value of a field (for bitmask flags like PACK + KILLER) */
function extractRawValue(content: string, field: string): string | null {
    const regex = new RegExp(`${field}\\s*=\\s*(.+?)\\s*,?\\s*$`, 'm');
    const match = content.match(regex);
    return match ? match[1].trim().replace(/,\s*$/, '') : null;
}

/** Extract a string array like: templates = {"object/mobile/kaadu_hue.iff"} */
function extractStringArray(content: string, field: string): string[] {
    const regex = new RegExp(`${field}\\s*=\\s*\\{([^}]+)\\}`);
    const match = content.match(regex);
    if (!match) return [];

    const items: string[] = [];
    const itemRegex = /"([^"]+)"/g;
    let m;
    while ((m = itemRegex.exec(match[1])) !== null) {
        items.push(m[1]);
    }
    return items;
}

/**
 * Derive the shared object template variable name from an IFF path.
 * e.g., "object/mobile/kaadu_hue.iff" → "object_mobile_shared_kaadu_hue"
 */
export function iffPathToLuaVar(iffPath: string): string {
    // Remove .iff extension
    let name = iffPath.replace(/\.iff$/, '');
    // Replace slashes with underscores
    name = name.replace(/\//g, '_');
    // Insert "shared_" before the last segment
    const parts = name.split('_');
    // Find the position after the directory parts
    // object/mobile/kaadu_hue.iff → object_mobile_kaadu_hue → insert shared_ before kaadu_hue
    // We need to find where the directory path ends
    const dirPath = iffPath.substring(0, iffPath.lastIndexOf('/'));
    const fileName = iffPath.substring(iffPath.lastIndexOf('/') + 1).replace(/\.iff$/, '');
    return dirPath.replace(/\//g, '_') + '_shared_' + fileName;
}
