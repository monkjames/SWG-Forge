/**
 * Phase 2: Clone a vanilla building via parse → serialize → write.
 * Proves the serializer produces client-loadable output.
 *
 * Takes the Naboo small house, re-serializes it, and writes to tre/working/.
 */
const fs = require('fs');
const path = require('path');
const { parsePOB, serializePOB, parseFLR, serializeFLR } = require('./out/index.js');

const treVanilla = '/home/swgemu/workspace/tre/vanilla';
const treSample = '/home/swgemu/workspace/scripts/imported_files/buildings/sample_pob';
const treWorking = '/home/swgemu/workspace/tre/working';

// === Clone the merchant tent (simplest building - 2 cells) ===
const buildingName = 'ply_corl_merchant_tent_s01';

function findFile(relativePath) {
    const paths = [
        path.join(treSample, relativePath),
        path.join(treVanilla, relativePath),
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// 1. Parse and re-serialize the POB
const pobRelPath = `appearance/${buildingName}.pob`;
const pobSrc = findFile(pobRelPath);
if (!pobSrc) {
    console.error(`Cannot find ${pobRelPath}`);
    process.exit(1);
}

console.log(`=== Cloning ${buildingName} ===`);
console.log(`Source: ${pobSrc}`);

const originalPob = fs.readFileSync(pobSrc);
const pob = parsePOB(originalPob);
console.log(`Parsed: v${pob.version}, ${pob.portals.length} portals, ${pob.cells.length} cells`);

// Re-serialize
const serializedPob = serializePOB(pob);
console.log(`Serialized POB: ${serializedPob.length} bytes (original: ${originalPob.length} bytes)`);

// Write POB to tre/working
const pobDst = path.join(treWorking, pobRelPath);
ensureDir(pobDst);
fs.writeFileSync(pobDst, serializedPob);
console.log(`Wrote: ${pobDst}`);

// 2. Copy all referenced floor files (re-serialized)
let flrCount = 0;
for (const cell of pob.cells) {
    if (!cell.floor_file) continue;

    const flrSrc = findFile(cell.floor_file);
    if (!flrSrc) {
        console.log(`  Warning: floor not found: ${cell.floor_file}`);
        continue;
    }

    const flrData = fs.readFileSync(flrSrc);
    const flr = parseFLR(flrData);
    const flrSerialized = serializeFLR(flr);

    const flrDst = path.join(treWorking, cell.floor_file);
    ensureDir(flrDst);
    fs.writeFileSync(flrDst, flrSerialized);
    console.log(`  Floor ${cell.name}: ${flrSerialized.length} bytes -> ${flrDst}`);
    flrCount++;
}

// 3. Copy appearance files (meshes, LODs) - these are binary and just need copying
let meshCount = 0;
for (const cell of pob.cells) {
    if (!cell.appearance_file) continue;

    const meshSrc = findFile(cell.appearance_file);
    if (!meshSrc) {
        console.log(`  Warning: appearance not found: ${cell.appearance_file}`);
        continue;
    }

    const meshDst = path.join(treWorking, cell.appearance_file);
    ensureDir(meshDst);
    fs.copyFileSync(meshSrc, meshDst);
    console.log(`  Mesh ${cell.name}: ${path.basename(cell.appearance_file)} -> copied`);
    meshCount++;

    // If it's an LOD, we need to copy the referenced meshes too
    if (cell.appearance_file.includes('/lod/')) {
        // Parse the LOD to find referenced meshes
        try {
            const { parseIFF, findForm, findChunk, readNullString } = require('./out/index.js');
            const lodData = fs.readFileSync(meshSrc);
            const lodRoot = parseIFF(lodData);

            // LOD files: FORM DTLA > FORM 0000 > multiple FORM 0006 children
            // Each has a DATA chunk with the mesh path
            function findMeshRefs(node) {
                const refs = [];
                if (node.tag === 'DATA' && node.data) {
                    const str = readNullString(node.data, 0);
                    if (str && str.endsWith('.msh')) {
                        refs.push(str);
                    }
                }
                if (node.children) {
                    for (const child of node.children) {
                        refs.push(...findMeshRefs(child));
                    }
                }
                return refs;
            }

            const meshRefs = findMeshRefs(lodRoot);
            for (const ref of meshRefs) {
                // LOD stores relative to appearance/, but file path is appearance/mesh/...
                const fullRef = ref.startsWith('appearance/') ? ref : `appearance/${ref}`;
                const refSrc = findFile(fullRef);
                if (refSrc) {
                    const refDst = path.join(treWorking, fullRef);
                    ensureDir(refDst);
                    fs.copyFileSync(refSrc, refDst);
                    console.log(`    LOD ref: ${path.basename(ref)} -> copied`);
                    meshCount++;
                } else {
                    console.log(`    LOD ref not found: ${ref}`);
                }
            }
        } catch (e) {
            console.log(`  Warning: could not parse LOD: ${e.message}`);
        }
    }
}

console.log(`\n=== Clone Complete ===`);
console.log(`  POB: 1 file`);
console.log(`  Floors: ${flrCount} files`);
console.log(`  Meshes: ${meshCount} files`);
console.log(`\nDeployed to: ${treWorking}/appearance/`);
