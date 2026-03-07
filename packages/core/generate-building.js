/**
 * Full-pipeline building generator.
 * Creates two merchant tent duplicates with all associated files:
 *   s01 = straight dupe (same exterior + interior)
 *   s02 = tent exterior + Tatooine house livingroom interior
 *
 * Generated files:
 *   TRE: POB, building IFF, deed IFF, CRC entries, STF strings
 *   Lua: building template, deed template, registrations
 */
const fs = require('fs');
const path = require('path');
const {
    parsePOB, serializePOB,
    parseIFF, serializeIFF, readNullString,
    parseCRCTable, serializeCRCTable, addCRCEntries,
    parseSTF, serializeSTF, addSTFEntries,
} = require('./out/index.js');

/**
 * Clone an IFF by parsing, replacing strings in chunk data, then re-serializing.
 * This is safer than cloneIFFWithReplacements which does raw binary replacement
 * and can corrupt FORM sizes when string lengths change.
 */
function cloneIFFSafe(data, replacements) {
    const root = parseIFF(data);

    function replaceInBuffer(buf) {
        let result = Buffer.from(buf);
        for (const rep of replacements) {
            const search = Buffer.from(rep.oldString, 'binary');
            const replace = Buffer.from(rep.newString, 'binary');
            let pos = 0;
            while (true) {
                const idx = result.indexOf(search, pos);
                if (idx === -1) break;
                const newBuf = Buffer.alloc(result.length - search.length + replace.length);
                result.copy(newBuf, 0, 0, idx);
                replace.copy(newBuf, idx);
                result.copy(newBuf, idx + replace.length, idx + search.length);
                result = newBuf;
                pos = idx + replace.length;
            }
        }
        return new Uint8Array(result);
    }

    function walkAndReplace(node) {
        if (node.data) {
            node.data = replaceInBuffer(node.data);
        }
        if (node.children) {
            for (const child of node.children) {
                walkAndReplace(child);
            }
        }
    }

    walkAndReplace(root);
    return serializeIFF(root);
}

// === Paths ===
const treVanilla = '/home/swgemu/workspace/tre/vanilla';
const treInfinity = '/home/swgemu/workspace/tre/infinity';
// Output to test folder by default; pass --production to use tre/working
const isProduction = process.argv.includes('--production');
const treOutput = isProduction
    ? '/home/swgemu/workspace/tre/working'
    : '/home/swgemu/workspace/tre/test';
const luaBase = isProduction
    ? '/home/swgemu/workspace/infinity_jtl/MMOCoreORB/bin/scripts'
    : path.join(treOutput, 'lua');

/** Find a file in vanilla or infinity TRE folders */
function findSource(relPath) {
    const vanillaPath = path.join(treVanilla, relPath);
    if (fs.existsSync(vanillaPath)) return vanillaPath;
    const infPath = path.join(treInfinity, relPath);
    if (fs.existsSync(infPath)) return infPath;
    throw new Error(`Source file not found in vanilla or infinity: ${relPath}`);
}

/** Seed a file into treOutput from vanilla/infinity if it doesn't exist yet */
function seedFile(relPath) {
    const outPath = path.join(treOutput, relPath);
    if (fs.existsSync(outPath)) return outPath;
    const src = findSource(relPath);
    ensureDir(outPath);
    fs.copyFileSync(src, outPath);
    console.log(`  Seeded ${relPath} from ${path.dirname(src).split('/').pop()}/`);
    return outPath;
}

if (!isProduction) {
    console.log('*** TEST MODE: Output goes to tre/test/ ***');
    console.log('*** Use --production flag to write to tre/working/ ***\n');
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath, data) {
    ensureDir(filePath);
    if (typeof data === 'string') {
        fs.writeFileSync(filePath, data, 'utf8');
    } else {
        fs.writeFileSync(filePath, data);
    }
    console.log(`  Created: ${filePath}`);
}

// ============================================================
// STEP 1: Generate POB files
// ============================================================
console.log('=== Step 1: POB Files ===');

