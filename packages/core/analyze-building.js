const fs = require('fs');
const { parsePOB } = require('./out/index.js');

const pobPath = '/home/swgemu/workspace/tre/working/object/building/general/poi_all_impl_bunker_s02.pob';
const data = fs.readFileSync(pobPath);
const pob = parsePOB(data);

console.log('POB Analysis: poi_all_impl_bunker_s02');
console.log('=====================================\n');

console.log('Death Watch bunker coordinates for reference:');
console.log('  Cell offset 13: {19.24, -12.00, 4.30}');
console.log('  Cell offset 11: {70.23, -12.00, 57.70}');
console.log('  Cell offset 4:  {-13.64, -12.00, 52.47}\n');

console.log(`Total cells: ${pob.cells.length}`);
console.log(`Total portals: ${pob.portals.length}\n`);

// Check if we can extract useful data
console.log('Cell Analysis:');
pob.cells.forEach((cell, i) => {
    console.log(`Cell ${i}: ${cell.name}`);
    console.log(`  Portals: ${cell.portals.length} connections`);
    console.log(`  Appearance: ${cell.appearance_file.split('/').pop()}`);
    if (cell.floor_file) {
        console.log(`  Floor: ${cell.floor_file.split('/').pop()}`);
    }
});

console.log('\n===CONCLUSION===');
console.log('The floor files give LOCAL mesh bounds, not building-absolute.');
console.log('The screenplay coordinates appear to be in BUILDING-SPACE.');
console.log('Without parsing the mesh files (.msh/.lod) and their transforms,');
console.log('we cannot calculate the absolute position of each cell.');
console.log('\nRecommendation: Use the getSpawnPointInCell() Lua function');
console.log('or provide manual per-cell bounds configuration.');
