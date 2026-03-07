const fs = require('fs');
const path = require('path');
const { parseFLR, getSpawnBounds } = require('./out/index.js');

// Find a floor file from the vanilla TRE
const flrPath = '/home/swgemu/workspace/tre/vanilla/appearance/collision/poi_all_impl_bunker_s02_r1_entry_collision_floor.flr';

if (!fs.existsSync(flrPath)) {
    console.log('Floor file not found, trying alternative path...');
    process.exit(1);
}

console.log(`Testing FLR parser with: ${path.basename(flrPath)}\n`);

const data = fs.readFileSync(flrPath);
const flr = parseFLR(data);

console.log(`Version: ${flr.version}`);
console.log(`Vertices: ${flr.verts.length}`);
console.log(`Triangles: ${flr.tris.length}\n`);

console.log('Bounds:');
console.log(`  X: ${flr.bounds.minX.toFixed(2)} to ${flr.bounds.maxX.toFixed(2)} (width: ${(flr.bounds.maxX - flr.bounds.minX).toFixed(2)})`);
console.log(`  Y: ${flr.bounds.minY.toFixed(2)} to ${flr.bounds.maxY.toFixed(2)} (depth: ${(flr.bounds.maxY - flr.bounds.minY).toFixed(2)})`);
console.log(`  Z: ${flr.bounds.minZ.toFixed(2)} to ${flr.bounds.maxZ.toFixed(2)} (height: ${(flr.bounds.maxZ - flr.bounds.minZ).toFixed(2)})\n`);

const spawnBounds = getSpawnBounds(flr);
console.log('Spawn Bounds (with 1m padding):');
console.log(`  X: ${spawnBounds.minX.toFixed(2)} to ${spawnBounds.maxX.toFixed(2)}`);
console.log(`  Y: ${spawnBounds.minY.toFixed(2)} to ${spawnBounds.maxY.toFixed(2)}`);
console.log(`  Z (floor height): ${spawnBounds.z.toFixed(2)}`);

// Compare to Death Watch coordinates
console.log('\nComparing to Death Watch bunker entry coordinates:');
console.log('  DW coord example: {19.24, -12.00, 4.30}');
console.log(`  Our Z height: ${spawnBounds.z.toFixed(2)} (should be close to -12.00)`);
