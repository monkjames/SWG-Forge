import * as fs from 'fs';
import * as path from 'path';
import {
    parseIFF, serializeIFF, findForm, readNullString,
    extractStringProperty, cloneIFFWithReplacements,
    parseSTF, serializeSTF, addSTFEntries,
    parseCRCTable, addCRCEntries, serializeCRCTable
} from '@swgemu/core';
import type { StringReplacement, StringEntry, STFData } from '@swgemu/core';
import { ResolvedPaths } from './referenceResolver';

export interface ObjectConfig {
    /** Selected .apt path relative to tre/working, e.g. "appearance/my_model.apt" */
    appearancePath: string;
    /** Target folder, e.g. "object/tangible/item/quest" */
    targetFolder: string;
    /** Object name without shared_ prefix, e.g. "my_sword" */
    objectName: string;
    /** Display name for STF, e.g. "Ancient Blade" */
    displayName: string;
    /** Description for STF, e.g. "A blade from another era" */
    description: string;
    /** Absolute path to the reference IFF to clone */
    referenceIffPath: string;
    /** Menu component name (empty string if none) */
    menuComponent: string;
    /** Whether to create a new menu component stub */
    createMenuStub: boolean;
}

export interface GenerationResult {
    created: string[];
    modified: string[];
    errors: string[];
}

/** Generate all files for a new object */
export function generateObject(paths: ResolvedPaths, config: ObjectConfig): GenerationResult {
    const result: GenerationResult = { created: [], modified: [], errors: [] };

    try {
        generateIFF(paths, config, result);
        generateSTF(paths, config, result);
        updateCRC(paths, config, result);
        generateLuaTemplate(paths, config, result);
        updateServerObjects(paths, config, result);
        updateObjectsLua(paths, config, result);

        if (config.createMenuStub && config.menuComponent) {
            generateMenuStub(paths, config, result);
            registerMenuComponent(paths, config, result);
        }
    } catch (e: any) {
        result.errors.push('Unexpected error: ' + e.message);
    }

    return result;
}

// ── IFF Cloning ──────────────────────────────────────────────────

function generateIFF(paths: ResolvedPaths, config: ObjectConfig, result: GenerationResult) {
    const refData = fs.readFileSync(config.referenceIffPath);
    const refBytes = new Uint8Array(refData);

    // Parse the reference to find what we need to replace
    const extracted = extractIFFProperties(refBytes);
    const replacements: StringReplacement[] = [];

    // Replace appearance path
    if (extracted.appearancePath) {
        replacements.push({
            oldString: extracted.appearancePath,
            newString: config.appearancePath
        });
    }

    // Replace STF references for objectName
    const stfName = computeSTFName(config.targetFolder);
    if (extracted.objectNameStf) {
        replacements.push(
            { oldString: extracted.objectNameStf.file, newString: 'custom_content/' + stfName + '_n' },
            { oldString: extracted.objectNameStf.key, newString: config.objectName }
        );
    }

    // Replace STF references for detailedDescription
    if (extracted.descriptionStf) {
        // Only replace if different from objectName refs (avoid double-replace)
        if (extracted.descriptionStf.file !== extracted.objectNameStf?.file) {
            replacements.push(
                { oldString: extracted.descriptionStf.file, newString: 'custom_content/' + stfName + '_d' }
            );
        }
        if (extracted.descriptionStf.key !== extracted.objectNameStf?.key) {
            replacements.push(
                { oldString: extracted.descriptionStf.key, newString: config.objectName }
            );
        } else {
            // Same key as objectName — already replaced above.
            // But we need the description STF file to differ from the name STF file.
            // Since we use _n and _d suffix, the file replacement handles it.
        }
    }

    // Replace lookAtText if it exists
    if (extracted.lookAtTextStf) {
        if (extracted.lookAtTextStf.file !== extracted.objectNameStf?.file &&
            extracted.lookAtTextStf.file !== extracted.descriptionStf?.file) {
            replacements.push(
                { oldString: extracted.lookAtTextStf.file, newString: 'custom_content/' + stfName + '_n' }
            );
        }
        if (extracted.lookAtTextStf.key !== extracted.objectNameStf?.key &&
            extracted.lookAtTextStf.key !== extracted.descriptionStf?.key) {
            replacements.push(
                { oldString: extracted.lookAtTextStf.key, newString: config.objectName }
            );
        }
    }

    // Filter out empty/duplicate replacements
    const cleanReplacements = replacements.filter(r =>
        r.oldString && r.newString && r.oldString !== r.newString
    );

    const cloned = cloneIFFWithReplacements(refBytes, cleanReplacements);

    // Write the new IFF
    const iffDir = path.join(paths.treWorking, config.targetFolder);
    fs.mkdirSync(iffDir, { recursive: true });
    const iffPath = path.join(iffDir, 'shared_' + config.objectName + '.iff');
    fs.writeFileSync(iffPath, Buffer.from(cloned));
    result.created.push(iffPath);
}

