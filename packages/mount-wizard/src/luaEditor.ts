/**
 * Lua Editor - Text-based modifications to existing Lua files
 */

import * as fs from 'fs';
import * as path from 'path';
import { MountType, MountWizardConfig } from './types';

/**
 * Update a mobile template's tamingChance and controlDeviceTemplate fields
 */
export function updateMobileTemplate(
    filePath: string,
    mountType: MountType,
    tamingChance: number,
    controlDeviceName: string,
): void {
    let content = fs.readFileSync(filePath, 'utf-8');

    // Determine control device path based on mount type
    const devicePath = mountType === 'creature'
        ? `object/intangible/pet/${controlDeviceName}.iff`
        : `object/intangible/vehicle/${controlDeviceName}.iff`;

    // Update or add tamingChance (creature mounts only)
    if (mountType === 'creature') {
        if (/tamingChance\s*=/.test(content)) {
            content = content.replace(
                /tamingChance\s*=\s*[\d.]+/,
                `tamingChance = ${tamingChance}`
            );
        } else {
            // Add tamingChance before the first closing brace of the creature definition
            content = insertFieldBeforeClose(content, `\ttamingChance = ${tamingChance},`);
        }
    }

    // Update or add controlDeviceTemplate
    if (/controlDeviceTemplate\s*=/.test(content)) {
        content = content.replace(
            /controlDeviceTemplate\s*=\s*"[^"]*"/,
            `controlDeviceTemplate = "${devicePath}"`
        );
    } else {
        content = insertFieldBeforeClose(content, `\tcontrolDeviceTemplate = "${devicePath}",`);
    }

    fs.writeFileSync(filePath, content);
}

/**
 * Update slotDescriptorFilename in object/mobile/objects.lua to mount_rider.iff
 */
export function updateSlotDescriptor(
    workspaceRoot: string,
    sharedVarName: string,
): { filePath: string; updated: boolean } {
    const scriptsBase = path.join(workspaceRoot, 'infinity4.0.0/MMOCoreORB/bin/scripts');
    const searchPaths = [
        path.join(scriptsBase, 'object/mobile/objects.lua'),
        path.join(scriptsBase, 'custom_scripts/object/mobile/objects.lua'),
    ];

    for (const luaPath of searchPaths) {
        if (!fs.existsSync(luaPath)) continue;
        let content = fs.readFileSync(luaPath, 'utf-8');

        // Find the shared template block
        const blockRegex = new RegExp(
            `(${sharedVarName}\\s*=\\s*SharedCreatureObjectTemplate:new\\s*\\{[\\s\\S]*?)\\}`,
            'm'
        );
        const match = content.match(blockRegex);
        if (!match) continue;

        const block = match[1];

        // Check if it already has mount_rider
        if (block.includes('mount_rider.iff')) {
            return { filePath: luaPath, updated: false };
        }

        if (/slotDescriptorFilename\s*=\s*"[^"]*"/.test(block)) {
            // Replace existing slot descriptor
            content = content.replace(
                new RegExp(`(${sharedVarName}\\s*=\\s*SharedCreatureObjectTemplate:new\\s*\\{[\\s\\S]*?)slotDescriptorFilename\\s*=\\s*"[^"]*"`),
                `$1slotDescriptorFilename = "abstract/slot/descriptor/mount_rider.iff"`
            );
        } else {
            // No slotDescriptorFilename exists (common for single-line custom entries).
            // Expand the block to add it before the closing brace.
            const fullBlockRegex = new RegExp(
                `(${sharedVarName}\\s*=\\s*SharedCreatureObjectTemplate:new\\s*\\{[\\s\\S]*?)\\}`,
                'm'
            );
            const fullMatch = content.match(fullBlockRegex);
            if (fullMatch) {
                const blockContent = fullMatch[1];
                // Add comma after last property if needed, then add slotDescriptorFilename
                const trimmed = blockContent.trimEnd();
                const needsComma = !trimmed.endsWith(',') && !trimmed.endsWith('{');
                const replacement = trimmed + (needsComma ? ',' : '') +
                    '\n\tslotDescriptorFilename = "abstract/slot/descriptor/mount_rider.iff",\n}';
                content = content.replace(fullBlockRegex, replacement);
            }
        }

        fs.writeFileSync(luaPath, content);
        return { filePath: luaPath, updated: true };
    }

    return { filePath: '', updated: false };
}

/**
 * Add a mount speed entry to pet_manager.lua
 */
export function addMountSpeedData(
    workspaceRoot: string,
    appearanceFilename: string,
    runSpeed: number,
    gallopMultiplier: number,
    gallopDuration: number,
    gallopCooldown: number,
): void {
    const filePath = path.join(
        workspaceRoot,
        'infinity4.0.0/MMOCoreORB/bin/scripts/managers/pet_manager.lua'
    );
    let content = fs.readFileSync(filePath, 'utf-8');

    // Check if already exists
    if (content.includes(`"${appearanceFilename}"`)) return;

    // Find the closing brace of mountSpeedData table
    // Pattern: mountSpeedData = { ... \n}
    const tableEnd = content.indexOf('\n}', content.indexOf('mountSpeedData'));
    if (tableEnd < 0) {
        throw new Error('Could not find mountSpeedData table in pet_manager.lua');
    }

    const newEntry = `\t{"${appearanceFilename}", ${runSpeed}, ${gallopMultiplier}, ${gallopDuration}, ${gallopCooldown}},\n`;

    content = content.substring(0, tableEnd) + newEntry + content.substring(tableEnd);
    fs.writeFileSync(filePath, content);
}

/**
 * Insert a field line before the first closing brace of a Creature:new block.
 * Used when a field doesn't exist yet in the template.
 */
function insertFieldBeforeClose(content: string, fieldLine: string): string {
    // Find the Creature:new { ... } block
    const creatureStart = content.indexOf('Creature:new');
    if (creatureStart < 0) return content;

    // Find the matching closing brace
    let braceDepth = 0;
    let inBlock = false;
    for (let i = creatureStart; i < content.length; i++) {
        if (content[i] === '{') {
            braceDepth++;
            inBlock = true;
        } else if (content[i] === '}') {
            braceDepth--;
            if (inBlock && braceDepth === 0) {
                // Insert before this closing brace
                // Find the previous newline
                let insertPos = i;
                while (insertPos > 0 && content[insertPos - 1] !== '\n') insertPos--;
                return content.substring(0, insertPos) + fieldLine + '\n' + content.substring(insertPos);
            }
        }
    }
    return content;
}
