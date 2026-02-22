# Building NPC Planner

Visual tool for planning NPC spawns inside SWG buildings. No more walking around in-game with a notepad!

## Features

- **Load POB files** from `tre/working/object/building/`
- **Visual cell browser** - see all cells in the building with connectivity
- **Interactive 2D canvas** - click to place spawn points
- **Configure spawns** - mobile template, heading, difficulty tier
- **Patrol paths** - define waypoint routes for creatures to walk
- **Auto-generate screenplay** - complete Lua screenplay with respawn and patrol logic

## Usage

1. **Open the planner:**
   - Command Palette (`Ctrl+Shift+P`)
   - Type: `SWG: Plan NPC Spawns`

2. **Load a POB file:**
   - Select a building from the dropdown (scans `tre/working/object/building/`)
   - Cells will appear in the list

3. **Set screenplay name:**
   - Enter a name (e.g., `my_cave_dungeon`)
   - Must be unique (checks `custom_scripts/screenplays/caves/`)

4. **Place NPCs (Spawn Mode):**
   - Click a cell from the list
   - Interactive 2D canvas appears
   - Set mobile template (e.g., `stormtrooper`)
   - Set heading (-180 to 180)
   - Set tier (1-5 for difficulty progression)
   - Click on canvas to place spawn point
   - Repeat for all cells

5. **Create patrol paths (Path Mode):**
   - Toggle to **Path Mode** using the button above the canvas
   - Click **+ New Path** to create a patrol route
   - Click on the canvas to add waypoints (shown as numbered diamonds)
   - Set path mode (Loop or Ping-Pong) and wait time
   - Toggle back to **Spawn Mode** and assign paths to spawns via the dropdown
   - Creatures with assigned paths will walk the route in-game

6. **Export screenplay:**
   - Click "Export Screenplay"
   - File created at `custom_scripts/screenplays/caves/{name}.lua`
   - Automatically opens in editor

## Generated Screenplay Structure

```lua
my_cave_dungeon = ScreenPlay:new {
    spawnPoints = {
        [0] = {
            {
                template = "stormtrooper",
                x = 12.50, z = 0.00, y = 5.30,
                heading = 90, cellIndex = 0, tier = 1,
                patrolPath = "hallway_loop",  -- optional: assigned patrol
            },
        },
    },
    patrolPaths = {  -- only present if paths are defined
        [0] = {
            ["hallway_loop"] = {
                mode = "loop",  -- or "pingpong"
                waypoints = {
                    {x = -5.00, z = 0.00, y = 3.00, waitTime = 2},
                    {x = 5.00,  z = 0.00, y = 3.00, waitTime = 0},
                },
            },
        },
    },
}

-- Auto-generated functions:
-- spawnMobiles() with patrol setup
-- setupPatrol() / doPatrolStep() for waypoint movement
-- 5-minute respawn timers with patrol restoration
-- Combat interruption handling
```

## Keyboard Shortcuts

- **Left Click** (Spawn Mode) - Place spawn point
- **Left Click** (Path Mode) - Add waypoint to active path
- **Right Click** - Remove spawn point or waypoint under cursor
- **Canvas coordinates** - Converts screen click to in-game world coordinates automatically

## Tier System

The tool supports 5 tiers for difficulty progression:

- **Tier 1** - Gray badge - Entrance mobs (easiest)
- **Tier 2** - Yellow badge - Early rooms
- **Tier 3** - Orange badge - Mid-level
- **Tier 4** - Red badge - Deep rooms
- **Tier 5** - Dark red badge - Boss area (hardest)

## Technical Details

### POB Parser

The extension includes a full POB (Portalized Object) parser written in TypeScript:

- Reads cell structure, portals, collision bounds
- Extracts connectivity graph
- Supports POB versions 0003 and 0004

### Coordinate System

- **Canvas**: 600x600 pixels with 50px margins, 10x10 grid
- **World**: Converts canvas clicks to in-game coordinates (X, Z, Y)
- **Z-axis**: Currently defaults to 0 (floor level)

### Respawn Logic

Generated screenplays use:
- `OBJECTDESTRUCTION` observer on each mobile
- 5-minute (300000ms) respawn timer
- Position/heading preserved across respawns
- Cell-based spawning (works with POBs)

### Patrol System

When patrol paths are defined, the generated screenplay includes:
- `setAiTemplate("walkPatrol")` + `setNextPosition()` for waypoint movement
- Loop mode (A→B→C→A) or ping-pong mode (A→B→C→B→A)
- Configurable wait time at each waypoint
- Combat interruption: patrols resume after combat ends
- Patrol assignments survive respawn

## Future Enhancements

- [x] ~~Support for patrol routes (path graphs)~~ - Added in 1.1.0
- [ ] Cross-cell patrol paths (paths that go through portals)
- [ ] 3D height (Z-axis) adjustment per spawn point
- [ ] Drag-and-drop spawn points/waypoints to reposition
- [ ] Import existing screenplay spawn arrays
- [ ] Export to JSON for AI-assisted screenplay generation
- [ ] Configurable respawn timers per spawn

## File Structure

```
building-npc-planner/
├── src/
│   ├── extension.ts        # VSCode extension entry
│   ├── npcPlannerPanel.ts  # Webview panel + POB parser
└── package.json
```

## Dependencies

- `@swgemu/core` - IFF parser, POB format support
- `vscode` - VSCode extension API

## Configuration

Uses standard SWG Forge config:

```json
{
    "swgForge.tre.workingPath": "tre/working",
    "swgForge.serverScriptsPath": "infinity4.0.0/MMOCoreORB/bin/scripts",
    "swgForge.customScriptsFolder": "custom_scripts"
}
```

## Credits

- POB format documentation: NoStyleGuy's Blender plugin
- POB reference: `scripts/imported_files/buildings/blender POB plugin/`
