import {
    SpawnRegion, LairSpawnEntry, SpawnGroup, LairTemplate,
    CreatureDefinition, LootEntry, RegionShape,
    SPAWNAREA, NOSPAWNAREA, WORLDSPAWNAREA, NOWORLDSPAWNAREA, NOBUILDZONEAREA, CITY, NAMEDREGION
} from './types';

// ── Region Parser ──────────────────────────────────────────────────────────────
// Parses {planet}_regions.lua files. Each region is a table entry like:
//   {"name", x, y, {SHAPE, ...}, FLAGS, {"group1"}, maxSpawn}

// Tier flag constants as they appear in Lua (hex values)
const TIER_MAP: Record<string, number> = {
    'UNDEFINEDAREA': 0x000000, 'SPAWNAREA': 0x000001, 'NOSPAWNAREA': 0x000002,
    'WORLDSPAWNAREA': 0x000004, 'NOWORLDSPAWNAREA': 0x000008,
    'NOBUILDZONEAREA': 0x000010, 'CAMPINGAREA': 0x000020, 'CITY': 0x000040,
    'NAVAREA': 0x000080, 'NAMEDREGION': 0x000100, 'LOCKEDAREA': 0x000200,
    'NOCOMBATAREA': 0x000400, 'NODUELAREA': 0x000800, 'PVPAREA': 0x001000,
    'OVERTAREA': 0x002000, 'REBELAREA': 0x004000, 'IMPERIALAREA': 0x008000,
    'NOPETAREA': 0x010000,
};

function parseTierFlags(flagStr: string): number {
    let tier = 0;
    // Split on + and look up each flag name
    const parts = flagStr.split('+').map(s => s.trim());
    for (const part of parts) {
        if (TIER_MAP[part] !== undefined) {
            tier |= TIER_MAP[part];
        }
    }
    return tier;
}

function parseShape(shapeStr: string): RegionShape | null {
    // {CIRCLE, 480} or {RECTANGLE, 8000, 8000} or {RING, 581, 1000}
    const m = shapeStr.match(/\{\s*(CIRCLE|RECTANGLE|RING)\s*,\s*([-\d.]+)\s*(?:,\s*([-\d.]+))?\s*\}/);
    if (!m) { return null; }
    const shapeType = m[1];
    const p1 = parseFloat(m[2]);
    const p2 = m[3] ? parseFloat(m[3]) : 0;
    switch (shapeType) {
        case 'CIRCLE': return { type: 'circle', radius: p1 };
        case 'RECTANGLE': return { type: 'rectangle', x2: p1, y2: p2 };
        case 'RING': return { type: 'ring', innerRadius: p1, outerRadius: p2 };
        default: return null;
    }
}

export function parseRegions(content: string, sourceFile: string): SpawnRegion[] {
    const regions: SpawnRegion[] = [];
    const lines = content.split('\n');

    // Find the table assignment (e.g., "corellia_regions = {")
    let inTable = false;
    let braceDepth = 0;
    let entryBuffer = '';
    let entryStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip full-line comments
        if (trimmed.startsWith('--') && !trimmed.startsWith('--[[')) { continue; }
        // Skip block comments
        if (trimmed.startsWith('--[[')) {
            // Find closing ]]
            let j = i;
            while (j < lines.length && !lines[j].includes(']]')) { j++; }
            i = j;
            continue;
        }

        // Strip inline comments (but not inside strings)
        const codeLine = stripInlineComment(trimmed);

        if (!inTable) {
            if (codeLine.match(/_regions\s*=\s*\{/)) {
                inTable = true;
                braceDepth = 1;
            }
            continue;
        }

        // Track brace depth char-by-char, accumulating content at depth >= 2
        for (const ch of codeLine) {
            if (ch === '{') {
                if (braceDepth === 1 && entryBuffer === '') {
                    entryStartLine = i + 1; // 1-based
                }
                braceDepth++;
                if (braceDepth >= 2) { entryBuffer += ch; }
            } else if (ch === '}') {
                braceDepth--;
                if (braceDepth >= 1) { entryBuffer += ch; }
                // When we return to depth 1, we have a complete entry
                if (braceDepth === 1 && entryBuffer.trim()) {
                    const region = parseRegionEntry(entryBuffer, sourceFile, entryStartLine);
                    if (region) { regions.push(region); }
                    entryBuffer = '';
                }
                if (braceDepth <= 0) { break; }
            } else {
                if (braceDepth >= 2) { entryBuffer += ch; }
            }
        }
        if (braceDepth <= 0) { break; }
    }

    return regions;
}

