# Building Composer — Implementation Plan

A VSCode extension for visually assembling SWG building interiors by connecting cells from different POBs. Start with a cloned building, browse a catalog of compatible rooms, and the tool auto-rotates geometry to snap portals together.

Reference: [POB-editor.md](POB-editor.md) for format details and pitfall catalog.

---

## Workflow

1. **Clone a base building** — Pick any vanilla building, name the clone, tool duplicates all files (POB, meshes, floors, IFF) under the new name
2. **Visualize** — See building topology on a canvas (cells as nodes, portals as edges)
3. **Customize cells** — Replace appearance from catalog, remove, or recolor
4. **Attach new cells** — Click an open portal, browse compatible cells, pick one
5. **Auto-align** — Tool computes rotation + translation from portal normals
6. **Transform** — Tool rotates all donor geometry (mesh, floor, collision, lights, doors)
7. **Repeat** until interior is complete
8. **Generate** — POB + IFF + CRC + STF + Lua files

---

## Extension Structure

```
packages/building-composer/
├── package.json             # VSCode extension manifest
├── tsconfig.json
└── src/
    ├── extension.ts         # Entry point: register command
    ├── composerPanel.ts     # WebviewPanel: HTML, canvas, message handling
    ├── cellCatalog.ts       # Scan 291 POBs, index cells by portal shape
    ├── portalAlignment.ts   # Auto-rotation/translation from portal normals
    ├── buildingAssembler.ts # Transform + attach cells to working POB
    ├── outputPipeline.ts    # Generate all output files
    └── types.ts             # Shared interfaces
```

Pattern: Follows `building-npc-planner` (WebviewPanel + Canvas 2D, no external deps).

---

## UI Layout

```
+------------------------------------------------------------------+
| Building: [my_custom_house____]  [Save] [Generate]               |
+------------------------------------------------------------------+
| INITIAL VIEW (before building loaded):                            |
|   [Clone Existing Building v]  ->  picks vanilla POB + names it   |
|   [New Empty Building]         ->  cell 0 only, name it           |
+------------------------------------------------------------------+
| AFTER LOADING:                                                    |
+--------+---------------------------------------------------------+
| SIDEBAR | BUILDING CANVAS (top)                                   |
|         | Cells as labeled boxes, portal lines between them       |
| Cell    | Open portals = colored dots (clickable)                 |
| List    | Selected cell = cyan, modified = orange                 |
|         +---------------------------------------------------------+
| [0] r0  | CELL DETAIL / CATALOG (bottom)                         |
| [1] foy | When CELL selected:                                     |
| [2] hal |   Source: naboo_lg_s01, appearance: mesh/r2.msh         |
| ...     |   [Replace from Catalog] [Remove Cell] [Revert]        |
|         |                                                         |
| Open    | When OPEN PORTAL selected:                              |
| Portals |   "Portal 5 on cell 2 (hall1) -- 2.5x2.5m"             |
| - p5    |   Compatible cells from catalog:                        |
| - p12   |     warren/hall4 [Attach]  bunker_s02/entry [Attach]   |
|         |   Preview: floor geometry of hovered donor cell         |
+---------+---------------------------------------------------------+
```

---

## Data Model

```typescript
// Composition state (saved/loaded as JSON)
interface Composition {
    basePobPath: string;           // Starting building POB
    buildingName: string;          // Output name
    attachments: Attachment[];     // Cells added to the building
}

interface Attachment {
    targetCellIndex: number;       // Cell in building with the open portal
    targetPortalId: number;        // Portal ID being connected to
    sourcePobPath: string;         // Donor POB file
    sourceCellIndex: number;       // Cell index in donor POB
    sourcePortalId: number;        // Which donor portal connects
    rotationDeg: number;           // 0, 90, 180, 270 (auto-computed)
    translateX: number;
    translateZ: number;
    deltaY: number;
    includedCells?: number[];      // Additional donor cells to bring along
}

// Cell catalog entry
interface CatalogCell {
    pobPath: string;
    pobName: string;
    cellIndex: number;
    cellName: string;
    portalShapes: PortalShape[];
    numLights: number;
    hasFloor: boolean;
}

interface PortalShape {
    portalId: number;
    width: number;
    height: number;
    shapeKey: string;              // "2.5x2.5" (0.5m buckets)
    normal: { x: number, z: number };
    center: { x: number, y: number, z: number };
}
```

---

## Core Algorithm: Portal Auto-Alignment

```
1. Compute normals from portal vertex cross products
2. Compute Y-rotation angle:
   target_angle = atan2(-N_t.x, -N_t.z)
   donor_angle  = atan2(N_d.x, N_d.z)
   rotation = snap_to_90(target_angle - donor_angle)
3. After rotation, translate donor portal center onto target portal center
4. Compute Y shift from floor level alignment
5. Combined: point -> rotateY(point, rotation) + translate + (0, deltaY, 0)
```