// Parse source buildings
const tentPob = parsePOB(fs.readFileSync(
    path.join(treVanilla, 'appearance/ply_corl_merchant_tent_s01.pob')
));
const tatoPob = parsePOB(fs.readFileSync(
    path.join(treVanilla, 'appearance/ply_tato_house_sm_s01_fp1.pob')
));

// Building 1: straight dupe - just re-serialize the tent unchanged
const pob1 = serializePOB(tentPob);
writeFile(path.join(treOutput, 'appearance/ply_inf_merchant_tent_s01.pob'), pob1);

// Building 2: tent exterior + tato livingroom interior
// Deep-clone the tent POB data
const tentPob2 = JSON.parse(JSON.stringify(tentPob));
// Can't JSON serialize rawNode (Uint8Array), so copy from originals
for (let i = 0; i < tentPob2.cells.length; i++) {
    tentPob2.cells[i].collision.rawNode = tentPob.cells[i].collision.rawNode;
}

// Replace cell 1 (interior) with Tato house cell 3 (livingroom)
const donorCell = tatoPob.cells[3]; // livingroom - 1 portal, matches tent layout
tentPob2.cells[1].appearance_file = donorCell.appearance_file;
tentPob2.cells[1].floor_file = donorCell.floor_file;
tentPob2.cells[1].collision = {
    type: donorCell.collision.type,
    rawNode: donorCell.collision.rawNode,
};
tentPob2.cells[1].lights = donorCell.lights;
tentPob2.cells[1].name = 'livingroom'; // rename cell

const pob2 = serializePOB(tentPob2);
writeFile(path.join(treOutput, 'appearance/ply_inf_merchant_tent_s02.pob'), pob2);

console.log(`  s01: ${pob1.length} bytes, s02: ${pob2.length} bytes`);

// ============================================================
// STEP 2: Clone Building IFF Templates
// ============================================================
console.log('\n=== Step 2: Building IFF Templates ===');

const srcBuildingIFF = fs.readFileSync(
    path.join(treVanilla, 'object/building/player/shared_player_merchant_tent_style_01.iff')
);

for (const suffix of ['s01', 's02']) {
    const cloned = cloneIFFSafe(srcBuildingIFF, [
        // Portal layout filename: point to our new POB
        { oldString: 'ply_tato_merchant_tent_s01', newString: `ply_inf_merchant_tent_${suffix}` },
        // STF keys: building_name, building_detail, building_lookat all use "merchant_tent"
        // We need to replace the STF key but NOT the STF file path
        // The STF pattern in IFF is: \x01\x01building_name\x00\x01merchant_tent\x00
        // We replace just the key part
        { oldString: '\x00\x01merchant_tent\x00', newString: `\x00\x01inf_merchant_tent_${suffix}\x00` },
    ]);
    writeFile(
        path.join(treOutput, `object/building/player/shared_inf_merchant_tent_${suffix}.iff`),
        cloned
    );
}

// ============================================================
// STEP 3: Clone Deed IFF Templates
// ============================================================
console.log('\n=== Step 3: Deed IFF Templates ===');

const srcDeedIFF = fs.readFileSync(
    path.join(treVanilla, 'object/tangible/deed/player_house_deed/shared_merchant_tent_style_01_deed.iff')
);

for (const suffix of ['s01', 's02']) {
    const cloned = cloneIFFSafe(srcDeedIFF, [
        // STF keys for deed name/description
        { oldString: '\x00\x01merchant_tent\x00', newString: `\x00\x01inf_merchant_tent_${suffix}\x00` },
    ]);
    writeFile(
        path.join(treOutput, `object/tangible/deed/player_house_deed/shared_inf_merchant_tent_${suffix}_deed.iff`),
        cloned
    );
}

// ============================================================
// STEP 4: Register CRC Entries
// ============================================================
console.log('\n=== Step 4: CRC String Table ===');

const crcPath = seedFile('misc/object_template_crc_string_table.iff');
const crcData = fs.readFileSync(crcPath);
const crcTable = parseCRCTable(crcData);

const newCRCPaths = [
    'object/building/player/shared_inf_merchant_tent_s01.iff',
    'object/building/player/shared_inf_merchant_tent_s02.iff',
    'object/tangible/deed/player_house_deed/shared_inf_merchant_tent_s01_deed.iff',
    'object/tangible/deed/player_house_deed/shared_inf_merchant_tent_s02_deed.iff',
];