function parseRegionEntry(entry: string, sourceFile: string, sourceLine: number): SpawnRegion | null {
    // Extract the region name (first quoted string)
    const nameMatch = entry.match(/["'](@?[^"']+)["']/);
    if (!nameMatch) { return null; }
    const name = nameMatch[1];

    // Remove the name from the string to simplify coordinate parsing
    const afterName = entry.substring(entry.indexOf(nameMatch[0]) + nameMatch[0].length);

    // Extract x, y coordinates (first two numbers after the name)
    const coordMatch = afterName.match(/,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,/);
    if (!coordMatch) { return null; }
    const x = parseFloat(coordMatch[1]);
    const y = parseFloat(coordMatch[2]);

    // Extract shape
    const shapeMatch = afterName.match(/\{(CIRCLE|RECTANGLE|RING)\s*,\s*[-\d.,\s]+\}/);
    if (!shapeMatch) { return null; }
    const shape = parseShape(shapeMatch[0]);
    if (!shape) { return null; }

    // Extract tier flags - everything between the shape closing brace and the next { or number
    const afterShape = afterName.substring(afterName.indexOf(shapeMatch[0]) + shapeMatch[0].length);
    const tierMatch = afterShape.match(/,\s*([A-Z_+\s]+?)(?:\s*,\s*\{|\s*,\s*\d|\s*\})/);
    let tier = 0;
    if (tierMatch) {
        tier = parseTierFlags(tierMatch[1]);
    }

    // Extract spawn groups ({"group1", "group2"})
    const groupsMatch = afterShape.match(/,\s*\{([^}]*)\}\s*,/);
    const spawnGroups: string[] = [];
    if (groupsMatch) {
        const groupStr = groupsMatch[1];
        const groupRe = /["']([^"']+)["']/g;
        let gm;
        while ((gm = groupRe.exec(groupStr)) !== null) {
            if (gm[1].trim()) { spawnGroups.push(gm[1]); }
        }
    }

    // Extract maxSpawnLimit (last number in the entry)
    let maxSpawnLimit = 0;
    if (groupsMatch) {
        const afterGroups = afterShape.substring(afterShape.indexOf(groupsMatch[0]) + groupsMatch[0].length);
        const limitMatch = afterGroups.match(/(\d+)/);
        if (limitMatch) { maxSpawnLimit = parseInt(limitMatch[1], 10); }
    }

    return {
        name,
        x, y,
        shape,
        tier,
        isSpawnArea: (tier & SPAWNAREA) !== 0,
        isNoSpawnArea: (tier & NOSPAWNAREA) !== 0,
        isWorldSpawn: (tier & WORLDSPAWNAREA) !== 0,
        isNoWorldSpawn: (tier & NOWORLDSPAWNAREA) !== 0,
        isCity: (tier & CITY) !== 0,
        isNoBuildZone: (tier & NOBUILDZONEAREA) !== 0,
        isNamedRegion: (tier & NAMEDREGION) !== 0,
        spawnGroups,
        maxSpawnLimit,
        sourceFile,
        sourceLine,
    };
}


// ── Spawn Group Parser ─────────────────────────────────────────────────────────
// Parses files with addSpawnGroup("name", table)
// Each file defines a table with lairSpawns = { {fields...}, ... }

