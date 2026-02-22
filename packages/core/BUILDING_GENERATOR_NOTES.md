# Building Generator Notes

## What We're Building
Two merchant tent duplicates proving the full pipeline:
- **s01**: Straight dupe (same exterior + interior as vanilla tent)
- **s02**: Tent exterior + Tatooine house livingroom interior (cell swap)

## API Gotchas Found

### CRC Table API
- `addCRCEntries(table, paths)` mutates `table` in-place, returns array of added entries
- Must pass original `table` (not return value) to `serializeCRCTable()`

### STF API
- `addSTFEntries(stf, entries)` mutates `stf` in-place, returns count (number)
- `StringEntry` uses `id` field, not `key`: `{ id: 'mystring', value: 'My String' }`
- Must pass original `stf` (not return value) to `serializeSTF()`

### IFF Clone API
- **DO NOT USE** `cloneIFFWithReplacements()` - it does raw binary replacement which corrupts
  FORM sizes when replacement strings have different lengths. The `fixIFFSizes()` fallback
  can't recover because chunk boundaries are already shifted.
- **USE** `cloneIFFSafe()` (defined in `generate-building.js`) - parses IFF tree, replaces
  strings in individual chunk data buffers, then re-serializes with correct sizes.
- Replacement strings can include binary chars like `\x00\x01` for STF references
- STF format in IFF: `\x01\x01<file>\x00\x01<key>\x00` - replace the key portion

### POB Serializer
- `serializePOB()` always outputs v0004 regardless of input version
- Door hardpoint transform (48 bytes) is always written, even when flag is false (identity matrix)
- v0003 uses LE for all int32, v0004 uses BE

## Source Building Analysis

### Vanilla Merchant Tent Style 01
- Building IFF: `tre/vanilla/object/building/player/shared_player_merchant_tent_style_01.iff`
- POB: `appearance/ply_tato_merchant_tent_s01.pob` (referenced inside building IFF)
- Note: Style 01 references the Tato tent POB, not the Corellia one!
- STF keys: `@building_name:merchant_tent`, `@building_detail:merchant_tent`, `@building_lookat:merchant_tent`
- Footprint: `footprint/building/player/shared_merchant_tent.sfp`
- Deed IFF: `tre/vanilla/object/tangible/deed/player_house_deed/shared_merchant_tent_style_01_deed.iff`
- Deed STF: `@deed:merchant_tent`, `@deed_detail:merchant_tent`

### Building Lua Chain (vanilla)
- Shared: `scripts/object/building/player/objects.lua` (SharedBuildingObjectTemplate)
- Server: `scripts/object/building/player/player_merchant_tent_style_01.lua`
- Registration: `scripts/object/building/player/serverobjects.lua`

### Deed Lua Chain (vanilla)
- Shared: `scripts/object/tangible/deed/player_house_deed/objects.lua` (SharedTangibleObjectTemplate)
- Server: `scripts/object/tangible/deed/player_house_deed/merchant_tent_style_01_deed.lua`
- Registration: `scripts/object/tangible/deed/player_house_deed/serverobjects.lua`
- Key field: `generatedObjectTemplate = "object/building/player/player_merchant_tent_style_01.iff"`

### Custom Building Pattern (barn_house reference)
- All custom files in `custom_scripts/` directories
- Same structure as vanilla but uses `includeFile("../custom_scripts/...")` paths
- Building IFFs in `tre/infinity/object/building/player/`

## Donor Cell for s02

