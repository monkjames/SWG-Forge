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

---

## Feb 26, 2026 — Brainstorm

Ideas for where SWG Forge could go next. Nothing committed — just thinking out loud.

### Lua Development Tools

The biggest gap right now. We have great binary editors but Lua authoring is still raw text.

- **Lua Intellisense for SWGEmu** — Autocomplete for `SceneObject`, `CreatureObject`, `BuildingObject` methods. Parse the C++ Lua bindings to generate type stubs automatically. Would massively speed up screenplay writing.
- **Template Cross-Reference Viewer** — Given any object (IFF path, Lua template, or CRC), show everything that references it: loot groups, spawn lists, schematic ingredients, screenplay spawns, quest rewards. Answer "where is this thing used?" in one click.
- **Screenplay Validator** — Static analysis for common Lua mistakes: missing `registerScreenPlay`, observers that never get removed, `createLoot` calls referencing non-existent loot groups, spawn templates that don't exist in serverobjects.lua.
- **Loot Table Editor** — Visual tree editor for loot groups/items. Currently these are deeply nested Lua tables that are painful to navigate. Show drop rates, item previews, group hierarchies. Drag-and-drop to reorganize.

### Integrity & Validation

Catch problems before they hit the server.

- **CRC Conflict Detector** — Scan the CRC table for hash collisions (different paths, same CRC). Also flag IFF files that exist on disk but aren't in the CRC table, and CRC entries pointing to missing files.
- **Orphan File Finder** — Find IFFs not registered in any CRC table, Lua templates not included in any `serverobjects.lua`, STF keys that nothing references, appearance chains with broken links.
- **Template Field Validator** — Check that Lua object templates have all required fields for their type. A `SharedWeaponObjectTemplate` without `attackType` silently breaks — catch that at edit time.
- **Pre-Flight Check** — One-click "is my workspace clean?" that runs all validators. Show a report before you restart the server.

### World & Spawn Management

Tools for placing things in the world, not just inside buildings.

- **World Map Spawn Viewer** — 2D planet map with spawn regions overlaid. Show creature density, faction territories, POI markers. Click a region to see what spawns there and edit spawn groups.
- **Region Editor** — Visual editing of no-build zones, city boundaries, GCW regions. Currently these are coordinate lists in Lua — a map overlay would be much clearer.
- **Outdoor NPC Planner** — Like Building NPC Planner but for open-world areas. Place spawns on a terrain heightmap, define patrol waypoints, set wander radii. Export to spawn manager Lua.
- **Point of Interest (POI) Designer** — Define a POI area with spawns, loot containers, ambient NPCs, and boss encounters. Package it as a reusable screenplay that can be dropped at any world coordinates.

### 3D Visualization

The big leap. Currently everything is 2D schematics.

- **Mesh Viewer** — WebGL viewer for MSH/MGN files inside VSCode. Even basic wireframe + texture would be valuable for verifying appearance chains without launching the client.
- **POB Walkthrough** — 3D view of building interiors with cell connectivity. Walk through portals, see NPC placements from the Building NPC Planner in 3D context.
- **Appearance Chain Preview** — In the object creation pipeline, show a 3D preview of what the object will look like before generating files. Would need MSH parsing + DDS texture mapping.

### Content Pipeline Automation

Reduce repetitive multi-step workflows to single operations.

- **Batch Object Creator** — Create multiple variants of an object at once (e.g., 5 color variants of a piece of armor). Define a template + variation table, generate all TRE + Lua + CRC + STF in one pass.
- **Loot Group Generator** — Given a set of items, auto-generate balanced loot groups with configurable drop rates. Wire them into existing loot tables or create new ones.
- **Schematic Balancer** — Given a crafted item's stats, suggest ingredient types and quantities that make sense for the game's crafting economy. Reference existing schematics for baseline.
- **Reverse Engineer from CRC** — Paste a CRC hex value, instantly find the object template path, its appearance chain, its Lua template, where it's used in loot/spawns/quests. Quick debugging tool.

### Quest & Screenplay Authoring

Visual tools for quest design instead of raw Lua.

- **Quest Flow Editor** — Node-based visual editor for quest logic. Define stages, branching conditions, rewards, failure states. Export to screenplay Lua with proper state machine patterns.
- **Conversation Tree Editor** — Visual editor for NPC conversation trees (ConversationScreen chains). Currently these are verbose Lua tables — a tree visualization with inline text editing would be much faster.
- **Event Sequencer** — Timeline-based editor for scripted events (invasions, world bosses, seasonal events). Define spawn waves, timings, broadcast messages, reward phases. Export to screenplay.

### Developer Experience

Small tools that smooth out daily workflow.

- **Object Browser** — Universal search across all object types. Type a name, see matching IFFs, Lua templates, CRC entries, STF strings, appearance files. One search bar to find anything.
- **TRE Diff Viewer** — Compare `tre/working/` against `tre/vanilla/` or `tre/infinity/`. Show what's been added, modified, removed. Useful before packaging a TRE update.
- **Server Log Viewer** — Tail and filter Core3 server logs inside VSCode. Highlight errors, link stack traces to source files, filter by system (combat, crafting, housing, space).
- **Quick Spawn Command** — Right-click any creature/object template → copy the `/createcreature` or `/createitem` command to clipboard. Small but saves constant lookups.

### Data Analysis & Balance

Tools for understanding and tuning game systems.

- **Combat Simulator** — Input attacker/defender stats, run combat math (from C++ formulas), show DPS, time-to-kill, mitigation breakdown. For balancing encounters without live testing.
- **Economy Analyzer** — Map crafting chains: raw resources → components → final items. Show resource bottlenecks, compare schematic costs, identify balance outliers.
- **Creature Stat Browser** — Searchable/sortable table of all creatures with their stats, loot, spawn locations. Quick reference for content design.
