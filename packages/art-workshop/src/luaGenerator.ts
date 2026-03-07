/**
 * Lua Generator - creates and updates Lua template files
 */

import * as fs from 'fs';
import * as path from 'path';
import { StagedItem, LootGroup, PATHS } from './types';

/**
 * Generate shared object template entry for objects.lua
 */
function objectsLuaEntry(item: StagedItem): string {
    const varName = `object_tangible_painting_shared_${item.internalName}`;
    const iffPath = `object/tangible/painting/shared_${item.internalName}.iff`;
    return [
        `-- ${item.displayName}`,
        `${varName} = SharedTangibleObjectTemplate:new {`,
        `\tclientTemplateFileName = "${iffPath}"`,
        `}`,
        `ObjectTemplates:addClientTemplate(${varName}, "${iffPath}")`,
        '',
    ].join('\n');
}

/**
 * Generate server object template for an individual .lua file
 */
function serverObjectLua(item: StagedItem): string {
    const sharedVar = `object_tangible_painting_shared_${item.internalName}`;
    const serverVar = `object_tangible_painting_${item.internalName}`;
    const iffPath = `object/tangible/painting/${item.internalName}.iff`;
    return [
        `${serverVar} = ${sharedVar}:new {`,
        `}`,
        `ObjectTemplates:addTemplate(${serverVar}, "${iffPath}")`,
        '',
    ].join('\n');
}

/**
 * Generate a loot item template .lua file
 */
function lootItemLua(item: StagedItem): string {
    const iffPath = `object/tangible/painting/${item.internalName}.iff`;
    return [
        `${item.internalName} = {`,
        `\tminimumLevel = 0,`,
        `\tmaximumLevel = 0,`,
        `\tcustomObjectName = "",`,
        `\tdirectObjectTemplate = "${iffPath}",`,
        `\tcraftingValues = {},`,
        `\tcustomizationStringNames = {},`,
        `\tcustomizationValues = {}`,
        `}`,
        `addLootItemTemplate("${item.internalName}", ${item.internalName})`,
        '',
    ].join('\n');
}

/**
 * Generate a loot group template .lua file
 */
function lootGroupLua(group: LootGroup): string {
    const totalWeight = 10000000;
    const perItemWeight = Math.floor(totalWeight / group.items.length);
    // Distribute remainder to first item
    const remainder = totalWeight - (perItemWeight * group.items.length);

    const itemLines = group.items.map((itemName, idx) => {
        const weight = idx === 0 ? perItemWeight + remainder : perItemWeight;
        return `\t\t{itemTemplate = "${itemName}", weight = ${weight}},`;
    });

    return [
        `${group.name} = {`,
        `\tdescription = "",`,
        `\tminimumLevel = 0,`,
        `\tmaximumLevel = -1,`,
        `\tlootItems = {`,
        ...itemLines,
        `\t}`,
        `}`,
        `addLootGroupTemplate("${group.name}", ${group.name})`,
        '',
    ].join('\n');
}

// ─── File Operations ────────────────────────────────────────────────────────

/**
 * Append entries to the painting objects.lua file (shared templates).
 */
export function updateObjectsLua(workspaceRoot: string, items: StagedItem[]): string {
    const luaPath = path.join(
        workspaceRoot, PATHS.CUSTOM_SCRIPTS,
        'object/tangible/painting/objects.lua'
    );

    let content = '';
    if (fs.existsSync(luaPath)) {
        content = fs.readFileSync(luaPath, 'utf-8');
    } else {
        fs.mkdirSync(path.dirname(luaPath), { recursive: true });
    }

    const newEntries = items
        .filter(item => !content.includes(`shared_${item.internalName}`))
        .map(item => objectsLuaEntry(item))
        .join('\n');

    if (newEntries) {
        content = content.trimEnd() + '\n\n' + newEntries;
        fs.writeFileSync(luaPath, content);
    }

    return luaPath;
}

/**
 * Create individual server object .lua files and update serverobjects.lua.
 */