Tatooine Small House livingroom (cell 3 from `ply_tato_house_sm_s01_fp1.pob`):
- 1 portal (matches tent's single-entrance layout)
- 4 lights
- CMSH collision (has rawNode)
- Mesh: `appearance/mesh/ply_tato_house_sm_s01_fp1_r3_livingroom_mesh_r3.msh`
- Floor: `appearance/collision/ply_tato_house_sm_s01_fp1_r3_livingroom_collision_floor0.flr`

## File Generation Status - ALL COMPLETE

| Step | Status | Notes |
|------|--------|-------|
| POB s01 | Done | 1716 bytes, straight re-serialize of Corellia tent |
| POB s02 | Done | 1916 bytes, cell 1 swapped with tato livingroom (cell 3) |
| Building IFF s01 | Done | Points to `ply_inf_merchant_tent_s01.pob`, STF `inf_merchant_tent_s01` |
| Building IFF s02 | Done | Points to `ply_inf_merchant_tent_s02.pob`, STF `inf_merchant_tent_s02` |
| Deed IFF s01 | Done | STF `@deed:inf_merchant_tent_s01` |
| Deed IFF s02 | Done | STF `@deed:inf_merchant_tent_s02` |
| CRC Table | Done | 4 new entries (37651 total) |
| STF building_name | Done | 2 entries added |
| STF building_detail | Done | 2 entries added |
| STF deed/deed_detail | Skipped | Not in tre/working (vanilla only) |
| Lua Building s01 | Done | `custom_scripts/object/building/player/inf_merchant_tent_s01.lua` |
| Lua Building s02 | Done | `custom_scripts/object/building/player/inf_merchant_tent_s02.lua` |
| Lua Deed s01 | Done | `custom_scripts/object/tangible/deed/player_house_deed/inf_merchant_tent_s01_deed.lua` |
| Lua Deed s02 | Done | `custom_scripts/object/tangible/deed/player_house_deed/inf_merchant_tent_s02_deed.lua` |
| Lua objects.lua | Done | 2 SharedBuildingObjectTemplate + 2 SharedTangibleObjectTemplate |
| Lua serverobjects.lua | Done | 4 includeFile lines (2 buildings + 2 deeds) |

## Verification Results

### POB s01 (straight dupe)
- v0004, 1 portal, 2 cells
- Cell 0 (r0): Corellia tent exterior mesh + LOD
- Cell 1 (r1): Corellia tent interior mesh
- Identical structure to original

### POB s02 (cell swap)
- v0004, 1 portal, 2 cells
- Cell 0 (r0): Corellia tent exterior mesh (unchanged)
- Cell 1 (livingroom): Tatooine house livingroom mesh + floor + CMSH collision
- Portal geometry unchanged (tent doorway shape)

### Building IFF Strings Verified
- `portalLayoutFilename` → correct new POB paths
- `objectName` → `@building_name:inf_merchant_tent_s0X`
- `detailedDescription` → `@building_detail:inf_merchant_tent_s0X`
- `lookAtText` → `@building_lookat:inf_merchant_tent_s0X`
- `structureFootprintFileName` → reuses vanilla merchant tent footprint

## Bug Fix Log

### IFF Clone Corruption (Fixed)
- **Problem**: `cloneIFFWithReplacements()` does raw binary search-and-replace on the entire
  IFF buffer. When replacement strings are longer/shorter than originals, the byte offsets of
  all subsequent FORM/chunk headers shift, but the FORM size fields still point to old
  positions. Result: FORM sizes become garbage (e.g., 1.9 billion bytes instead of ~1600).
  The built-in `fixIFFSizes()` can't fix this because chunk boundaries are already corrupted.
- **Symptoms**: User reported "most files do not work in the native app, it crashes"
- **Solution**: Wrote `cloneIFFSafe()` that:
  1. Parses the IFF into a proper tree (FORM nodes + data chunks)
  2. Walks leaf chunks and replaces strings only in chunk data buffers
  3. Re-serializes the tree via `serializeIFF()` which calculates correct FORM sizes
- **Key insight**: String replacement must happen at the chunk level, not the whole-file level,
  so that FORM size recalculation works correctly on re-serialization.

## In-Game Testing Commands
```
/createitem object/tangible/deed/player_house_deed/shared_inf_merchant_tent_s01_deed.iff
/createitem object/tangible/deed/player_house_deed/shared_inf_merchant_tent_s02_deed.iff
```
