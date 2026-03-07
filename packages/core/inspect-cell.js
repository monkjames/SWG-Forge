const fs = require('fs');
const { parsePOB } = require('./out/index.js');

const pobPath = '/home/swgemu/workspace/tre/working/object/building/general/poi_all_impl_bunker_s02.pob';
const data = fs.readFileSync(pobPath);
const pob = parsePOB(data);

console.log('Inspecting POB cells:\n');
pob.cells.forEach((cell, i) => {
    console.log(`Cell ${i}: ${cell.name}`);
    console.log(`  Appearance: ${cell.appearance_file}`);
    console.log(`  Floor: ${cell.floor_file || 'none'}`);
    console.log(`  Collision type: ${cell.collision.type}`);
    console.log(`  Portals: ${cell.portals.length}`);
    if (cell.portals.length > 0) {
        cell.portals.forEach(p => {
            console.log(`    Portal ${p.id} -> Cell ${p.connecting_cell}, passable: ${p.passable}`);
        });
    }
    console.log('');
});
