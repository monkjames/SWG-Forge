const fs = require('fs');
const path = require('path');
const { parsePOB } = require('./out/index.js');

const pobDir = '/home/swgemu/workspace/tre/working/object/building/general';
const files = fs.readdirSync(pobDir).filter(f => f.endsWith('.pob'));

console.log(`Testing ${files.length} POB files...\n`);

let passed = 0;
let failed = 0;

files.forEach(file => {
    const filePath = path.join(pobDir, file);
    try {
        const data = fs.readFileSync(filePath);
        const pob = parsePOB(data);
        console.log(`✓ ${file}: v${pob.version}, ${pob.cells.length} cells, ${pob.portals.length} portals`);
        passed++;
    } catch (error) {
        console.log(`✗ ${file}: ${error.message}`);
        failed++;
    }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
