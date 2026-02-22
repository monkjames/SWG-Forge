const fs = require('fs');
const { parsePOB } = require('./out/index.js');

const pobPath = '/home/swgemu/workspace/tre/working/object/building/general/poi_all_impl_bunker_s02.pob';
const data = fs.readFileSync(pobPath);
const pob = parsePOB(data);

console.log('Portal Connectivity Analysis: poi_all_impl_bunker_s02');
console.log('=======================================================\n');

console.log(`Total cells: ${pob.cells.length}`);
console.log(`Total portals (global): ${pob.portals.length}\n`);

// Build connectivity graph
console.log('Cell-to-Cell Connections:');
console.log('-------------------------');

const cellConnections = new Map();

pob.cells.forEach((cell, cellIdx) => {
    console.log(`\nCell ${cellIdx}: ${cell.name}`);
    console.log(`  Cell portals: ${cell.portals.length}`);

    cell.portals.forEach((portal, portalIdx) => {
        const { id, connecting_cell, passable, doorhardpoint, clockwise } = portal;

        console.log(`  Portal ${portalIdx}:`);
        console.log(`    Global portal ID: ${id}`);
        console.log(`    Connects to cell: ${connecting_cell}`);
        console.log(`    Passable: ${passable}`);
        console.log(`    Clockwise: ${clockwise}`);

        if (doorhardpoint && doorhardpoint.length === 12) {
            // Transform matrix is 4x3 in row-major order:
            // [0,1,2,3]:   rotXx, rotXy, rotXz, posX
            // [4,5,6,7]:   rotYx, rotYy, rotYz, posY
            // [8,9,10,11]: rotZx, rotZy, rotZz, posZ
            const posX = doorhardpoint[3];
            const posY = doorhardpoint[7];
            const posZ = doorhardpoint[11];

            console.log(`    Portal position in cell: {${posX.toFixed(2)}, ${posY.toFixed(2)}, ${posZ.toFixed(2)}}`);

            // Store connection
            if (!cellConnections.has(cellIdx)) {
                cellConnections.set(cellIdx, []);
            }
            cellConnections.get(cellIdx).push({
                fromCell: cellIdx,
                toCell: connecting_cell,
                portalPos: { x: posX, y: posY, z: posZ },
                globalPortalId: id
            });
        } else {
            console.log(`    No door hardpoint (${doorhardpoint ? doorhardpoint.length : 0} floats)`);
        }
    });
});

console.log('\n\n=== CONNECTIVITY GRAPH ===\n');

// Now check global portal geometry
console.log('Global Portal Geometry:');
console.log('-----------------------');

pob.portals.forEach((portal, idx) => {
    console.log(`\nGlobal Portal ${portal.id}:`);
    console.log(`  Vertices: ${portal.verts.length}`);
    console.log(`  Triangles: ${portal.tris.length}`);

    if (portal.verts.length > 0) {
        // Calculate center point of portal
        let sumX = 0, sumY = 0, sumZ = 0;
        portal.verts.forEach(v => {
            sumX += v.x;
            sumY += v.y;
            sumZ += v.z;
        });
        const centerX = sumX / portal.verts.length;
        const centerY = sumY / portal.verts.length;
        const centerZ = sumZ / portal.verts.length;

        console.log(`  Portal center: {${centerX.toFixed(2)}, ${centerY.toFixed(2)}, ${centerZ.toFixed(2)}}`);
        console.log(`  Vertex bounds:`);
        const minX = Math.min(...portal.verts.map(v => v.x));
        const maxX = Math.max(...portal.verts.map(v => v.x));
        const minY = Math.min(...portal.verts.map(v => v.y));
        const maxY = Math.max(...portal.verts.map(v => v.y));
        const minZ = Math.min(...portal.verts.map(v => v.z));
        const maxZ = Math.max(...portal.verts.map(v => v.z));
        console.log(`    X: [${minX.toFixed(2)}, ${maxX.toFixed(2)}]`);
        console.log(`    Y: [${minY.toFixed(2)}, ${maxY.toFixed(2)}]`);
        console.log(`    Z: [${minZ.toFixed(2)}, ${maxZ.toFixed(2)}]`);
    }
});

console.log('\n\n=== NEXT STEPS ===');
console.log('1. Use portal positions + connectivity to calculate cell positions');
console.log('2. Build 3D stick diagram showing cell layout');
console.log('3. Calculate cell bounds in building-space coordinates');
