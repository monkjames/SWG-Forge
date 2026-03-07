/**
 * Round-trip validation for POB and FLR serializers.
 * Parses vanilla files, serializes them, re-parses, and compares structures.
 */
const fs = require('fs');
const path = require('path');
const { parsePOB, serializePOB, parseFLR, serializeFLR } = require('./out/index.js');

const treVanilla = '/home/swgemu/workspace/tre/vanilla';
const treSample = '/home/swgemu/workspace/scripts/imported_files/buildings/sample_pob';

// Find a test POB
const testPobs = [
    path.join(treSample, 'appearance/ply_corl_merchant_tent_s01.pob'),
    path.join(treVanilla, 'appearance/ply_corl_merchant_tent_s01.pob'),
    path.join(treVanilla, 'appearance/ply_all_merchant_tent_s01.pob'),
];

let pobPath = null;
for (const p of testPobs) {
    if (fs.existsSync(p)) { pobPath = p; break; }
}

if (!pobPath) {
    console.error('No test POB file found!');
    process.exit(1);
}

console.log('=== POB Round-Trip Test ===');
console.log('Source:', pobPath);

// Parse original
const originalData = fs.readFileSync(pobPath);
const pob1 = parsePOB(originalData);
console.log(`Parsed: v${pob1.version}, ${pob1.portals.length} portals, ${pob1.cells.length} cells`);

// Serialize
const serialized = serializePOB(pob1);
console.log(`Serialized: ${serialized.length} bytes (original: ${originalData.length} bytes)`);

// Re-parse
const pob2 = parsePOB(serialized);
console.log(`Re-parsed: v${pob2.version}, ${pob2.portals.length} portals, ${pob2.cells.length} cells`);

// Compare structures
let errors = 0;

function check(label, a, b) {
    if (a !== b) {
        console.error(`  MISMATCH ${label}: ${a} != ${b}`);
        errors++;
    }
}

check('portal count', pob1.portals.length, pob2.portals.length);
check('cell count', pob1.cells.length, pob2.cells.length);

// Compare portals
for (let i = 0; i < Math.min(pob1.portals.length, pob2.portals.length); i++) {
    check(`portal[${i}].verts.length`, pob1.portals[i].verts.length, pob2.portals[i].verts.length);
    check(`portal[${i}].tris.length`, pob1.portals[i].tris.length, pob2.portals[i].tris.length);
    // Compare vertex values
    for (let j = 0; j < Math.min(pob1.portals[i].verts.length, pob2.portals[i].verts.length); j++) {
        const v1 = pob1.portals[i].verts[j];
        const v2 = pob2.portals[i].verts[j];
        if (Math.abs(v1.x - v2.x) > 0.001 || Math.abs(v1.y - v2.y) > 0.001 || Math.abs(v1.z - v2.z) > 0.001) {
            console.error(`  MISMATCH portal[${i}].verts[${j}]: (${v1.x},${v1.y},${v1.z}) != (${v2.x},${v2.y},${v2.z})`);
            errors++;
        }
    }
}

// Compare cells
for (let i = 0; i < Math.min(pob1.cells.length, pob2.cells.length); i++) {
    const c1 = pob1.cells[i], c2 = pob2.cells[i];
    check(`cell[${i}].name`, c1.name, c2.name);
    check(`cell[${i}].appearance_file`, c1.appearance_file, c2.appearance_file);
    check(`cell[${i}].floor_file`, c1.floor_file || '', c2.floor_file || '');
    check(`cell[${i}].can_see_world`, c1.can_see_world, c2.can_see_world);
    check(`cell[${i}].portals.length`, c1.portals.length, c2.portals.length);
    check(`cell[${i}].lights.length`, c1.lights.length, c2.lights.length);
    check(`cell[${i}].collision.type`, c1.collision.type, c2.collision.type);

    // Compare portal data
    for (let j = 0; j < Math.min(c1.portals.length, c2.portals.length); j++) {
        const p1 = c1.portals[j], p2 = c2.portals[j];
        check(`cell[${i}].portal[${j}].id`, p1.id, p2.id);
        check(`cell[${i}].portal[${j}].connecting_cell`, p1.connecting_cell, p2.connecting_cell);
        check(`cell[${i}].portal[${j}].clockwise`, p1.clockwise, p2.clockwise);
        check(`cell[${i}].portal[${j}].passable`, p1.passable, p2.passable);
    }
}

