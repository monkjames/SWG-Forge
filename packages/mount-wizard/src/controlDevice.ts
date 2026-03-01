/**
 * Control Device Creator
 * Clones pet/vehicle control device IFFs and creates accompanying Lua templates
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseIFF, serializeIFF, updateStringProperty } from './iffUtils';
import { addCRCEntry } from './crcTable';
import { MountType } from './types';

interface ControlDevicePaths {
    /** Base dir for IFF and Lua (e.g., "object/intangible/pet" or "object/intangible/vehicle") */
    iffBaseDir: string;
    /** Lua variable prefix (e.g., "object_intangible_pet" or "object_intangible_vehicle") */
    luaVarPrefix: string;
    /** Custom scripts directory relative to scripts root */
    customScriptsDir: string;
}

function getPathsForType(mountType: MountType): ControlDevicePaths {
    if (mountType === 'creature') {
        return {
            iffBaseDir: 'object/intangible/pet',
            luaVarPrefix: 'object_intangible_pet',
            customScriptsDir: 'custom_scripts/object/intangible/pet',
        };
    } else {
        return {
            iffBaseDir: 'object/intangible/vehicle',
            luaVarPrefix: 'object_intangible_vehicle',
            customScriptsDir: 'custom_scripts/object/intangible/vehicle',
        };
    }
}

/**
 * Find a reference control device IFF to clone from.
 * Returns the path to the reference file.
 */
export function findReferenceDevice(workspaceRoot: string, mountType: MountType, cloneFromName: string): string | null {
    const paths = getPathsForType(mountType);
    const sharedName = `shared_${cloneFromName}.iff`;

    // Search in tre/working → tre/vanilla → tre/infinity
    const searchDirs = ['working', 'vanilla', 'infinity'];
    for (const dir of searchDirs) {
        const fullPath = path.join(workspaceRoot, 'tre', dir, paths.iffBaseDir, sharedName);
        if (fs.existsSync(fullPath)) return fullPath;
    }
    return null;
}

/**
 * Get available control devices for the "Clone from" dropdown
 */
export function getAvailableDevices(workspaceRoot: string, mountType: MountType): string[] {
    const paths = getPathsForType(mountType);
    const devices = new Set<string>();

    for (const dir of ['working', 'vanilla', 'infinity']) {
        const dirPath = path.join(workspaceRoot, 'tre', dir, paths.iffBaseDir);
        if (!fs.existsSync(dirPath)) continue;

        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            if (file.startsWith('shared_') && file.endsWith('.iff')) {
                const name = file.replace(/^shared_/, '').replace(/\.iff$/, '');
                devices.add(name);
            }
        }
    }

    return Array.from(devices).sort();
}

/**
 * Create all control device files:
 * 1. Clone and modify the IFF file
 * 2. Create the Lua server template
 * 3. Append to shared objects.lua
 * 4. Append to serverobjects.lua
 * 5. Add CRC entry
 */
export function createControlDevice(
    workspaceRoot: string,
    mountType: MountType,
    deviceName: string,
    cloneFromName: string,
    newAppearanceFilename: string,
): { createdFiles: string[]; modifiedFiles: string[] } {
    const paths = getPathsForType(mountType);
    const scriptsBase = path.join(workspaceRoot, 'infinity_wicked/MMOCoreORB/bin/scripts');
    const createdFiles: string[] = [];
    const modifiedFiles: string[] = [];

    // 1. Clone IFF file
    const refPath = findReferenceDevice(workspaceRoot, mountType, cloneFromName);
    if (!refPath) {
        throw new Error(`Reference device not found: ${cloneFromName}`);
    }

    const refData = new Uint8Array(fs.readFileSync(refPath));
    const root = parseIFF(refData);

    // Update the appearanceFilename property
    updateStringProperty(root, 'appearanceFilename', newAppearanceFilename);

    const iffOutputPath = path.join(workspaceRoot, 'tre/working', paths.iffBaseDir, `shared_${deviceName}.iff`);
    const iffOutputDir = path.dirname(iffOutputPath);
    fs.mkdirSync(iffOutputDir, { recursive: true });
    fs.writeFileSync(iffOutputPath, serializeIFF(root));
    createdFiles.push(iffOutputPath);

    // 2. Create Lua server template
    const luaVarName = `${paths.luaVarPrefix}_${deviceName}`;
    const sharedLuaVarName = `${paths.luaVarPrefix}_shared_${deviceName}`;
    const iffPath = `${paths.iffBaseDir}/${deviceName}.iff`;

    const luaContent = `${luaVarName} = ${sharedLuaVarName}:new {\n\n}\n\nObjectTemplates:addTemplate(${luaVarName}, "${iffPath}")\n`;

    const luaFilePath = path.join(scriptsBase, paths.customScriptsDir, `${deviceName}.lua`);
    const luaDir = path.dirname(luaFilePath);
    fs.mkdirSync(luaDir, { recursive: true });
    fs.writeFileSync(luaFilePath, luaContent);
    createdFiles.push(luaFilePath);

    // 3. Append shared template to objects.lua
    const sharedIffPath = `${paths.iffBaseDir}/shared_${deviceName}.iff`;
    const sharedEntry = `\n${sharedLuaVarName} = SharedIntangibleObjectTemplate:new {\n\tclientTemplateFileName = "${sharedIffPath}"\n}\nObjectTemplates:addClientTemplate(${sharedLuaVarName}, "${sharedIffPath}")\n`;

    const objectsLuaPath = path.join(scriptsBase, paths.customScriptsDir, 'objects.lua');
    if (fs.existsSync(objectsLuaPath)) {
        const existing = fs.readFileSync(objectsLuaPath, 'utf-8');
        // Check if already exists
        if (!existing.includes(sharedLuaVarName)) {
            fs.appendFileSync(objectsLuaPath, sharedEntry);
            modifiedFiles.push(objectsLuaPath);
        }
    } else {
        fs.mkdirSync(path.dirname(objectsLuaPath), { recursive: true });
        fs.writeFileSync(objectsLuaPath, sharedEntry.trimStart());
        createdFiles.push(objectsLuaPath);
    }

    // 4. Append to serverobjects.lua
    const includeStatement = `includeFile("../custom_scripts/${paths.customScriptsDir.replace('custom_scripts/', '')}/${deviceName}.lua")\n`;

    const serverObjectsPath = path.join(scriptsBase, paths.customScriptsDir, 'serverobjects.lua');
    if (fs.existsSync(serverObjectsPath)) {
        const existing = fs.readFileSync(serverObjectsPath, 'utf-8');
        if (!existing.includes(`${deviceName}.lua`)) {
            fs.appendFileSync(serverObjectsPath, includeStatement);
            modifiedFiles.push(serverObjectsPath);
        }
    } else {
        fs.mkdirSync(path.dirname(serverObjectsPath), { recursive: true });
        fs.writeFileSync(serverObjectsPath, `\n${includeStatement}`);
        createdFiles.push(serverObjectsPath);
    }

    // 5. Add CRC entry
    addCRCEntry(workspaceRoot, sharedIffPath);

    return { createdFiles, modifiedFiles };
}