const addedEntries = addCRCEntries(crcTable, newCRCPaths);
const crcSerialized = serializeCRCTable(crcTable);
fs.writeFileSync(crcPath, crcSerialized);
console.log(`  Added ${newCRCPaths.length} CRC entries to ${crcPath}`);

// ============================================================
// STEP 5: Add STF Strings
// ============================================================
console.log('\n=== Step 5: STF Strings ===');

// Building names
const buildingNamePath = seedFile('string/en/building_name.stf');
const buildingNameSTF = parseSTF(fs.readFileSync(buildingNamePath));
addSTFEntries(buildingNameSTF, [
    { id: 'inf_merchant_tent_s01', value: 'Infinity Merchant Tent' },
    { id: 'inf_merchant_tent_s02', value: 'Infinity Merchant Tent (Modified)' },
]);
fs.writeFileSync(buildingNamePath, serializeSTF(buildingNameSTF));
console.log(`  Updated: ${buildingNamePath}`);

// Building details
const buildingDetailPath = seedFile('string/en/building_detail.stf');
const buildingDetailSTF = parseSTF(fs.readFileSync(buildingDetailPath));
addSTFEntries(buildingDetailSTF, [
    { id: 'inf_merchant_tent_s01', value: 'A merchant tent for displaying wares.' },
    { id: 'inf_merchant_tent_s02', value: 'A merchant tent with a modified interior.' },
]);
fs.writeFileSync(buildingDetailPath, serializeSTF(buildingDetailSTF));
console.log(`  Updated: ${buildingDetailPath}`);

// Deed strings
const deedPath = path.join(treOutput, 'string/en/deed.stf');
if (fs.existsSync(deedPath)) {
    const deedSTF = parseSTF(fs.readFileSync(deedPath));
    addSTFEntries(deedSTF, [
        { id: 'inf_merchant_tent_s01', value: 'Deed for: Infinity Merchant Tent' },
        { id: 'inf_merchant_tent_s02', value: 'Deed for: Infinity Merchant Tent (Modified)' },
    ]);
    fs.writeFileSync(deedPath, serializeSTF(deedSTF));
    console.log(`  Updated: ${deedPath}`);
} else {
    console.log(`  Skipped deed.stf (not found)`);
}

const deedDetailPath = path.join(treOutput, 'string/en/deed_detail.stf');
if (fs.existsSync(deedDetailPath)) {
    const deedDetailSTF = parseSTF(fs.readFileSync(deedDetailPath));
    addSTFEntries(deedDetailSTF, [
        { id: 'inf_merchant_tent_s01', value: 'A deed for an Infinity Merchant Tent.' },
        { id: 'inf_merchant_tent_s02', value: 'A deed for an Infinity Merchant Tent with a modified interior.' },
    ]);
    fs.writeFileSync(deedDetailPath, serializeSTF(deedDetailSTF));
    console.log(`  Updated: ${deedDetailPath}`);
} else {
    console.log(`  Skipped deed_detail.stf (not found)`);
}

// ============================================================
// STEP 6: Create Lua Building Templates
// ============================================================
console.log('\n=== Step 6: Lua Building Templates ===');

