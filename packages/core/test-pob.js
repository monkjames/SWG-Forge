const fs = require('fs');
const { parsePOB } = require('./out/index.js');

const pobPath = '/home/swgemu/workspace/tre/working/object/building/general/poi_all_impl_bunker_s02.pob';
const data = fs.readFileSync(pobPath);

try {
    console.log('Loading POB file:', pobPath);
    console.log('File size:', data.length, 'bytes');
    
    const pob = parsePOB(data);
    
    console.log('Success!');
    console.log('Version:', pob.version);
    console.log('Portals:', pob.portals.length);
    console.log('Cells:', pob.cells.length);
    
    pob.cells.forEach((cell, i) => {
        console.log(`Cell ${i}: ${cell.name} - ${cell.portals.length} portals`);
    });
} catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
}
