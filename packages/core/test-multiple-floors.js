const fs = require('fs');
const path = require('path');
const { parseFLR, getSpawnBounds } = require('./out/index.js');

const floorFiles = [
    '/home/swgemu/workspace/tre/vanilla/appearance/collision/poi_all_impl_bunker_s02_r1_entry_collision_floor.flr',
    '/home/swgemu/workspace/tre/vanilla/appearance/collision/poi_all_impl_bunker_s02_r10_bunker_collision_floor.flr',
    '/home/swgemu/workspace/tre/vanilla/appearance/collision/poi_all_impl_bunker_s02_r2_hall1_collision_floor.flr',
];

floorFiles.forEach(flrPath => {
    if (!fs.existsSync(flrPath)) {
        console.log(`Skipping ${path.basename(flrPath)} - not found`);
        return;
    }

    const data = fs.readFileSync(flrPath);
    const flr = parseFLR(data);
    const spawn = getSpawnBounds(flr);

    console.log(`${path.basename(flrPath).replace('poi_all_impl_bunker_s02_', '').replace('_collision_floor.flr', '')}:`);
    console.log(`  Bounds: X[${flr.bounds.minX.toFixed(1)}, ${flr.bounds.maxX.toFixed(1)}] Y[${flr.bounds.minY.toFixed(1)}, ${flr.bounds.maxY.toFixed(1)}] Z=${flr.bounds.minZ.toFixed(1)}`);
    console.log(`  Size: ${(flr.bounds.maxX - flr.bounds.minX).toFixed(1)}m × ${(flr.bounds.maxY - flr.bounds.minY).toFixed(1)}m`);
    console.log('');
});

console.log('These appear to be LOCAL cell coordinates, not building-absolute.');
console.log('The Death Watch coordinates (19.24, -12.00, 4.30) must be building-absolute.');
