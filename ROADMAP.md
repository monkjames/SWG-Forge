# SWG Forge Roadmap

## 1. Object Creator

End-to-end object creation workflow that handles both TRE and Lua sides in one pass.

### 1a. Craftable Object (Full Pipeline)

Create a new craftable object from scratch. This touches a lot of files:

**TRE side:**
- Tangible object IFF (shared template)
- Draft schematic IFF
- Loot schematic IFF
- CRC table registration (all new IFFs)
- STF string entries (name, description, ingredient names)

**Lua side:**
- Object template (tangible)
- Draft schematic template
- Loot schematic template
- Registration in serverobjects.lua / objects.lua
- Add to crafting manager (schematic group assignment)
- Loot item + loot group for the loot schematic

*Lots more to unpack here — this is a stub to talk through.*

### 1b. Duplicate Existing Object (No Crafting)

Take an existing object and duplicate it — new IFFs, new CRC entries, new STF strings, new Lua templates. Skip the crafting/schematic pipeline entirely.

### 1c. Object from Existing Appearance ← START HERE

Starting point: you already have the full appearance chain (APT down to DDS). You just need the object wrapper around it. This is the foundation that 1b, 1d, and 1e build on.

**UI Flow:**
1. List `.apt` files from `tre/working/appearance/`
2. User picks one
3. User picks a target folder (e.g., `object/tangible/item/quest/`)
4. Tool finds a reference object in that folder (working → infinity → vanilla) to clone
5. User enters: object name, display name, description
6. Optional: add menu component stub (checkbox)
7. Preview all files to be created/modified — confirm or go back
8. Generate everything

**TRE side (all in tre/working/):**
- Object IFF — clone reference, swap appearance path + string references
- CRC table — add entry (create in working if missing, pull from infinity first)
- STF strings — `string/en/custom_content/{path_snake}_n.stf` and `_d.stf` (e.g., `item_quest_n.stf`). If lookAtText exists in reference IFF, repeat display name there. Check working first, pull from infinity if needed.

**Lua side (all in custom_scripts/):**
- Object template — clone reference `.lua`, swap template path
- `serverobjects.lua` — includeFile for the new .lua
- `objects.lua` — shared_ template path linking TRE to Lua
- Full directory chain — create serverobjects.lua / objects.lua at every level up if the folder is new

**Validations:**
- Name collision check (CRC, STF, Lua) before writing
- Reference object must exist in target folder

### 1d. Clothing Maker ✅ COMPLETE (Enhancements Pending)

Same as 1c (Object from Existing Appearance) but for wearables. Adds ACM (Asset Customization Manager) entries so the item supports palette-based color customization in the client.

**Core features (implemented):**
- Looted or Crafted mode (with full schematic chain)
- 10 clothing types with intelligent defaults (boots, gloves, pants, etc.)
- Draft schematic generation (ingredients, experimentation, customization)
- Loot schematic generation (recipe unlock items)
- Color customization slots (single or dual palette)
- Stats configuration (sockets, hitpoints)

**Enhancements to add:**
- [ ] **ACM Palette Browser Integration** — Visual palette picker instead of manual palette paths
- [ ] **Armor Stat Templates** — Load protection values for combat-capable clothing
- [ ] **Preview Step** — Show all files to be created/modified before generation
- [ ] **Loot Group Generation** — Auto-create loot groups for the loot schematic item

### 1e. Armor Forge (Rewrite)

Rewrite the existing Armor Forge on top of the Clothing Maker (1d). Armor is clothing plus armor-specific stats, special protection slots, and crafting integration. The current Armor Forge was built standalone — rebuilding it on the shared object creation pipeline means less duplicated logic and a consistent workflow.

### 1*. Menu Component Stub (Applies to All Above)

Optional checkbox in any object creation flow. Generates the scaffolding for a radial menu on the object.

**Generates:**
- `custom_scripts/tangible/{path}/menu_{objectname}.lua` — stub with `fillObjectMenuResponse()` and `handleObjectMenuSelect()`, empty menu actions for manual implementation
- Adds `menuComponent = "custom_scripts/tangible/{path}/menu_{objectname}"` to the object's Lua template

**Note:** The menu component path must match the convention used in the object template. The stub provides the wiring — the user fills in the actual menu options and handlers.

---

## 2. Creature Duplicator

Duplicate an entire creature — all the way down to the DDS texture — so the copy can be recolored or reskinned.

**TRE side:**
- Duplicate appearance chain (APT/SAT, LOD/LMG, MSH/MGN, SHT, DDS)
- New tangible/creature IFFs pointing at the new appearance
- CRC table registration
- STF string entries
- ACM entries if customizable

**Lua side:**
- Mobile template
- Registration in serverobjects.lua / objects.lua
- Spawn references (if replacing an existing creature somewhere)

---

## 3. Building NPC Planner ✅ COMPLETE

Visual tool for placing NPCs inside buildings, replacing the current workflow of manually recording coordinates in-game.

### Current Pain

1. Go into building in-game
2. Walk around recording coordinates by hand
3. Manually type coordinate lists into a screenplay
4. Trial and error for spacing, difficulty progression, coverage

### Vision

Given a building template (POB IFF from TRE), produce a visual cell-by-cell planning view:

- Parse the POB to extract all cells, their names, and connectivity
- Display cells as a chain/graph showing the building layout
- For each cell, provide tools to place NPCs at positions within the cell bounds
- Show difficulty progression across the cell chain (front door to back room)
- Allow assigning mobile templates to spawn points

**Output:** A planning document / data file that can be used (with AI or directly) to generate the screenplay Lua that spawns the NPCs at those positions.

### Implementation

**Core Library (`@swgemu/core`):**
- Complete POB parser ported from Python to TypeScript
- Parses PRTO (version 0003/0004) with cells, portals, collision, path graphs
- Extracts cell connectivity, names, appearance files

**VSCode Extension (`building-npc-planner`):**
- POB file browser (scans `tre/working/object/building/`)
- Cell list with selection
- Interactive 2D canvas (600x600, grid-based)
- Click-to-place spawn points with configuration:
  - Mobile template
  - Heading (-180 to 180)
  - Tier (1-5 for difficulty progression)
- Complete screenplay export to `custom_scripts/screenplays/caves/{name}.lua`
- Auto-generates spawn arrays, respawn logic (5-minute timers), creatureKilled observers

**Answered Questions:**
- ✅ Cell geometry: Using default 40x40 bounds (collision parsing can be enhanced later)
- ✅ Visual fidelity: 2D top-down grid view (sufficient for spawn placement)
- ✅ Output format: Direct Lua screenplay generation (no intermediate format needed)