interface ExtractedProps {
    appearancePath: string | null;
    objectNameStf: { file: string; key: string } | null;
    descriptionStf: { file: string; key: string } | null;
    lookAtTextStf: { file: string; key: string } | null;
}

/** Extract key properties from a shared object IFF for replacement */
function extractIFFProperties(data: Uint8Array): ExtractedProps {
    const result: ExtractedProps = {
        appearancePath: null,
        objectNameStf: null,
        descriptionStf: null,
        lookAtTextStf: null,
    };

    try {
        const root = parseIFF(data);
        // Find SHOT form, then version form inside it
        const shotForm = findForm(root, 'SHOT');
        if (!shotForm || !shotForm.children) { return result; }

        // The version form is the first child of SHOT (e.g. FORM 0007)
        const versionForm = shotForm.children.find(c => c.type === 'form');
        if (!versionForm || !versionForm.children) { return result; }

        // Iterate XXXX chunks to extract properties
        for (const chunk of versionForm.children) {
            if (chunk.type !== 'chunk' || chunk.tag !== 'XXXX' || !chunk.data) { continue; }
            const propData = chunk.data;

            // Read property name (null-terminated)
            const nameEnd = findNullByte(propData, 0);
            if (nameEnd < 0) { continue; }
            const propName = decodeString(propData, 0, nameEnd);
            const valueStart = nameEnd + 1;

            if (propName === 'appearanceFilename') {
                // Simple string: \x01 string \x00
                if (valueStart < propData.length && propData[valueStart] === 0x01) {
                    const strStart = valueStart + 1;
                    const strEnd = findNullByte(propData, strStart);
                    if (strEnd > strStart) {
                        result.appearancePath = decodeString(propData, strStart, strEnd);
                    }
                }
            } else if (propName === 'objectName') {
                result.objectNameStf = extractStringProperty(propData, valueStart);
            } else if (propName === 'detailedDescription') {
                result.descriptionStf = extractStringProperty(propData, valueStart);
            } else if (propName === 'lookAtText') {
                result.lookAtTextStf = extractStringProperty(propData, valueStart);
            }
        }
    } catch (e) {
        // If parsing fails, return what we have
    }

    return result;
}

function findNullByte(data: Uint8Array, offset: number): number {
    for (let i = offset; i < data.length; i++) {
        if (data[i] === 0) { return i; }
    }
    return -1;
}

function decodeString(data: Uint8Array, start: number, end: number): string {
    let s = '';
    for (let i = start; i < end; i++) { s += String.fromCharCode(data[i]); }
    return s;
}

// ── STF Strings ──────────────────────────────────────────────────