for (const suffix of ['s01', 's02']) {
    const luaContent = `
object_building_player_inf_merchant_tent_${suffix} = object_building_player_shared_inf_merchant_tent_${suffix}:new {
\tlotSize = 1,
\tpublicStructure = 1,
\tbaseMaintenanceRate = 10,
\tallowedZones = {"dantooine", "lok", "tatooine", "naboo", "rori", "corellia", "talus"},
\tlength = 3,
\twidth = 3,
\talwaysPublic = 1,
\tabilityRequired = "place_merchant_tent",
\tskillMods = {
\t\t{"private_safe_logout", 1}
\t},
\tchildObjects = {
\t\t{templateFile = "object/tangible/sign/player/shop_sign_s01.iff", x = 3, z = -0.5, y = 3, ox = 0, oy = 0, oz = 0, ow = 1, cellid = -1, containmentType = -1},
\t\t{templateFile = "object/tangible/terminal/terminal_player_structure.iff", x = -0.15, z = 0.267105, y = -2.76, ox = 0, oy = 0, oz = 0, ow = 1, cellid = 1, containmentType = -1}
\t},
\tshopSigns = {
\t\t{templateFile = "object/tangible/sign/player/shop_sign_s01.iff", x = 3, z = -0.5, y = 3, ox = 0, oy = 0, oz = 0, ow = 1, cellid = -1, containmentType = -1, requiredSkill = "", suiItem = "@player_structure:shop_sign1"},
\t\t{templateFile = "object/tangible/sign/player/shop_sign_s02.iff", x = 3, z = -0.5, y = 3, ox = 0, oy = 0, oz = 0, ow = 1, cellid = -1, containmentType = -1, requiredSkill = "crafting_merchant_management_02", suiItem = "@player_structure:shop_sign2"},
\t\t{templateFile = "object/tangible/sign/player/shop_sign_s03.iff", x = 3, z = -0.5, y = 3, ox = 0, oy = 0, oz = 0, ow = 1, cellid = -1, containmentType = -1, requiredSkill = "crafting_merchant_management_03", suiItem = "@player_structure:shop_sign3"},
\t\t{templateFile = "object/tangible/sign/player/shop_sign_s04.iff", x = 3, z = -0.5, y = 3, ox = 0, oy = 0, oz = 0, ow = 1, cellid = -1, containmentType = -1, requiredSkill = "crafting_merchant_management_04", suiItem = "@player_structure:shop_sign4"},
\t},
}

ObjectTemplates:addTemplate(object_building_player_inf_merchant_tent_${suffix}, "object/building/player/inf_merchant_tent_${suffix}.iff")
`;
    writeFile(
        path.join(luaBase, `custom_scripts/object/building/player/inf_merchant_tent_${suffix}.lua`),
        luaContent
    );
}

// ============================================================
// STEP 7: Create Lua Deed Templates
// ============================================================
console.log('\n=== Step 7: Lua Deed Templates ===');

for (const suffix of ['s01', 's02']) {
    const luaContent = `
object_tangible_deed_player_house_deed_inf_merchant_tent_${suffix}_deed = object_tangible_deed_player_house_deed_shared_inf_merchant_tent_${suffix}_deed:new {
\ttemplateType = STRUCTUREDEED,
\tplaceStructureComponent = "PlaceStructureComponent",
\tgameObjectType = 8388609,
\tgeneratedObjectTemplate = "object/building/player/inf_merchant_tent_${suffix}.iff",

\tnumberExperimentalProperties = {1, 1, 1},
\texperimentalProperties = {"XX", "XX", "DR"},
\texperimentalWeights = {1, 1, 1},
\texperimentalGroupTitles = {"null", "null", "exp_durability"},
\texperimentalSubGroupTitles = {"null", "null", "hitpoints"},
\texperimentalMin = {0, 0, 21000},
\texperimentalMax = {0, 0, 39000},
\texperimentalPrecision = {0, 0, 0},
\texperimentalCombineType = {0, 0, 4},
}

ObjectTemplates:addTemplate(object_tangible_deed_player_house_deed_inf_merchant_tent_${suffix}_deed, "object/tangible/deed/player_house_deed/inf_merchant_tent_${suffix}_deed.iff")
`;
    writeFile(
        path.join(luaBase, `custom_scripts/object/tangible/deed/player_house_deed/inf_merchant_tent_${suffix}_deed.lua`),
        luaContent
    );
}

// ============================================================
// STEP 8: Register in objects.lua and serverobjects.lua
// ============================================================
console.log('\n=== Step 8: Lua Registrations ===');

/** Read a file or return empty string if it doesn't exist (for test mode) */
function readOrCreate(filePath) {
    ensureDir(filePath);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', 'utf8');
        return '';
    }
    return fs.readFileSync(filePath, 'utf8');
}

