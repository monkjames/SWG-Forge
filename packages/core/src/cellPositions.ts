/**
 * Cell position calculator for POB files
 * Calculates 3D positions of cells based on portal connectivity
 */

import { PobData } from './pob';

export interface CellPosition {
    cellIndex: number;
    cellName: string;
    x: number;
    y: number;
    z: number;
}

export interface CellConnection {
    from: number;
    to: number;
    portalId: number;
    portalPos?: { x: number; y: number; z: number };
}

/**
 * Calculate 3D positions for all cells in a POB building
 * Uses BFS graph traversal starting from cell 0 (exterior)
 */
export function calculateCellPositions(pob: PobData): {
    positions: Map<number, CellPosition>;
    connections: CellConnection[];
} {
    const connections: CellConnection[] = [];
    const positions = new Map<number, CellPosition>();

    // Build connectivity graph
    pob.cells.forEach((cell, cellIdx) => {
        cell.portals.forEach((portal) => {
            const { id, connecting_cell, doorhardpoint } = portal;

            // Extract portal position from doorhardpoint if available
            // Doorhardpoint is a 4x3 transform matrix:
            // [rotXx, rotXy, rotXz, posX,
            //  rotYx, rotYy, rotYz, posY,
            //  rotZx, rotZy, rotZz, posZ]
            let portalPos: { x: number; y: number; z: number } | undefined;
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

    // Calculate positions using BFS
    // Start with cell 0 (exterior) at origin
    // User insight: "the whole cave can be thought of as a cube, so 0,0,0 would be if a cell was situated at the top of the cube"
    positions.set(0, {
        cellIndex: 0,
        cellName: pob.cells[0]?.name || 'exterior',
        x: 0,
        y: 0,
        z: 0
    });

    const queue: number[] = [0];
    const visited = new Set<number>([0]);

    while (queue.length > 0) {
        const currentCell = queue.shift()!;
        const currentPos = positions.get(currentCell)!;

        // Find all outgoing connections from this cell
        const outgoing = connections.filter(
            c => c.from === currentCell && !visited.has(c.to)
        );

        outgoing.forEach(conn => {
            if (!visited.has(conn.to) && conn.to < pob.cells.length) {
                visited.add(conn.to);
                queue.push(conn.to);

                // Calculate position of connected cell
                let newPos: { x: number; y: number; z: number };

                if (conn.portalPos) {
                    // Use portal position to calculate offset
                    // Portal position is where the portal is in the CURRENT cell
                    // The connected cell is on the other side
                    newPos = {
                        x: currentPos.x + conn.portalPos.x,
                        y: currentPos.y + conn.portalPos.y,
                        z: currentPos.z + conn.portalPos.z
                    };
                } else {
                    // No portal position available - use default offset
                    // Assume linear progression deeper into the building (Y+)
                    newPos = {
                        x: currentPos.x,
                        y: currentPos.y + 20,  // Default offset
                        z: currentPos.z
                    };
                }

                positions.set(conn.to, {
                    cellIndex: conn.to,
                    cellName: pob.cells[conn.to]?.name || `cell_${conn.to}`,
                    ...newPos
                });
            }
        });
    }

    return { positions, connections };
}

/**
 * Get bounding box of all cell positions
 */
export function getCellBoundingBox(positions: Map<number, CellPosition>): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
} {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    positions.forEach(pos => {
        minX = Math.min(minX, pos.x);
        maxX = Math.max(maxX, pos.x);
        minY = Math.min(minY, pos.y);
        maxY = Math.max(maxY, pos.y);
        minZ = Math.min(minZ, pos.z);
        maxZ = Math.max(maxZ, pos.z);
    });

    return { minX, maxX, minY, maxY, minZ, maxZ };
}
