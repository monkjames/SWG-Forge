const fs = require('fs');
const { parsePOB } = require('./out/index.js');

const pobPath = '/home/swgemu/workspace/tre/working/object/building/general/poi_all_impl_bunker_s02.pob';
const data = fs.readFileSync(pobPath);
const pob = parsePOB(data);

console.log('Cell Position Calculator: poi_all_impl_bunker_s02');
console.log('===================================================\n');

// Build connectivity graph
const connections = [];
const cellPositions = new Map();

pob.cells.forEach((cell, cellIdx) => {
    cell.portals.forEach((portal) => {
        const { id, connecting_cell, doorhardpoint } = portal;

        // Extract portal position if available
        let portalPos = null;
        if (doorhardpoint && doorhardpoint.length === 12) {
            portalPos = {
                x: doorhardpoint[3],
                y: doorhardpoint[7],
                z: doorhardpoint[11]
            };
        }

        connections.push({
            from: cellIdx,
            to: connecting_cell,
            portalId: id,
            portalPos
        });
    });
});

console.log('=== CONNECTIONS ===');
connections.forEach((conn, idx) => {
    console.log(`${conn.from} -> ${conn.to} (portal ${conn.portalId}) ${conn.portalPos ? `at {${conn.portalPos.x.toFixed(2)}, ${conn.portalPos.y.toFixed(2)}, ${conn.portalPos.z.toFixed(2)}}` : 'NO POSITION'}`);
});

// Calculate cell positions using BFS
// Start with cell 0 at origin (user said building is a cube with 0,0,0 at top)
cellPositions.set(0, { x: 0, y: 0, z: 0 });

const queue = [0];
const visited = new Set([0]);

console.log('\n=== CALCULATING CELL POSITIONS ===');
console.log('Starting with cell 0 (exterior) at {0.00, 0.00, 0.00}');

while (queue.length > 0) {
    const currentCell = queue.shift();
    const currentPos = cellPositions.get(currentCell);

    // Find all connections from this cell
    const outgoing = connections.filter(c => c.from === currentCell && !visited.has(c.to));

    outgoing.forEach(conn => {
        if (!visited.has(conn.to)) {
            visited.add(conn.to);
            queue.push(conn.to);

            // Calculate position of connected cell
            let newPos;
            if (conn.portalPos) {
                // Use portal position to offset the next cell
                // Portal position is where the portal is in the CURRENT cell
                // The connected cell is on the other side of the portal
                // Assume a simple offset for now (this is an approximation)
                newPos = {
                    x: currentPos.x + conn.portalPos.x,
                    y: currentPos.y + conn.portalPos.y,
                    z: currentPos.z + conn.portalPos.z
                };
            } else {
                // No portal position available - use default offset
                // This is a placeholder; real logic would need cell appearance bounds
                // For now, offset by 20 units in Y direction (depth into building)
                newPos = {
                    x: currentPos.x,
                    y: currentPos.y + 20,  // Arbitrary offset
                    z: currentPos.z
                };
            }

            cellPositions.set(conn.to, newPos);
            console.log(`Cell ${conn.to} (${pob.cells[conn.to].name}) -> {${newPos.x.toFixed(2)}, ${newPos.y.toFixed(2)}, ${newPos.z.toFixed(2)}}`);
        }
    });
}

console.log('\n=== FINAL CELL POSITIONS ===');
for (let i = 0; i < pob.cells.length; i++) {
    const pos = cellPositions.get(i);
    if (pos) {
        console.log(`Cell ${i}: ${pob.cells[i].name.padEnd(12)} -> {${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}}`);
    } else {
        console.log(`Cell ${i}: ${pob.cells[i].name.padEnd(12)} -> NOT CALCULATED`);
    }
}

console.log('\n=== COMPARISON WITH DEATH WATCH ===');
console.log('Death Watch bunker coordinates for reference:');
console.log('  Cell offset 13: {19.24, -12.00, 4.30}');
console.log('  Cell offset 11: {70.23, -12.00, 57.70}');
console.log('  Cell offset 4:  {-13.64, -12.00, 52.47}');
console.log('');
console.log('Notice: Z=-12.00 is consistent (floor height)');
console.log('X and Y vary widely based on cell layout');

console.log('\n=== NEXT STEPS ===');
console.log('1. Portal positions give RELATIVE offsets, not absolute building coordinates');
console.log('2. Need to parse cell appearance files (LOD/MSH) to get cell bounding boxes');
console.log('3. Combine portal connections + cell bounds to calculate absolute positions');
console.log('4. Alternative: Use a simpler 2D/3D layout algorithm based on connectivity graph');
