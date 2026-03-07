/**
 * IFF Template Cloner
 *
 * Clones SWG shared template IFF files by replacing embedded string references.
 * This is used to create new armor/weapon/clothing IFF files from existing ones.
 *
 * Shared templates embed strings in two formats:
 * 1. STF references: \x01\x01file\x00\x01key\x00  (e.g. @wearables_name:armor_helmet)
 * 2. Path strings: null-terminated ASCII paths (e.g. appearance/armor_helmet_m.sat)
 *
 * The cloner does binary search-and-replace on these patterns.
 */

/**
 * Replace all occurrences of a byte pattern in a Uint8Array.
 * Returns a new Uint8Array with replacements applied.
 */
function replaceBytes(data: Uint8Array, search: Uint8Array, replace: Uint8Array): Uint8Array {
    // Find all occurrences
    const positions: number[] = [];
    for (let i = 0; i <= data.length - search.length; i++) {
        let match = true;
        for (let j = 0; j < search.length; j++) {
            if (data[i + j] !== search[j]) { match = false; break; }
        }
        if (match) positions.push(i);
    }

    if (positions.length === 0) return data;

    // Build result with replacements
    const sizeDiff = replace.length - search.length;
    const totalLen = data.length + sizeDiff * positions.length;
    const result = new Uint8Array(new ArrayBuffer(totalLen));
    let srcPos = 0;
    let dstPos = 0;

    for (const pos of positions) {
        // Copy data before this match
        for (let k = srcPos; k < pos; k++) result[dstPos++] = data[k];
        // Write replacement
        for (let k = 0; k < replace.length; k++) result[dstPos++] = replace[k];
        srcPos = pos + search.length;
    }
    // Copy remaining data
    for (let k = srcPos; k < data.length; k++) result[dstPos++] = data[k];

    // Trim if needed
    if (dstPos < totalLen) {
        const trimmed = new Uint8Array(new ArrayBuffer(dstPos));
        for (let i = 0; i < dstPos; i++) trimmed[i] = result[i];
        return trimmed;
    }
    return result;
}

function stringToBytes(s: string): Uint8Array {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
}

export interface StringReplacement {
    oldString: string;
    newString: string;
}

/**
 * Clone an IFF file, replacing embedded strings.
 *
 * This does raw binary string replacement which works because SWG IFF
 * chunk sizes are recalculated based on the FORM structure, and we
 * also fix up any affected chunk/form sizes.
 *
 * For simple cases where old and new strings are the same length,
 * no size fixup is needed. For different lengths, we rebuild the entire IFF.
 */
export function cloneIFFWithReplacements(data: Uint8Array, replacements: StringReplacement[]): Uint8Array {
    let result = new Uint8Array(data.length);
    result.set(data);

    for (const rep of replacements) {
        const search = stringToBytes(rep.oldString);
        const rep_bytes = stringToBytes(rep.newString);
        const replaced = replaceBytes(result, search, rep_bytes);
        result = new Uint8Array(replaced.length);
        result.set(replaced);
    }

    // Fix FORM sizes in case string lengths changed
    fixIFFSizes(result);
    return result;
}

/**
 * Fix FORM sizes in an IFF buffer after string replacements may have changed content lengths.
 * This walks from inner chunks outward, recalculating sizes.
 *
 * NOTE: This only works when the total file length is correct (i.e., all data is present).
 * It does NOT work if chunks overlap or are corrupted.
 */
function fixIFFSizes(data: Uint8Array): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    function fixNode(offset: number, endPos: number): number {
        if (offset + 8 > endPos) return endPos;

        const tag = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);

        if (tag === 'FORM') {
            // FORM: tag(4) + size(4) + formName(4) + children
            const formNameEnd = offset + 12;
            let childEnd = formNameEnd;

            // Recursively fix children
            while (childEnd < endPos) {
                const prevEnd = childEnd;
                childEnd = fixNode(childEnd, endPos);
                if (childEnd === prevEnd) break; // no progress
            }

            // Update FORM size = (childEnd - offset - 8)
            const newSize = childEnd - offset - 8;
            view.setUint32(offset + 4, newSize, false); // big-endian
            return childEnd;
        } else {
            // Data chunk: tag(4) + size(4) + data
            const chunkSize = view.getUint32(offset + 4, false);
            return offset + 8 + chunkSize;
        }
    }

    fixNode(0, data.length);
}

/**
 * Generate the string replacements needed to clone an armor template.
 *
 * @param sourceArmorName - e.g. "bounty_hunter_crafted"
 * @param targetArmorName - e.g. "nightsister_crafted"
 * @param sourceFolderName - e.g. "bounty_hunter" (TRE subfolder)
 * @param targetFolderName - e.g. "nightsister" (TRE subfolder)
 * @param piece - e.g. "helmet"
 */
export function getArmorIFFReplacements(
    sourceArmorName: string, targetArmorName: string,
    sourceFolderName: string, targetFolderName: string,
    piece: string
): StringReplacement[] {
    return [
        // Appearance path: armor_NAME_PIECE -> armor_NEWNAME_PIECE
        { oldString: `armor_${sourceArmorName}_${piece}`, newString: `armor_${targetArmorName}_${piece}` },
        // TRE folder path: armor/FOLDER/ -> armor/NEWFOLDER/
        { oldString: `armor/${sourceFolderName}/`, newString: `armor/${targetFolderName}/` },
    ];
}

/**
 * Generate replacements for a schematic IFF clone.
 */
export function getSchematicIFFReplacements(
    sourceArmorName: string, targetArmorName: string,
    piece: string
): StringReplacement[] {
    return [
        { oldString: `armor_${sourceArmorName}_${piece}`, newString: `armor_${targetArmorName}_${piece}` },
    ];
}

/**
 * Generate replacements for a loot schematic IFF clone.
 */
export function getLootSchematicIFFReplacements(
    sourceArmorName: string, targetArmorName: string,
    sourceFolderName: string, targetFolderName: string,
    piece: string
): StringReplacement[] {
    return [
        { oldString: `armor_${sourceArmorName}_${piece}`, newString: `armor_${targetArmorName}_${piece}` },
        { oldString: `armor/${sourceFolderName}/`, newString: `armor/${targetFolderName}/` },
    ];
}