function generateSTF(paths: ResolvedPaths, config: ObjectConfig, result: GenerationResult) {
    const stfName = computeSTFName(config.targetFolder);

    // Name STF
    const nameStfRel = 'string/en/custom_content/' + stfName + '_n.stf';
    writeSTFEntry(paths, nameStfRel, config.objectName, config.displayName, result);

    // Description STF
    const descStfRel = 'string/en/custom_content/' + stfName + '_d.stf';
    writeSTFEntry(paths, descStfRel, config.objectName, config.description, result);
}

function writeSTFEntry(paths: ResolvedPaths, stfRelPath: string, id: string, value: string, result: GenerationResult) {
    const workingPath = path.join(paths.treWorking, stfRelPath);
    const infinityPath = path.join(paths.treInfinity, stfRelPath);

    let stf: STFData;
    let isNew = false;

    if (fs.existsSync(workingPath)) {
        // Read from working
        stf = parseSTF(new Uint8Array(fs.readFileSync(workingPath)));
    } else if (fs.existsSync(infinityPath)) {
        // Copy from infinity to working, then modify
        stf = parseSTF(new Uint8Array(fs.readFileSync(infinityPath)));
    } else {
        // Create new STF
        stf = { version: 1, nextUid: 1, entries: [] };
        isNew = true;
    }

    const entries: StringEntry[] = [{ id, value }];
    addSTFEntries(stf, entries);

    // Ensure directory exists
    fs.mkdirSync(path.dirname(workingPath), { recursive: true });
    fs.writeFileSync(workingPath, Buffer.from(serializeSTF(stf)));

    if (isNew) {
        result.created.push(workingPath);
    } else {
        result.modified.push(workingPath);
    }
}

// ── CRC Registration ─────────────────────────────────────────────

function updateCRC(paths: ResolvedPaths, config: ObjectConfig, result: GenerationResult) {
    const crcRelPath = 'misc/object_template_crc_string_table.iff';
    const workingCrc = path.join(paths.treWorking, crcRelPath);
    const infinityCrc = path.join(paths.treInfinity, crcRelPath);

    let crcPath: string;
    if (fs.existsSync(workingCrc)) {
        crcPath = workingCrc;
    } else if (fs.existsSync(infinityCrc)) {
        // Copy from infinity to working
        fs.mkdirSync(path.dirname(workingCrc), { recursive: true });
        fs.copyFileSync(infinityCrc, workingCrc);
        crcPath = workingCrc;
    } else {
        result.errors.push('No CRC table found in working or infinity');
        return;
    }

    const data = fs.readFileSync(crcPath);
    const table = parseCRCTable(new Uint8Array(data));
    const objectPath = config.targetFolder + '/shared_' + config.objectName + '.iff';
    const added = addCRCEntries(table, [objectPath]);

    if (added.length > 0) {
        fs.writeFileSync(crcPath, Buffer.from(serializeCRCTable(table)));
        result.modified.push(crcPath);
    }
}

// ── Lua Templates ────────────────────────────────────────────────

