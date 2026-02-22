# FLR Viewer

Visual floor mesh viewer for SWG building cells. Renders floor triangles as a top-down 2D canvas with color-coded edges, path graph overlays, zoom/pan navigation, and hover info.

## What are floor meshes?

Floor mesh files (`.flr`) define the walkable surfaces inside building cells. Each cell in a POB (Portalized Object Building) has a corresponding floor mesh that tells the server:

- **Where players can walk** (triangle mesh)
- **Where walls are** (uncrossable edges)
- **Where doorways connect cells** (portal edges)
- **How NPCs navigate** (path graph with waypoints and connections)

## IFF Chunk Structure

FLR files use IFF container format:

```
FORM FLOR
  FORM <version>               -- "0003", "0005", or "0006"
    CHUNK VERT                  -- Vertices: 3 floats (x, y, z) per vertex
    CHUNK TRIS                  -- Triangles: 60 bytes per triangle
    [FORM BTRE]                 -- BSP tree (server rebuilds this)
    [CHUNK BEDG]                -- Border edges (obsolete)
    [FORM PGRF]                 -- Path graph (v0005/v0006 only)
      FORM 0001
        CHUNK META              -- int32 graph type
        CHUNK PNOD              -- Path nodes (32 bytes each)
        CHUNK PEDG              -- Path edges (16 bytes each)
        CHUNK ECNT              -- Edge counts per node
        CHUNK ESTR              -- Edge start indices per node
```

**Version differences:**
- **v0003**: VERT and TRIS have no count prefix (count derived from chunk size). No BTRE/BEDG/PGRF.
- **v0005**: Same as v0003 layout but adds BTRE, BEDG, and PGRF sections.
- **v0006**: VERT and TRIS have an int32 LE count prefix before the data. Includes BTRE/BEDG/PGRF.

All payload data within chunks is **little-endian** (engine3 uses native `memcpy` on x86_64).

## Edge Color Coding

| Color | Type | Meaning |
|-------|------|---------|
| Green (#44FF88) | Connected (1) | Walkable edge between triangles |
| Red (#FF4444) | Uncrossable (0) | Wall - cannot pass through |
| Yellow (#FFAA44) | Blocking (2) | Blocks movement |
| Blue (#4488FF) | Portal | Connects to another cell via portal |

## Path Node Types

| Type | Name | Description |
|------|------|-------------|
| 0 | CellPortal | Portal connecting to another cell |
| 1 | CellWaypoint | Navigation waypoint inside a cell |
| 2 | CellPOI | Point of interest in a cell |
| 3 | BuildingEntrance | Entrance from outside |
| 4 | BuildingCell | Building cell node |
| 5 | BuildingPortal | Portal within a building |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| F | Fit view to show all geometry |
| G | Toggle grid |
| P | Toggle path graph overlay |
| E | Cycle edge display mode (all / walls only / portals only) |

## Why a self-contained parser?

The `@swgemu/core` library includes a `parseFLR()` function, but it has limitations:

- **No PGRF parsing**: Path graph data is skipped entirely
- **No v0003 support**: Only handles v0005/v0006 (expects count prefix always)
- **Incorrect int endianness**: Reads ints as big-endian (`getInt32(offset, false)`) but they should be little-endian. Floats are correctly read as LE. This may work by coincidence for small values but produces incorrect results for larger ints (negative neighbor indices, portal IDs, etc.)
- **No BTRE parsing**: Low priority since the server rebuilds the BSP tree

This extension uses its own self-contained IFF + FLR parser that correctly handles all three versions with proper little-endian reads throughout.