export function updateServerObjectsLua(workspaceRoot: string, items: StagedItem[]): string[] {
    const baseDir = path.join(
        workspaceRoot, PATHS.CUSTOM_SCRIPTS,
        'object/tangible/painting'
    );
    fs.mkdirSync(baseDir, { recursive: true });

    const createdFiles: string[] = [];

    // Create individual .lua files
    for (const item of items) {
        const luaFile = path.join(baseDir, `${item.internalName}.lua`);
        if (!fs.existsSync(luaFile)) {
            fs.writeFileSync(luaFile, serverObjectLua(item));
            createdFiles.push(luaFile);
        }
    }

    // Update serverobjects.lua with includes
    const soPath = path.join(baseDir, 'serverobjects.lua');
    let soContent = '';
    if (fs.existsSync(soPath)) {
        soContent = fs.readFileSync(soPath, 'utf-8');
    }

    const newIncludes = items
        .filter(item => !soContent.includes(item.internalName))
        .map(item => `includeFile("../custom_scripts/object/tangible/painting/${item.internalName}.lua")`)
        .join('\n');

    if (newIncludes) {
        soContent = soContent.trimEnd() + '\n' + newIncludes + '\n';
        fs.writeFileSync(soPath, soContent);
        createdFiles.push(soPath);
    }

    return createdFiles;
}

/**
 * Create loot item .lua files and update loot serverobjects.lua.
 */
export function createLootItems(workspaceRoot: string, items: StagedItem[]): string[] {
    const lootDir = path.join(
        workspaceRoot, PATHS.CUSTOM_SCRIPTS,
        'loot/items/painting'
    );
    fs.mkdirSync(lootDir, { recursive: true });

    const createdFiles: string[] = [];

    for (const item of items) {
        const luaFile = path.join(lootDir, `${item.internalName}.lua`);
        if (!fs.existsSync(luaFile)) {
            fs.writeFileSync(luaFile, lootItemLua(item));
            createdFiles.push(luaFile);
        }
    }

    // Update loot items serverobjects.lua
    const soPath = path.join(lootDir, 'serverobjects.lua');
    let soContent = '';
    if (fs.existsSync(soPath)) {
        soContent = fs.readFileSync(soPath, 'utf-8');
    }

    const newIncludes = items
        .filter(item => !soContent.includes(item.internalName))
        .map(item => `includeFile("../custom_scripts/loot/items/painting/${item.internalName}.lua")`)
        .join('\n');

    if (newIncludes) {
        soContent = soContent.trimEnd() + '\n' + newIncludes + '\n';
        fs.writeFileSync(soPath, soContent);
        createdFiles.push(soPath);
    }

    return createdFiles;
}

/**
 * Create loot group .lua files and update loot groups serverobjects.lua.
 */
export function createLootGroups(workspaceRoot: string, groups: LootGroup[]): string[] {
    const groupDir = path.join(
        workspaceRoot, PATHS.CUSTOM_SCRIPTS,
        'loot/groups'
    );
    fs.mkdirSync(groupDir, { recursive: true });

    const createdFiles: string[] = [];

    for (const group of groups) {
        if (group.items.length === 0) continue;
        const luaFile = path.join(groupDir, `${group.name}.lua`);
        fs.writeFileSync(luaFile, lootGroupLua(group));
        createdFiles.push(luaFile);
    }

    // Update loot groups serverobjects.lua
    const soPath = path.join(groupDir, 'serverobjects.lua');
    let soContent = '';
    if (fs.existsSync(soPath)) {
        soContent = fs.readFileSync(soPath, 'utf-8');
    }

    const newIncludes = groups
        .filter(g => g.items.length > 0 && !soContent.includes(g.name))
        .map(g => `includeFile("../custom_scripts/loot/groups/${g.name}.lua")`)
        .join('\n');

    if (newIncludes) {
        soContent = soContent.trimEnd() + '\n' + newIncludes + '\n';
        fs.writeFileSync(soPath, soContent);
        createdFiles.push(soPath);
    }

    return createdFiles;
}