export function parseSpawnGroups(content: string, sourceFile: string, isCustom: boolean): SpawnGroup[] {
    const groups: SpawnGroup[] = [];

    // Find all addSpawnGroup calls
    const addCalls = [...content.matchAll(/addSpawnGroup\s*\(\s*["']([^"']+)["']/g)];

    for (const call of addCalls) {
        const groupName = call[1];

        // Find the lairSpawns table for this group
        // Look for: groupName = { lairSpawns = { ... } }
        const tableRe = new RegExp(escapeRegex(groupName) + '\\s*=\\s*\\{', 'g');
        const tableMatch = tableRe.exec(content);
        if (!tableMatch) { continue; }

        // Extract everything from lairSpawns = { to the matching close
        const fromTable = content.substring(tableMatch.index);
        const lairSpawnsMatch = fromTable.match(/lairSpawns\s*=\s*\{/);
        if (!lairSpawnsMatch) { continue; }

        const lairStart = tableMatch.index + (lairSpawnsMatch.index || 0) + lairSpawnsMatch[0].length;
        const lairEntries = extractBalancedBraces(content, lairStart);

        const lairSpawns = parseLairSpawnEntries(lairEntries);

        groups.push({ name: groupName, lairSpawns, sourceFile, isCustom });
    }

    return groups;
}

function parseLairSpawnEntries(content: string): LairSpawnEntry[] {
    const entries: LairSpawnEntry[] = [];

    // Split into individual entries by matching each { ... } block at depth 0
    let depth = 0;
    let buf = '';
    for (const ch of content) {
        if (ch === '{') {
            depth++;
            if (depth === 1) { buf = ''; continue; }
        }
        if (ch === '}') {
            depth--;
            if (depth === 0 && buf.trim()) {
                const entry = parseSingleLairSpawn(buf);
                if (entry) { entries.push(entry); }
                buf = '';
                continue;
            }
        }
        if (depth >= 1) { buf += ch; }
    }

    return entries;
}

function parseSingleLairSpawn(text: string): LairSpawnEntry | null {
    const templateMatch = text.match(/lairTemplateName\s*=\s*["']([^"']+)["']/);
    if (!templateMatch) { return null; }

    return {
        lairTemplateName: templateMatch[1],
        spawnLimit: extractNumber(text, 'spawnLimit') ?? -1,
        minDifficulty: extractNumber(text, 'minDifficulty') ?? 0,
        maxDifficulty: extractNumber(text, 'maxDifficulty') ?? 0,
        weighting: extractNumber(text, 'weighting') ?? 1,
        size: extractNumber(text, 'size') ?? 25,
    };
}


// ── Lair Template Parser ────────────────────────────────────────────────────────
// Parses files with addLairTemplate("name", table)
// Lair:new { mobiles = {{"creature",1}}, bossMobiles = {{"boss",1}}, ... }

export function parseLairTemplates(content: string, sourceFile: string): LairTemplate[] {
    const templates: LairTemplate[] = [];

    const addCalls = [...content.matchAll(/addLairTemplate\s*\(\s*["']([^"']+)["']/g)];

    for (const call of addCalls) {
        const name = call[1];

        // Find the Lair:new assignment
        const lairRe = new RegExp(escapeRegex(name) + '\\s*=\\s*Lair:new\\s*\\{');
        const lairMatch = lairRe.exec(content);
        if (!lairMatch) { continue; }

        const fromLair = content.substring(lairMatch.index + lairMatch[0].length);
        // Find the closing brace at depth 0
        const lairBody = extractToMatchingBrace(fromLair);

        // Parse mobiles = {{"name", weight}, ...}
        const mobiles = parseMobilesTable(lairBody, 'mobiles');
        const bossMobilesRaw = parseMobilesTable(lairBody, 'bossMobiles');
        const bossMobiles = bossMobilesRaw.map(m => ({ name: m.name, count: m.weight }));
        const bossMobileChance = extractNumber(lairBody, 'bossMobileChance') ?? 0;
        const spawnLimit = extractNumber(lairBody, 'spawnLimit') ?? 15;

        templates.push({ name, mobiles, bossMobiles, bossMobileChance, spawnLimit, sourceFile });
    }

    return templates;
}

function parseMobilesTable(text: string, key: string): { name: string; weight: number }[] {
    const results: { name: string; weight: number }[] = [];

    // Find: key = {{...}, {...}}
    const re = new RegExp(key + '\\s*=\\s*\\{');
    const m = re.exec(text);
    if (!m) { return results; }

    const start = m.index + m[0].length;
    const inner = extractToMatchingBrace(text.substring(start));

    // Match each {"name", number} pair
    const entryRe = /\{\s*["']([^"']+)["']\s*,\s*(\d+)\s*\}/g;
    let em;
    while ((em = entryRe.exec(inner)) !== null) {
        results.push({ name: em[1], weight: parseInt(em[2], 10) });
    }

    return results;
}


// ── Creature Definition Parser ──────────────────────────────────────────────────
// Parses files with CreatureTemplates:addCreatureTemplate(var, "name")

export function parseCreatureDefinitions(content: string, sourceFile: string, sourcePlanet: string): CreatureDefinition[] {
    const creatures: CreatureDefinition[] = [];

    const addCalls = [...content.matchAll(/CreatureTemplates:addCreatureTemplate\s*\(\s*(\w+)\s*,\s*["']([^"']+)["']\)/g)];

    for (const call of addCalls) {
        const varName = call[1];
        const name = call[2];

        // Find the Creature:new assignment
        const creatureRe = new RegExp(escapeRegex(varName) + '\\s*=\\s*Creature:new\\s*\\{');
        const creatureMatch = creatureRe.exec(content);
        if (!creatureMatch) { continue; }

        const fromCreature = content.substring(creatureMatch.index + creatureMatch[0].length);
        const body = extractToMatchingBrace(fromCreature);

        const objectNameMatch = body.match(/objectName\s*=\s*["']([^"']+)["']/);
        const factionMatch = body.match(/faction\s*=\s*["']([^"']*)["']/);
        const socialGroupMatch = body.match(/socialGroup\s*=\s*["']([^"']*)["']/);

        // Parse loot groups
        const lootGroups = parseLootGroups(body);

        creatures.push({
            name,
            objectName: objectNameMatch ? objectNameMatch[1] : '',
            level: extractNumber(body, 'level') ?? 0,
            damageMin: extractNumber(body, 'damageMin') ?? 0,
            damageMax: extractNumber(body, 'damageMax') ?? 0,
            baseXp: extractNumber(body, 'baseXp') ?? 0,
            baseHAM: extractNumber(body, 'baseHAM') ?? 0,
            armor: extractNumber(body, 'armor') ?? 0,
            faction: factionMatch ? factionMatch[1] : '',
            tamingChance: extractNumber(body, 'tamingChance') ?? 0,
            mobType: extractConstantValue(body, 'mobType') ?? 0,
            socialGroup: socialGroupMatch ? socialGroupMatch[1] : '',
            ferocity: extractNumber(body, 'ferocity') ?? 0,
            creatureBitmask: extractConstantValue(body, 'creatureBitmask') ?? 0,
            lootGroups,
            sourceFile,
            sourcePlanet,
        });
    }

    return creatures;
}

function parseLootGroups(body: string): LootEntry[][] {
    const result: LootEntry[][] = [];

    const lootMatch = body.match(/lootGroups\s*=\s*\{/);
    if (!lootMatch) { return result; }

    const start = (lootMatch.index || 0) + lootMatch[0].length;
    const inner = extractToMatchingBrace(body.substring(start));

    // Each loot group is { groups = { {group="x", chance=N}, ... } }
    // Split into depth-1 brace blocks
    let depth = 0;
    let buf = '';
    for (const ch of inner) {
        if (ch === '{') {
            depth++;
            if (depth === 1) { buf = ''; continue; }
        }
        if (ch === '}') {
            depth--;
            if (depth === 0 && buf.trim()) {
                const entries: LootEntry[] = [];
                const groupRe = /group\s*=\s*["']([^"']+)["']\s*,\s*chance\s*=\s*(\d+)/g;
                let gm;
                while ((gm = groupRe.exec(buf)) !== null) {
                    entries.push({ group: gm[1], chance: parseInt(gm[2], 10) });
                }
                if (entries.length > 0) { result.push(entries); }
                buf = '';
                continue;
            }
        }
        if (depth >= 1) { buf += ch; }
    }

    return result;
}


// ── Utility Functions ───────────────────────────────────────────────────────────

// Known Lua constants from creature templates
const LUA_CONSTANTS: Record<string, number> = {
    'MOB_HERBIVORE': 1, 'MOB_CARNIVORE': 2, 'MOB_NPC': 3,
    'CARNIVORE': 1, 'HERBIVORE': 2,
    'NONE': 0, 'PACK': 1, 'HERD': 2, 'KILLER': 4, 'STALKER': 8,
    'BABY': 16, 'LAIR': 32, 'HEALER': 64,
    'AGGRESSIVE': 1, 'ATTACKABLE': 2, 'ENEMY': 4, 'OVERT': 8,
    'TEF': 16, 'PLAYER': 32, 'CONVERSABLE': 64,
    'AIENABLED': 1, 'INVULNERABLE': 2, 'INTERESTING': 128, 'JTLINTERESTING': 256,
};

function extractNumber(text: string, key: string): number | null {
    const re = new RegExp(key + '\\s*=\\s*([-\\d.]+)');
    const m = re.exec(text);
    return m ? parseFloat(m[1]) : null;
}

/** Extract a value that may be a number, a constant name, or a sum of constants (e.g. PACK + HERD + KILLER) */
function extractConstantValue(text: string, key: string): number | null {
    const re = new RegExp(key + '\\s*=\\s*([^,}\\n]+)');
    const m = re.exec(text);
    if (!m) { return null; }
    const raw = m[1].trim();
    // Try plain number first
    if (/^[-\d.]+$/.test(raw)) { return parseFloat(raw); }
    // Resolve constant expression (e.g. "PACK + HERD + KILLER")
    const parts = raw.split('+').map(s => s.trim());
    let result = 0;
    for (const part of parts) {
        if (LUA_CONSTANTS[part] !== undefined) {
            result |= LUA_CONSTANTS[part];
        } else if (/^\d+$/.test(part)) {
            result |= parseInt(part, 10);
        }
        // skip unknown constants (0 contribution)
    }
    return result;
}

function extractToMatchingBrace(text: string): string {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') { depth++; }
        else if (text[i] === '}') {
            if (depth === 0) { return text.substring(0, i); }
            depth--;
        }
    }
    return text;
}

function extractBalancedBraces(content: string, startIndex: number): string {
    let depth = 0;
    let i = startIndex;
    while (i < content.length) {
        if (content[i] === '{') { depth++; }
        else if (content[i] === '}') {
            if (depth === 0) { return content.substring(startIndex, i); }
            depth--;
        }
        i++;
    }
    return content.substring(startIndex);
}

function stripInlineComment(line: string): string {
    // Strip -- comments that aren't inside strings
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length - 1; i++) {
        if (line[i] === '"' && !inSingle) { inDouble = !inDouble; }
        else if (line[i] === "'" && !inDouble) { inSingle = !inSingle; }
        else if (line[i] === '-' && line[i + 1] === '-' && !inSingle && !inDouble) {
            return line.substring(0, i).trim();
        }
    }
    return line;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