See [POB-editor.md#5-cross-pob-portal-alignment](POB-editor.md#5-cross-pob-portal-alignment) for full details.

---

## Clone Building Pipeline

When user picks "Clone Existing Building":

1. Parse source POB
2. Copy all cell mesh files -> `tre/working/appearance/mesh/{name}_r{N}.msh`
3. Copy all cell floor files -> `tre/working/appearance/collision/{name}_r{N}.flr`
4. Update `appearance_file` / `floor_file` paths in POB
5. Serialize POB -> `tre/working/appearance/{name}.pob`
6. Clone building IFF via `cloneIFFSafe()` -> `tre/working/object/building/general/shared_{name}.iff`
7. Register CRC + STF entries
8. Generate Lua server template

Result: independently-editable building identical to original. All subsequent edits touch only clone files.

---

## Geometry Transform Checklist

For each attached cell (see [POB-editor.md#4-geometry-transforms-rotation](POB-editor.md#4-geometry-transforms-rotation)):

- [ ] Mesh vertices: rotate position + normal
- [ ] Mesh SPHR: rotate center
- [ ] Mesh BOX: recompute min/max (max at offset 0!)
- [ ] Floor VERT: rotate positions
- [ ] Floor TRIS: rotate normals (offset 28 per 60-byte record)
- [ ] Floor PNOD: rotate positions (offsets 16,20,24 per 32-byte record)
- [ ] Floor BTRE: strip entirely
- [ ] Collision extent (CMSH): deep-clone, rotate VERT data
- [ ] Lights: rotate 4x3 transform matrix
- [ ] Door hardpoints: rotate 4x3 transform matrix
- [ ] Portal vertices: rotate global polygon verts

---

## Output Pipeline

1. **Assemble POB** — Apply replacements/attachments, remap portal IDs, generate PGRF
2. **Write rotated meshes** — `{name}_attached_*.msh`
3. **Write rotated floors** — `{name}_attached_*.flr`
4. **Write POB** — Overwrite `tre/working/appearance/{name}.pob`
5. **Update building IFF** — Re-clone if POB path changed
6. **Update CRC/STF** — Idempotent (duplicate guards)
7. **Update Lua** — Regenerate if cell count changed

---

## Phased Implementation

### Phase 1: Clone + Visualize

Files: `extension.ts`, `composerPanel.ts` (initial), `types.ts`

- [ ] Extension scaffold (package.json, tsconfig, extension.ts)
- [ ] Clone building operation (copy POB + meshes/floors + IFF + CRC + STF + Lua)
- [ ] Basic composerPanel with building canvas (stick diagram via `calculateCellPositions`)
- [ ] Cell list sidebar with click-to-select
- [ ] Cell detail view (metadata, portal info, floor geometry preview)
- [ ] Save/load composition state as JSON

Key reuse:
- `packages/building-npc-planner/src/npcPlannerPanel.ts` — WebviewPanel pattern, Canvas 2D
- `packages/core/src/cellPositions.ts` — `calculateCellPositions()`
- `packages/core/generate-building.js` — IFF cloning, CRC/STF, Lua generation

### Phase 2: Cell Catalog + Matching

Files: `cellCatalog.ts`, `composerPanel.ts` (catalog UI)

- [ ] Cell catalog scanner + cache (port `scripts/cell-catalog.js` to TypeScript)
- [ ] Portal shape analysis (width, height, normal direction)
- [ ] Compatible cell query (match by portal shape key)
- [ ] Catalog browser UI in bottom panel (grouped by source building)

Key reuse:
- `scripts/cell-catalog.js` — Portal dimension analysis, shape bucketing
- `packages/core/src/pob.ts` — `parsePOB()`

### Phase 3: Auto-Alignment + Assembly

Files: `portalAlignment.ts`, `buildingAssembler.ts`, `composerPanel.ts` (attach UI)

- [ ] Portal alignment algorithm (normal computation, rotation snapping, translation)
- [ ] Geometry transforms (mesh, floor, collision, lights, doors) for 0/90/180/270 deg
- [ ] "Attach" cell workflow: click open portal -> pick from catalog -> auto-align -> add
- [ ] "Replace" cell workflow: swap a cell's appearance from catalog
- [ ] "Remove" cell workflow: disconnect cell, leave portal open
- [ ] POB assembly with portal remapping + PGRF generation

Key reuse:
- `scripts/godzilla-house.js` — Mesh/floor/collision/light/door transforms, PGRF
- `packages/core/src/pob.ts` — `serializePOB()`

### Phase 4: Output + Polish

Files: `outputPipeline.ts`, `composerPanel.ts` (generate button)

- [ ] Full output pipeline (POB + IFF + CRC + STF + Lua)
- [ ] Verify round-trip (`parsePOB(serializePOB(pob))` matches)
- [ ] Cell chain import (bring multiple connected cells from donor at once)
- [ ] Undo/revert operations
- [ ] Error reporting (portal mismatch warnings, missing files)
- [ ] Progress indicator during generation

Key reuse:
- `packages/core/generate-building.js` — Full output pipeline

---

## Key Files to Reuse

| Source | Reuse For |
|--------|-----------|
| `packages/building-npc-planner/src/npcPlannerPanel.ts` | WebviewPanel + Canvas 2D pattern |
| `scripts/cell-catalog.js` | Portal dimension analysis, shape bucketing |
| `scripts/godzilla-house.js` | All geometry rotation transforms |
| `packages/core/src/pob.ts` | `parsePOB()` / `serializePOB()` |
| `packages/core/src/cellPositions.ts` | `calculateCellPositions()` for stick diagram |
| `packages/core/generate-building.js` | IFF cloning, CRC/STF, Lua generation |

---

## Verification

1. **Unit**: Catalog scanner produces expected cell counts for known POBs
2. **Unit**: Portal alignment computes correct rotation for known portal pairs (naboo portal 12 + warren portal 3 -> 180 deg)
3. **Integration**: Compose a 2-cell building (exterior + one room), generate files, load in SWG client
4. **Integration**: Reproduce godzilla-house result using the UI (naboo + warren cells)
5. **Round-trip**: Generated POB parses back correctly