// Building objects.lua - add shared template registrations
const buildingObjectsPath = path.join(luaBase, 'custom_scripts/object/building/player/objects.lua');
const buildingObjectsContent = readOrCreate(buildingObjectsPath);
let buildingAdditions = '';
for (const suffix of ['s01', 's02']) {
    const varName = `object_building_player_shared_inf_merchant_tent_${suffix}`;
    if (!buildingObjectsContent.includes(varName)) {
        buildingAdditions += `
${varName} = SharedBuildingObjectTemplate:new {
\tclientTemplateFileName = "object/building/player/shared_inf_merchant_tent_${suffix}.iff"
}
ObjectTemplates:addClientTemplate(${varName}, "object/building/player/shared_inf_merchant_tent_${suffix}.iff")
`;
    }
}
if (buildingAdditions) {
    fs.appendFileSync(buildingObjectsPath, buildingAdditions);
    console.log(`  Updated: ${buildingObjectsPath}`);
}

// Building serverobjects.lua - add includeFile lines
const buildingSOPath = path.join(luaBase, 'custom_scripts/object/building/player/serverobjects.lua');
const buildingSOContent = readOrCreate(buildingSOPath);
let buildingSOAdditions = '';
for (const suffix of ['s01', 's02']) {
    const include = `includeFile("../custom_scripts/object/building/player/inf_merchant_tent_${suffix}.lua")`;
    if (!buildingSOContent.includes(include)) {
        buildingSOAdditions += include + '\n';
    }
}
if (buildingSOAdditions) {
    fs.appendFileSync(buildingSOPath, buildingSOAdditions);
    console.log(`  Updated: ${buildingSOPath}`);
}

// Deed objects.lua - add shared deed template registrations
const deedObjectsPath = path.join(luaBase, 'custom_scripts/object/tangible/deed/player_house_deed/objects.lua');
const deedObjectsContent = readOrCreate(deedObjectsPath);
let deedAdditions = '';
for (const suffix of ['s01', 's02']) {
    const varName = `object_tangible_deed_player_house_deed_shared_inf_merchant_tent_${suffix}_deed`;
    if (!deedObjectsContent.includes(varName)) {
        deedAdditions += `
${varName} = SharedTangibleObjectTemplate:new {
\tclientTemplateFileName = "object/tangible/deed/player_house_deed/shared_inf_merchant_tent_${suffix}_deed.iff"
}
ObjectTemplates:addClientTemplate(${varName}, "object/tangible/deed/player_house_deed/shared_inf_merchant_tent_${suffix}_deed.iff")
`;
    }
}
if (deedAdditions) {
    fs.appendFileSync(deedObjectsPath, deedAdditions);
    console.log(`  Updated: ${deedObjectsPath}`);
}

// Deed serverobjects.lua - add includeFile lines
const deedSOPath = path.join(luaBase, 'custom_scripts/object/tangible/deed/player_house_deed/serverobjects.lua');
const deedSOContent = readOrCreate(deedSOPath);
let deedSOAdditions = '';
for (const suffix of ['s01', 's02']) {
    const include = `includeFile("../custom_scripts/object/tangible/deed/player_house_deed/inf_merchant_tent_${suffix}_deed.lua")`;
    if (!deedSOContent.includes(include)) {
        deedSOAdditions += include + '\n';
    }
}
if (deedSOAdditions) {
    fs.appendFileSync(deedSOPath, deedSOAdditions);
    console.log(`  Updated: ${deedSOPath}`);
}

// ============================================================
// Summary
// ============================================================
console.log('\n=== GENERATION COMPLETE ===');
console.log(`Output: ${treOutput}/`);
console.log('New files created:');
console.log('  POB:  2 files in appearance/');
console.log('  IFF:  4 files in object/');
console.log('  Lua:  4 template files + 4 registration files');
console.log('Modified files:');
console.log('  CRC:  object_template_crc_string_table.iff');
console.log('  STF:  building_name.stf, building_detail.stf');
if (!isProduction) {
    console.log('\n*** Re-run with --production to write to tre/working/ ***');
}
console.log('\nTo test in-game:');
console.log('  /createitem object/tangible/deed/player_house_deed/shared_inf_merchant_tent_s01_deed.iff');
console.log('  /createitem object/tangible/deed/player_house_deed/shared_inf_merchant_tent_s02_deed.iff');
