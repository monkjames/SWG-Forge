# POB Editor — Reference Guide

Comprehensive reference for programmatically editing SWG POB (Portalized Object) building files. Covers cell manipulation, cross-POB merging, geometry rotation, portal alignment, and the full output pipeline.

This document captures hard-won lessons from building the godzilla-house (Naboo + warren dungeon merge) and is the reference for the Building Composer plugin.

---

## Table of Contents

1. [POB File Overview](#1-pob-file-overview)
2. [Cell Structure](#2-cell-structure)
3. [Portal System](#3-portal-system)
4. [Geometry Transforms (Rotation)](#4-geometry-transforms-rotation)
5. [Cross-POB Portal Alignment](#5-cross-pob-portal-alignment)
6. [Cell Catalog & Portal Matching](#6-cell-catalog--portal-matching)
7. [Clone Building Pipeline](#7-clone-building-pipeline)
8. [Output Pipeline](#8-output-pipeline)
9. [Bugs & Pitfalls Catalog](#9-bugs--pitfalls-catalog)
10. [File Format Quick Reference](#10-file-format-quick-reference)

---

## 1. POB File Overview

A POB building consists of multiple interconnected files:

```
Building POB (.pob)
  Cell 0: "exterior" (always first, virtual room — no mesh)
  Cell 1: "entry"
    appearance_file -> appearance/mesh/building_r1.apt (visual mesh chain)
    floor_file      -> appearance/collision/building_r1.flr (walkable navmesh)
    portals[]       -> connections to other cells
    lights[]        -> point/ambient lights with 4x3 transform matrices
    collision       -> CMSH/EXBX/EXSP bounding volume
  Cell 2: "hallway"
    ...
  Path Graph (PGRF) -> NPC waypoint navigation
  CRC               -> integrity checksum
```

### Key Principle: No Per-Cell Transform

**The POB has NO per-cell transform, rotation, or position.** All cell meshes coexist in the same building-absolute coordinate space. To move or rotate cell geometry, you must modify the `.msh` vertex data directly. This is the fundamental reason the Building Composer needs geometry transforms.

### Two POB Versions

| Version | Used By | Int32 Endianness | Portal Format |
|---------|---------|-------------------|---------------|
| v0003 | Most vanilla buildings | Little-endian | Flat `CHUNK PRTL` (numVerts + verts) |
| v0004 | Newer buildings | Big-endian | `FORM IDTL > VERT + INDX` |

`serializePOB()` preserves whichever version was parsed via `pob.version`.

---

## 2. Cell Structure

### Cell DATA Fields

| Field | Description |
|-------|-------------|
| `numPortals` | Number of portal connections |
| `canSeeWorld` | `true` for cell 0 and cells sharing a portal with cell 0 |
| `name` | Cell name (e.g., "r1", "hallway", "entryhall") |
| `appearance_file` | Path to visual mesh (e.g., `appearance/mesh/r1.apt`) |
| `hasFloor` | Whether cell has a floor file |
| `floor_file` | Path to nav mesh (e.g., `appearance/collision/r1.flr`) |

### Cell 0 Convention

Cell 0 is always the "exterior" cell:
- `canSeeWorld = true`
- No appearance file (empty string)
- No floor file
- Its portals define building entry points

### Collision Extents

After the cell DATA chunk, a collision extent FORM defines the cell's bounding volume:

| Form | Description |
|------|-------------|
| `NULL` | No collision (cell 0 exterior) |
| `CMSH` | Collision mesh (detailed) |
| `EXBX` | Axis-aligned bounding box |
| `EXSP` | Bounding sphere |
| `XCYL` | Bounding cylinder |

**CRITICAL**: The client uses collision extents for cell containment checks during portal visibility traversal. Unrotated extents = cell not rendered.

---

## 3. Portal System

### Portal Connectivity

Portals are **bidirectional**. If cell A connects to cell B through portal P:
- Cell A: `portal_id=P, connecting_cell=B, clockwise=true`
- Cell B: `portal_id=P, connecting_cell=A, clockwise=false`

### Portal Connection Fields (PRTL chunk)

| Field | Type | Description |
|-------|------|-------------|
| `disabled` | uint8 | v0005 chunk only (absent in v0004) |
| `passable` | uint8 | Can player pass through |
| `portal_id` | int32 **LE** | Global portal index (always LE!) |
| `clockwise` | uint8 | Winding direction flag |
| `connecting_cell` | int32 **LE** | Destination cell index (always LE!) |
| `doorstyle` | string | Door appearance name (e.g., "poi_all_impl_bunker_int_door") |
| `hasDoorHardpoint` | uint8 | Whether door transform follows |
| `doorhardpoint` | float32[12] | 4x3 transform matrix for door placement |

### Door System

When a portal has a `doorstyle`:
1. Client resolves style name via `datatables/appearance/door_style.iff`
2. Loads door mesh from the resolved appearance path
3. Places door at `doorhardpoint` position in building-space
4. Door has `triggerRadius` (typically ~4 units)
5. When player is within radius, door slides open
6. **If door never opens, portal renders as opaque pink/mauve rectangle**

### Portal Geometry (PRTS)

Global portal polygons stored at the POB level:
- **v0003**: Flat `CHUNK PRTL` with `int32LE numVerts + float32[3] * numVerts`. Triangles generated as fan `(0, i-1, i)`.
- **v0004**: `FORM IDTL > FORM 0000 > VERT + INDX`. Explicit triangle indices.

### Clockwise Flag Rules

- Do **NOT** flip clockwise during rotation
- Server uses it for ejection point calculation
- Client uses it for cell tracking during portal crossing
- Flipping breaks portal traversal (player gets stuck at boundaries)

### Triangle Winding Rules

- Do **NOT** reverse triangle winding
- v0003 ignores tris during serialization (generates fans from vertices)
- v0004 uses clockwise flag, not triangle normals, for facing
- Reversing tris breaks portal crossing

---

## 4. Geometry Transforms (Rotation)

When cells from one POB are merged into another, their geometry must be rotated and translated to align portals. SWG portals are axis-aligned, so rotation snaps to 90 increments.

### What Must Be Transformed

For each rotated cell, ALL of these must be transformed:

| Component | File | Transform Details |
|-----------|------|-------------------|
| **Mesh vertices** | `.msh` | Rotate position (x,y,z) + normal (nx,ny,nz) |
| **Mesh SPHR** | `.msh` | Rotate center point |
| **Mesh BOX** | `.msh` | Recompute min/max after rotation |
| **Floor vertices** | `.flr` VERT | Rotate position (x,y,z) |
| **Floor normals** | `.flr` TRIS | Rotate normal at offset 28 per 60-byte record |
| **Floor PNOD** | `.flr` PGRF | Rotate position at offsets 16,20,24 per 32-byte record |
| **Floor BTRE** | `.flr` | **Strip entirely** (stale BSP data) |
| **Collision extent** | POB CMSH | Deep-clone rawNode, rotate VERT data |
| **Lights** | POB LGHT | Rotate 4x3 transform matrix |
| **Door hardpoints** | POB PRTL | Rotate 4x3 transform matrix |
| **Portal vertices** | POB PRTS | Rotate global portal polygon verts |

### 4x3 Transform Matrix Layout (Lights & Door Hardpoints)

Column-major layout (12 floats):

```
Index:  [0]    [1]    [2]    [3]    [4]    [5]    [6]    [7]    [8]    [9]    [10]   [11]
        m00    m10    m20    tx     m01    m11    m21    ty     m02    m12    m22    tz
        ─── X row ───  posX  ─── Y row ───  posY  ─── Z row ───  posZ
```

- **Position**: indices `[3]`, `[7]`, `[11]`
- **Rotation rows**: X=[0,4,8], Y=[1,5,9], Z=[2,6,10]
- Identity: `[1,0,0,0, 0,1,0,0, 0,0,1,0]`

### Rotation Formulas

For rotation by angle theta around Y axis:

```
General:  x' = x*cos(theta) + z*sin(theta)
          z' = -x*sin(theta) + z*cos(theta)
          y' = y  (unchanged)

  0 deg:  (x, z) -> (x, z)         [identity]
 90 deg:  (x, z) -> (z, -x)
180 deg:  (x, z) -> (-x, -z)       [negate both]
270 deg:  (x, z) -> (-z, x)
```

### 180 Degree Y Rotation (Godzilla House Case)

For the common 180 case with pivot at (CX, CZ):

```javascript
rotX(x) = 2 * CX - x;    // reflect around pivot X
rotZ(z) = 2 * CZ - z;    // reflect around pivot Z
shiftY(y) = y + deltaY;  // vertical offset between buildings
```

**Mesh vertices**: `(x,y,z) -> (rotX(x), shiftY(y), rotZ(z))`
**Mesh normals**: `(nx,ny,nz) -> (-nx, ny, -nz)`
**Light/door transforms**: Negate rotation rows [0,2,4,6,8,10], rotate translation [3,7,11]

### Floor TRIS Normals

Each 60-byte triangle record has normal at offset 28 (three float32 LE: nx, ny, nz).
- **v0006**: TRIS chunk has 4-byte header before triangle data
- **v0003/v0005**: No header (triangles start at offset 0)
- For 180 Y rotation: negate nx and nz, keep ny

### Floor PNOD (Path Graph Nodes)

32-byte records with 4-byte int32LE header (node count):
- Bytes 0-15 per record: int32 fields (index, id, key, type) — do NOT modify
- Bytes 16-27 per record: float32 position (x, y, z) — rotate these
- Bytes 28-31: float32 radius — do NOT modify

### Mesh BOX Format

**CRITICAL**: BOX stores `(maxX, maxY, maxZ, minX, minY, minZ)` — max corner FIRST.

After rotation, recompute min/max from all vertices and write max at offset 0, min at offset 12. Getting this backwards creates an inside-out bounding box where the client's frustum culling fails angle-dependently.

### Mesh SPHR Format

16 bytes: `(centerX, centerY, centerZ, radius)`. Rotate center point, keep radius.

---

## 5. Cross-POB Portal Alignment

### The Portal Normal Algorithm

Given target portal T (in the building) and donor portal D (in the donor cell's POB):

```
Step 1: Compute portal normals
  N_t = normalize(cross(T.verts[1] - T.verts[0], T.verts[2] - T.verts[0]))
  N_d = normalize(cross(D.verts[1] - D.verts[0], D.verts[2] - D.verts[0]))

Step 2: Compute Y-rotation angle
  // Donor normal must face OPPOSITE to target normal (they face each other)
  target_angle = atan2(-N_t.x, -N_t.z)   // direction portal should face
  donor_angle  = atan2(N_d.x, N_d.z)     // direction donor currently faces
  rotation = target_angle - donor_angle   // snap to nearest 90 deg

Step 3: Compute translation
  // After rotation, donor portal center must land on target portal center
  D_center_rotated = applyYRotation(D_center, rotation, about_origin)
  translate = T_center - D_center_rotated

Step 4: Compute Y shift
  deltaY = min(T.verts.y) - min(rotatedD.verts.y)  // align floor levels

Step 5: Combined transform
  point -> rotateY(point, rotation) + translate + (0, deltaY, 0)
```

### Rotation Pivot (180 deg special case)

For 180 rotation, the pivot must be the **midpoint** of both portal centers:

```
CORRECT pivot:
  CX = (targetPortalCenter.x + donorPortalCenter.x) / 2
  CZ = (targetPortalCenter.z + donorPortalCenter.z) / 2

WHY: 180 deg rotation around M maps point P to 2M - P.
  For donor center to land on target center:
  2M - donorCenter = targetCenter
  M = (targetCenter + donorCenter) / 2
```

Using just the target portal center as pivot causes the rotated geometry to be offset by the distance between portal centers.

### Portal Shape Matching

Portals are compatible when their dimensions match within a tolerance. Shape key format: `"{width}x{height}"` at 0.5m resolution buckets.

```
Portal width  = max(verts.x) - min(verts.x)  OR  max(verts.z) - min(verts.z)
Portal height = max(verts.y) - min(verts.y)
Shape key = round to nearest 0.5m, e.g., "2.5x2.5"
```

---

## 6. Cell Catalog & Portal Matching

### Catalog Structure

Index all vanilla POBs (291 files) by portal shape:

```typescript
interface CatalogCell {
    pobPath: string;           // Path to source POB
    pobName: string;           // Display name
    cellIndex: number;         // Cell index in source
    cellName: string;          // Cell name (e.g., "hall4")
    portalShapes: PortalShape[];
    numLights: number;
    hasFloor: boolean;
}

interface PortalShape {
    portalId: number;
    width: number;
    height: number;
    shapeKey: string;          // "2.5x2.5"
    normal: { x: number, z: number };
    center: { x: number, y: number, z: number };
}
```

### Query

Given an open portal's shape key, return all catalog cells with at least one matching portal. Group by source building for browsing.

### Existing Implementation

`scripts/cell-catalog.js` already implements:
- POB scanning and portal dimension analysis
- Shape key bucketing at 0.5m resolution
- Portal normal computation

---

## 7. Clone Building Pipeline

Clone an existing building under a new name as the starting point for customization:

### Steps

1. **Parse source POB** — `parsePOB(fs.readFileSync(sourcePath))`
2. **Copy mesh files** — For each cell's `appearance_file`, copy to `tre/working/appearance/mesh/{name}_r{N}.msh` (renamed)
3. **Copy floor files** — For each cell's `floor_file`, copy to `tre/working/appearance/collision/{name}_r{N}.flr` (renamed)
4. **Update POB paths** — Set `appearance_file` and `floor_file` in each cell to reference the copies
5. **Serialize POB** — `serializePOB(pob)` → `tre/working/appearance/{name}.pob`
6. **Clone building IFF** — Use `cloneIFFSafe()` (NOT `cloneIFFWithReplacements()`) with updated POB path → `tre/working/object/building/general/shared_{name}.iff`
7. **Register CRC** — `addCRCEntries()` (has duplicate guard)
8. **Register STF** — `addSTFEntries()` for building name/description
9. **Generate Lua** — Server template with `portalLayoutFilename` and `totalCellNumber`

### Key APIs

```typescript
// SAFE: Parse -> replace -> reserialize with correct FORM sizes
cloneIFFSafe(data, replacements);

// UNSAFE: Raw binary replacement, corrupts FORM sizes when string lengths change
// NEVER USE: cloneIFFWithReplacements(data, replacements);
```

### File Locations

| Output | Path |
|--------|------|
| POB | `tre/working/appearance/{name}.pob` |
| Meshes | `tre/working/appearance/mesh/{name}_r{N}.msh` |
| Floors | `tre/working/appearance/collision/{name}_r{N}.flr` |
| Building IFF | `tre/working/object/building/general/shared_{name}.iff` |
| CRC table | `tre/working/misc/object_template_crc_string_table.iff` |
| STF strings | `tre/working/string/en/*.stf` |
| Lua template | `infinity_wicked/MMOCoreORB/bin/scripts/custom_scripts/object/building/general/{name}.lua` |

---

## 8. Output Pipeline

After cell edits/attachments, regenerate modified files:

1. **Assemble POB** — Apply cell replacements/attachments. Remap portal IDs. Generate PGRF.
2. **Write rotated meshes** — For cross-POB attachments: `{name}_attached_*.msh`
3. **Write rotated floors** — `{name}_attached_*.flr`
4. **Write POB** — Overwrite `tre/working/appearance/{name}.pob`
5. **Update building IFF** — Re-clone if POB path changed
6. **Update CRC/STF** — Idempotent (duplicate guards)
7. **Update Lua** — Regenerate if cell count changed

### PGRF Generation

POBs MUST include a PGRF section. Without it, the server's PortalLayout parser throws `InvalidChunkTypeException`. Minimum: `{ pathGraphType: 0, nodes: [], edges: [] }`.

For a functional path graph, generate building-level nodes:
- Type 3 (BuildingEntrance) at each exterior portal
- Type 4 (BuildingCell) at each cell center
- Type 5 (BuildingPortal) at each inter-cell portal
- Edges connecting entrance -> cell -> portal -> cell

---

## 9. Bugs & Pitfalls Catalog

Hard-won lessons from the godzilla-house project. Each was a multi-hour debugging session.

### Pink Portal Rectangles (Door Hardpoint)

**Symptom**: Portals render as opaque pink/mauve rectangles instead of showing adjacent cells.
**Root Cause**: Door hardpoint transforms not rotated. Doors placed 80-140 units from actual portals. Client door trigger radius is ~4 units, so door never opens.
**Fix**: Rotate `doorhardpoint` matrix same as light transforms.
**Diagnostic**: Compare `doorhardpoint` position (indices 3,7,11) against portal center. Should be within ~2 units.

### Invisible Cells / "Floating in Space" (Collision Extent)

**Symptom**: Cell geometry exists but client doesn't render it. Player appears to float in empty space.
**Root Cause**: CMSH collision extent not rotated. Client's cell containment check fails (thinks player isn't in the cell).
**Fix**: Deep-clone the CMSH rawNode IFF tree and rotate its VERT chunk data.

### Dark Cells Through Portals (Light Transform)

**Symptom**: Adjacent cells appear completely dark when viewed through portals, looking like empty space.
**Root Cause**: Light transform matrices not rotated. Point lights illuminate original (unrotated) positions.
**Fix**: Rotate light `transform` field (12 floats, column-major 4x3). Note: accessing `light.position` silently returns `undefined` — the field is `transform`.

### Angle-Dependent Rendering (BOX Min/Max)

**Symptom**: Cells render when looking one direction but show void from another angle.
**Root Cause**: Mesh BOX format is `(max, max, max, min, min, min)` — max corner at offset 0. Writing min-first creates inside-out bounding box, breaking frustum culling.
**Fix**: After rotation, recompute min/max from all vertices. Write max at offset 0, min at offset 12.

### Portal Crossing Stuck (Clockwise/Winding)

**Symptom**: Player gets stuck at cell boundaries, can't walk through portals.
**Root Cause**: Flipped clockwise flags or reversed triangle winding.
**Fix**: Do NOT modify clockwise or triangle winding. Keep original values from source POB.

### Stale BSP Data (BTRE FormName)

**Symptom**: Floor collision behaves incorrectly after rotation.
**Root Cause**: BTRE (BSP tree) in floor files contains AABB bounding boxes that weren't rotated.
**Fix**: Strip BTRE from rotated floor files. **IFF gotcha**: Filter on `child.formName === 'BTRE'`, NOT `child.tag === 'BTRE'`. FORM nodes have `tag="FORM"`.

### IFF Clone Corruption (Wrong Function)

**Symptom**: Building IFF fails to load, FORM sizes incorrect.
**Root Cause**: Used `cloneIFFWithReplacements()` (raw binary replacement) instead of `cloneIFFSafe()` (parse-replace-reserialize).
**Fix**: Always use `cloneIFFSafe()`.

### TRE Configuration Crashes

**Rule**: `infinity_rnd.tre` must NOT carry CRC table or STF. Only object/appearance files. CRC+STF go into `tre/working/` so `infinity_wicked1.tre` carries the full table.
**Rule**: Duplicate TRE entries in `tre4/swgemu_live.cfg` crash the SWG client on login.

---

## 10. File Format Quick Reference

### Endianness (v0003 vs v0004)

| Field | v0003 | v0004 |
|-------|-------|-------|
| DATA numPortals/numCells | LE | BE |
| Cell DATA numPortals | LE | BE |
| PRTL portal_id | **LE** | **LE** |
| PRTL connecting_cell | **LE** | **LE** |
| PRTL doorhardpoint floats | LE | LE |
| VERT coordinates | LE | LE |
| TRIS corner/nindex | BE | BE |
| TRIS normal floats | LE | LE |
| LGHT count | LE | BE |
| LGHT float values | LE | LE |
| PGRF counts/node ints | LE | BE |
| PGRF node floats | LE | LE |
| CRC | LE | BE |

**Note**: `portal_id` and `connecting_cell` are ALWAYS little-endian in both versions.

### Common POBs for Testing

| POB | Description | Cells |
|-----|-------------|-------|
| `poi_all_impl_bunker_s02.pob` | Medium bunker | ~20 |
| `poi_all_impl_bunker_warren_s01.pob` | Warren dungeon | 88 |
| `ply_nboo_house_lg_s01_fp1.pob` | Large Naboo house | 15 |
| `bespin_house.pob` | Simple player house | ~5 |

### Key Source Files

| File | Purpose |
|------|---------|
| `packages/core/src/pob.ts` | `parsePOB()` / `serializePOB()` |
| `packages/core/src/flr.ts` | `parseFLR()` / `serializeFLR()` |
| `packages/core/src/cellPositions.ts` | `calculateCellPositions()` |
| `packages/core/generate-building.js` | IFF clone, CRC/STF, Lua generation |
| `scripts/godzilla-house.js` | Cross-POB merge reference (180 rotation) |
| `scripts/cell-catalog.js` | Portal dimension analysis, shape bucketing |
| `scripts/poc-cell-swap.js` | Same-POB cell appearance swap |