// Compare path graph
if (pob1.pathGraph && pob2.pathGraph) {
    check('pathGraph.nodes.length', pob1.pathGraph.nodes.length, pob2.pathGraph.nodes.length);
    check('pathGraph.edges.length', pob1.pathGraph.edges.length, pob2.pathGraph.edges.length);
    check('pathGraph.pathGraphType', pob1.pathGraph.pathGraphType, pob2.pathGraph.pathGraphType);

    for (let i = 0; i < Math.min(pob1.pathGraph.nodes.length, pob2.pathGraph.nodes.length); i++) {
        const n1 = pob1.pathGraph.nodes[i], n2 = pob2.pathGraph.nodes[i];
        check(`node[${i}].type`, n1.type, n2.type);
        check(`node[${i}].index`, n1.index, n2.index);
        if (Math.abs(n1.position.x - n2.position.x) > 0.001 ||
            Math.abs(n1.position.y - n2.position.y) > 0.001 ||
            Math.abs(n1.position.z - n2.position.z) > 0.001) {
            console.error(`  MISMATCH node[${i}].position: (${n1.position.x},${n1.position.y},${n1.position.z}) != (${n2.position.x},${n2.position.y},${n2.position.z})`);
            errors++;
        }
    }
} else {
    check('pathGraph presence', !!pob1.pathGraph, !!pob2.pathGraph);
}

if (errors === 0) {
    console.log('\nPOB ROUND-TRIP: PASS (all fields match)');
} else {
    console.log(`\nPOB ROUND-TRIP: FAIL (${errors} mismatches)`);
}

// Write the serialized file for manual inspection
const outPath = '/tmp/roundtrip_test.pob';
fs.writeFileSync(outPath, serialized);
console.log(`Serialized output written to: ${outPath}`);

// === FLR Round-Trip Test ===
console.log('\n=== FLR Round-Trip Test ===');

// Find FLR files referenced by the tent POB
for (const cell of pob1.cells) {
    if (!cell.floor_file) continue;

    // Try multiple locations
    const flrPaths = [
        path.join(treSample, cell.floor_file),
        path.join(treVanilla, cell.floor_file),
    ];

    let flrPath = null;
    for (const p of flrPaths) {
        if (fs.existsSync(p)) { flrPath = p; break; }
    }

    if (!flrPath) {
        console.log(`  Floor file not found: ${cell.floor_file}`);
        continue;
    }

    console.log(`\nFLR: ${cell.name} -> ${path.basename(flrPath)}`);

    const flrOriginal = fs.readFileSync(flrPath);
    const flr1 = parseFLR(flrOriginal);
    console.log(`  Parsed: v${flr1.version}, ${flr1.verts.length} verts, ${flr1.tris.length} tris`);

    const flrSerialized = serializeFLR(flr1);
    console.log(`  Serialized: ${flrSerialized.length} bytes (original: ${flrOriginal.length} bytes)`);

    const flr2 = parseFLR(flrSerialized);
    console.log(`  Re-parsed: v${flr2.version}, ${flr2.verts.length} verts, ${flr2.tris.length} tris`);

    let flrErrors = 0;
    if (flr1.verts.length !== flr2.verts.length) {
        console.error(`  MISMATCH vert count: ${flr1.verts.length} != ${flr2.verts.length}`);
        flrErrors++;
    }
    if (flr1.tris.length !== flr2.tris.length) {
        console.error(`  MISMATCH tri count: ${flr1.tris.length} != ${flr2.tris.length}`);
        flrErrors++;
    }

    // Compare vertices
    for (let i = 0; i < Math.min(flr1.verts.length, flr2.verts.length); i++) {
        const v1 = flr1.verts[i], v2 = flr2.verts[i];
        if (Math.abs(v1.x - v2.x) > 0.001 || Math.abs(v1.y - v2.y) > 0.001 || Math.abs(v1.z - v2.z) > 0.001) {
            console.error(`  MISMATCH vert[${i}]: (${v1.x},${v1.y},${v1.z}) != (${v2.x},${v2.y},${v2.z})`);
            flrErrors++;
        }
    }

    // Compare triangles
    for (let i = 0; i < Math.min(flr1.tris.length, flr2.tris.length); i++) {
        const t1 = flr1.tris[i], t2 = flr2.tris[i];
        const fields = ['corner1','corner2','corner3','index','nindex1','nindex2','nindex3','edgeType1','edgeType2','edgeType3','partTag','portalId1','portalId2','portalId3'];
        for (const f of fields) {
            if (t1[f] !== t2[f]) {
                console.error(`  MISMATCH tri[${i}].${f}: ${t1[f]} != ${t2[f]}`);
                flrErrors++;
            }
        }
        if (t1.fallthrough !== t2.fallthrough) {
            console.error(`  MISMATCH tri[${i}].fallthrough: ${t1.fallthrough} != ${t2.fallthrough}`);
            flrErrors++;
        }
    }

    if (flrErrors === 0) {
        console.log(`  FLR ROUND-TRIP: PASS`);
    } else {
        console.log(`  FLR ROUND-TRIP: FAIL (${flrErrors} mismatches)`);
        errors += flrErrors;
    }
}

console.log(`\n=== OVERALL: ${errors === 0 ? 'ALL PASS' : errors + ' FAILURES'} ===`);
process.exit(errors > 0 ? 1 : 0);