function generateLuaTemplate(paths: ResolvedPaths, config: ObjectConfig, result: GenerationResult) {
    const varPrefix = config.targetFolder.replace(/\//g, '_');
    const sharedVar = varPrefix + '_shared_' + config.objectName;
    const serverVar = varPrefix + '_' + config.objectName;
    const iffPath = config.targetFolder + '/' + config.objectName + '.iff';

    // Build server template content
    const lines: string[] = [];
    if (config.menuComponent) {
        lines.push(serverVar + ' = ' + sharedVar + ':new {');
        lines.push('\tobjectMenuComponent = "' + config.menuComponent + '",');
        lines.push('}');
    } else {
        lines.push(serverVar + ' = ' + sharedVar + ':new {');
        lines.push('}');
    }
    lines.push('ObjectTemplates:addTemplate(' + serverVar + ', "' + iffPath + '")');
    lines.push('');

    const luaDir = path.join(paths.customScriptsPath, config.targetFolder);
    fs.mkdirSync(luaDir, { recursive: true });
    const luaPath = path.join(luaDir, config.objectName + '.lua');
    fs.writeFileSync(luaPath, lines.join('\n'));
    result.created.push(luaPath);
}

function updateServerObjects(paths: ResolvedPaths, config: ObjectConfig, result: GenerationResult) {
    const leafDir = path.join(paths.customScriptsPath, config.targetFolder);
    const soPath = path.join(leafDir, 'serverobjects.lua');
    const includeLine = 'includeFile("../' + paths.customScriptsFolder + '/' +
        config.targetFolder + '/' + config.objectName + '.lua")\n';

    fs.mkdirSync(leafDir, { recursive: true });
    const isNew = !fs.existsSync(soPath);
    fs.appendFileSync(soPath, includeLine);

    if (isNew) {
        result.created.push(soPath);
        // Also register in top-level serverobjects.lua
        registerInTopLevel(paths, config.targetFolder, 'serverobjects.lua', result);
    } else {
        result.modified.push(soPath);
    }
}

function updateObjectsLua(paths: ResolvedPaths, config: ObjectConfig, result: GenerationResult) {
    const leafDir = path.join(paths.customScriptsPath, config.targetFolder);
    const objPath = path.join(leafDir, 'objects.lua');
    const varPrefix = config.targetFolder.replace(/\//g, '_');
    const sharedVar = varPrefix + '_shared_' + config.objectName;
    const sharedIff = config.targetFolder + '/shared_' + config.objectName + '.iff';

    const entry = '-- ' + config.objectName + '\n' +
        sharedVar + ' = SharedTangibleObjectTemplate:new {clientTemplateFileName = "' + sharedIff + '"}\n' +
        'ObjectTemplates:addClientTemplate(' + sharedVar + ', "' + sharedIff + '")\n\n';

    fs.mkdirSync(leafDir, { recursive: true });
    const isNew = !fs.existsSync(objPath);
    fs.appendFileSync(objPath, entry);

    if (isNew) {
        result.created.push(objPath);
        // Also register in top-level objects.lua
        registerInTopLevel(paths, config.targetFolder, 'objects.lua', result);
    } else {
        result.modified.push(objPath);
    }
}

function registerInTopLevel(paths: ResolvedPaths, targetFolder: string, filename: string, result: GenerationResult) {
    const topLevel = path.join(paths.customScriptsPath, 'object', filename);
    if (!fs.existsSync(topLevel)) {
        result.errors.push('Top-level ' + filename + ' not found at ' + topLevel);
        return;
    }

    const includeLine = '\nincludeFile("../' + paths.customScriptsFolder + '/' +
        targetFolder + '/' + filename + '")\n';

    // Check if already included
    const content = fs.readFileSync(topLevel, 'utf-8');
    if (content.includes(targetFolder + '/' + filename)) {
        return; // Already registered
    }

    fs.appendFileSync(topLevel, includeLine);
    result.modified.push(topLevel);
}

// ── Menu Component ───────────────────────────────────────────────

function generateMenuStub(paths: ResolvedPaths, config: ObjectConfig, result: GenerationResult) {
    const name = config.menuComponent;
    const lines = [
        'local ObjectManager = require("managers.object.object_manager")',
        '',
        name + ' = { }',
        '',
        'function ' + name + ':fillObjectMenuResponse(pSceneObject, pMenuResponse, pPlayer)',
        '\tlocal menuResponse = LuaObjectMenuResponse(pMenuResponse)',
        '\tmenuResponse:addRadialMenuItem(120, 3, "Use")',
        'end',
        '',
        'function ' + name + ':noCallback(pPlayer, pSui, eventIndex)',
        'end',
        '',
        'function ' + name + ':handleObjectMenuSelect(pSceneObject, pPlayer, selectedID)',
        '\tif (pPlayer == nil or pSceneObject == nil) then',
        '\t\treturn 0',
        '\tend',
        '',
        '\tif (selectedID == 120) then',
        '\t\tutil:cout(pPlayer, "do something here", "yellow")',
        '\tend',
        '\treturn 0',
        'end',
        '',
    ];

    const menusDir = path.join(paths.customScriptsPath, 'screenplays', 'menus');
    fs.mkdirSync(menusDir, { recursive: true });
    const stubPath = path.join(menusDir, name + '.lua');
    fs.writeFileSync(stubPath, lines.join('\n'));
    result.created.push(stubPath);
}

function registerMenuComponent(paths: ResolvedPaths, config: ObjectConfig, result: GenerationResult) {
    const soPath = path.join(paths.customScriptsPath, 'screenplays', 'menus', 'serverobjects.lua');
    if (!fs.existsSync(soPath)) {
        result.errors.push('Menu serverobjects.lua not found at ' + soPath);
        return;
    }

    const includeLine = 'includeFile("../' + paths.customScriptsFolder +
        '/screenplays/menus/' + config.menuComponent + '.lua")\n';

    const content = fs.readFileSync(soPath, 'utf-8');
    if (content.includes(config.menuComponent + '.lua')) {
        return; // Already registered
    }

    fs.appendFileSync(soPath, includeLine);
    result.modified.push(soPath);
}

// ── Utilities ────────────────────────────────────────────────────

/** Compute STF base name from target folder.
 *  object/tangible/item/quest → item_quest
 *  object/weapon/ranged/pistol → weapon_ranged_pistol
 */
export function computeSTFName(targetFolder: string): string {
    let parts = targetFolder.split('/');
    // Strip leading "object"
    if (parts[0] === 'object') { parts = parts.slice(1); }
    // Strip "tangible" if present (adds no useful info)
    if (parts[0] === 'tangible') { parts = parts.slice(1); }
    return parts.join('_');
}

/** Build the file list for the preview step */
export function buildPreview(paths: ResolvedPaths, config: ObjectConfig): { create: string[]; modify: string[] } {
    const create: string[] = [];
    const modify: string[] = [];

    // IFF
    create.push(path.join(paths.treWorking, config.targetFolder, 'shared_' + config.objectName + '.iff'));

    // Lua
    create.push(path.join(paths.customScriptsPath, config.targetFolder, config.objectName + '.lua'));

    // STF
    const stfName = computeSTFName(config.targetFolder);
    const nameStf = path.join(paths.treWorking, 'string/en/custom_content/' + stfName + '_n.stf');
    const descStf = path.join(paths.treWorking, 'string/en/custom_content/' + stfName + '_d.stf');
    if (fs.existsSync(nameStf)) { modify.push(nameStf); } else { create.push(nameStf); }
    if (fs.existsSync(descStf)) { modify.push(descStf); } else { create.push(descStf); }

    // CRC
    const crcWorking = path.join(paths.treWorking, 'misc/object_template_crc_string_table.iff');
    modify.push(crcWorking);

    // Leaf serverobjects.lua / objects.lua
    const leafSo = path.join(paths.customScriptsPath, config.targetFolder, 'serverobjects.lua');
    const leafObj = path.join(paths.customScriptsPath, config.targetFolder, 'objects.lua');
    if (fs.existsSync(leafSo)) { modify.push(leafSo); } else { create.push(leafSo); }
    if (fs.existsSync(leafObj)) { modify.push(leafObj); } else { create.push(leafObj); }

    // Top-level includes (if new folder)
    if (!fs.existsSync(leafSo)) {
        modify.push(path.join(paths.customScriptsPath, 'object/serverobjects.lua'));
    }
    if (!fs.existsSync(leafObj)) {
        modify.push(path.join(paths.customScriptsPath, 'object/objects.lua'));
    }

    // Menu component
    if (config.createMenuStub && config.menuComponent) {
        create.push(path.join(paths.customScriptsPath, 'screenplays/menus/' + config.menuComponent + '.lua'));
        modify.push(path.join(paths.customScriptsPath, 'screenplays/menus/serverobjects.lua'));
    }

    return { create, modify };
}
