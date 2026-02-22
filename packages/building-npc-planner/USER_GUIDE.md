# Building NPC Planner - User Guide

## Overview

The Building NPC Planner is a visual tool for placing NPCs inside SWG buildings. It eliminates the tedious process of manually recording coordinates in-game and generates complete Lua screenplays with spawn logic.

## Features

✅ **POB File Browser** - Load building files from `tre/working/object/building/`
✅ **Cell Visualization** - See all cells (rooms) in the building
✅ **Interactive 2D Canvas** - Click to place NPCs on a grid
✅ **Tier System** - 5 difficulty tiers for progressive gameplay
✅ **Mobile Templates** - Configure which NPCs to spawn
✅ **Heading Control** - Set spawn facing direction
✅ **Patrol Paths** - Define waypoint routes for NPC patrol movement
✅ **Auto-Generate Screenplays** - Export complete Lua files with respawn and patrol logic
✅ **5-Minute Respawns** - Automatic creatureKilled observers

## Quick Start

### 1. Open the Planner

`Ctrl+Shift+P` → `SWG: Plan NPC Spawns`

### 2. Load a POB File

Select a building from the dropdown, for example:
- `poi_all_impl_bunker_s02.pob` - 11 cells (good for testing)
- `poi_all_impl_bunker_warren_s01.pob` - 88 cells (massive dungeon)
- `ply_all_bespin_house.pob` - 3 cells (small player house)

### 3. Name Your Screenplay

Enter a screenplay name (e.g., `my_cave_dungeon`)

This will create: `custom_scripts/screenplays/caves/my_cave_dungeon.lua`

### 4. Place NPCs

1. **Click a cell** from the list (e.g., "Cell 1: entry")
2. **Configure spawn settings:**
   - Mobile Template: `stormtrooper`
   - Heading: `0` (north)
   - Tier: `1` (easiest)
3. **Click the canvas** to place spawn points
4. **Repeat** for different cells and tiers

### 5. Create Patrol Paths (Optional)

Toggle to **Path Mode** to define movement routes for NPCs:

1. Click the **Path Mode** button above the canvas
2. Click **+ New Path** to create a new patrol route
3. Click on the canvas to add waypoints (numbered diamonds connected by dashed lines)
4. Configure path properties:
   - **Name** - descriptive label (e.g., `hallway_patrol`)
   - **Mode** - `Loop` (A→B→C→A→...) or `Ping-Pong` (A→B→C→B→A→...)
   - **Wait(s)** - seconds to pause at each waypoint (0 = no pause)
5. Switch back to **Spawn Mode** and assign patrol paths to spawns using the dropdown in the spawn list
6. Multiple spawns can share the same patrol path

### 6. Export Screenplay

Click **Export Screenplay** - the file will be created and opened automatically

## Understanding Cells

Buildings in SWG are divided into **cells** (rooms):

- **Cell 0** - Always the exterior
- **Cell 1+** - Interior rooms

Each cell has:
- **Name** - e.g., "entry", "hall1", "bunker"
- **Portals** - Doorways connecting to other cells
- **Bounds** - The navigable area (currently 40x40 default)

## Canvas Controls

### Coordinate System

- **Center (0, 0)** - Middle of the cell
- **X-axis** - Left/right
- **Y-axis** - Forward/back
- **Z-axis** - Up/down (always 0 for floor placement)

### Clicking

- **Left click** (Spawn Mode) - Place spawn point at click position
- **Left click** (Path Mode) - Add waypoint to active patrol path
- **Right click** - Remove spawn point or waypoint under cursor
- Canvas shows a 40x40 meter grid
- Each grid square = 4 meters

## Tier System

Tiers control difficulty progression:

| Tier | Color | Difficulty | Typical Use |
|------|-------|------------|-------------|
| 1 | Gray | Easiest | Entrance guards |
| 2 | Yellow | Easy | Outer rooms |
| 3 | Orange | Medium | Mid-level areas |
| 4 | Red | Hard | Deep rooms |
| 5 | Dark Red | Hardest | Boss room |

**Tip:** Place lower tiers near entrance, higher tiers deeper in the building.

## Mobile Templates

Common templates you can use:

### Stormtroopers
- `stormtrooper`
- `stormtrooper_squad_leader`
- `stormtrooper_commando`
- `dark_trooper`

### Black Sun
- `blacksun_guard`
- `blacksun_assassin`
- `blacksun_ace`

### Death Watch
- `death_watch_wraith`
- `death_watch_ghost`
- `death_watch_battle_droid`

### Creatures
- `tusken_raider`
- `tusken_chief`
- `rancor`
- `krayt_dragon`

**Tip:** Use consistent faction templates within a building for coherent gameplay.

## Generated Screenplay Structure

```lua
-- Generated screenplay structure:

my_cave_dungeon = ScreenPlay:new {
    spawnPoints = {
        [1] = {  -- Cell index
            {
                template = "stormtrooper",
                x = 5.20,
                z = 0.00,
                y = 3.40,
                heading = 90,
                cellIndex = 1,
                tier = 1,
            },
            -- more spawns...
        },
    },
}

-- Auto-generated functions:
-- start()
-- spawnMobiles()        -- spawns all NPCs, sets up patrols
-- notifyMobileDead()    -- respawn handler
-- respawnMobile()       -- 5-minute respawn with patrol restore
-- setupPatrol()         -- initializes patrol on a mobile (if paths defined)
-- doPatrolStep()        -- moves mobile to next waypoint
-- onPatrolCombat()      -- handles combat interruption
-- onPatrolCombatEnd()   -- resumes patrol after combat
```

### Patrol Paths in Generated Code

When paths are assigned to spawns, the generated screenplay includes:

```lua
patrolPaths = {
    [1] = {  -- cell index
        ["hallway_loop"] = {
            mode = "loop",
            waypoints = {
                {x = -5.00, z = 0.00, y = 3.00, waitTime = 2},
                {x = 5.00,  z = 0.00, y = 3.00, waitTime = 0},
            },
        },
    },
},
```

Patrol movement uses `AiAgent:setNextPosition()` and `walkPatrol` AI template.
Patrols automatically resume after combat and survive respawn.

## Respawn Logic

The generated screenplay includes:

1. **Observer** - Watches for NPC death
2. **Timer** - 5-minute (300 second) delay
3. **Respawn** - Spawns NPC at original position

All NPCs respawn at their original position with the same template and heading.

## Tips & Best Practices

### Planning Layout

1. **Start with entrance** - Cell 1, Tier 1
2. **Progress deeper** - Increase tier as players move through building
3. **Boss at end** - Highest tier in deepest cell
4. **Density** - 3-5 NPCs per small room, 8-12 for large areas

### Mobile Selection

- **Mix types** - Don't use only ranged or only melee
- **Squad leaders** - Add 1 leader per 4-5 guards
- **Elite enemies** - Use sparingly for difficulty spikes

### Coordinates

- **Avoid doorways** - NPCs shouldn't block portals
- **Wall spacing** - Keep 2-3 meters from walls
- **Patrol spacing** - Leave room for NPC movement along paths

### Patrol Paths

- **Hallway patrols** - Place waypoints along corridors for sentry behavior
- **Room patrols** - Create loops around room perimeters
- **Ping-pong** - Use for guards that pace back and forth
- **Wait times** - Add pauses at key positions (doorways, corners)
- **Shared paths** - Multiple guards can share one patrol route

### Testing

1. **Export screenplay**
2. **Reload server** - `/reloadLua` or restart
3. **Teleport in-game** - `/teleport building_id`
4. **Check spawns** - Look for NPCs in each cell
5. **Adjust** - Modify and re-export as needed

## Troubleshooting

### POB won't load

- **Check path** - Ensure file is in `tre/working/object/building/`
- **Check format** - Only `.pob` or `.iff` files work
- **Console errors** - Open Dev Tools (`Help` → `Toggle Developer Tools`)

### Canvas not showing

- **Reload window** - `Ctrl+Shift+P` → `Developer: Reload Window`
- **Check cell selection** - Click a cell from the list first

### NPCs not spawning in-game

- **Building ID** - Update `self.buildingId` in screenplay
- **Zone** - Update zone name in `spawnMobile()` calls
- **Reload Lua** - Use `/reloadLua` in-game

### Wrong coordinates

- **Canvas is 2D** - Vertical (Z-axis) is always 0
- **Cell bounds** - Currently assumes 40x40, may need adjustment for large cells

## Advanced Usage

### Custom Respawn Times

Edit the generated screenplay:

```lua
-- Change 300000 (5 minutes) to desired milliseconds
createTimedEvent(600000, ...)  -- 10 minutes
```

### Different Mobiles Per Tier

Organize templates by tier in your screenplay:

```lua
local tierTemplates = {
    [1] = "stormtrooper",
    [2] = "stormtrooper_squad_leader",
    [3] = "stormtrooper_commando",
    -- etc
}
```

### Multi-Building Projects

Generate separate screenplays for each building:
- `my_cave_level1.lua`
- `my_cave_level2.lua`
- `my_cave_boss.lua`

### Batch Spawn Generation

For repetitive patterns (e.g., 4 corners of a room):

```lua
local corners = {
    {x = -10, y = -10},
    {x = 10, y = -10},
    {x = 10, y = 10},
    {x = -10, y = 10},
}
-- Spawn NPCs at each corner
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Shift+P` → `SWG: Plan NPC Spawns` | Open planner |
| Click cell | Select cell for editing |
| Left click canvas (Spawn Mode) | Place spawn point |
| Left click canvas (Path Mode) | Add waypoint to active path |
| Right click canvas | Remove spawn/waypoint under cursor |

## File Locations

### Input
- POB files: `tre/working/object/building/**/*.pob`

### Output
- Screenplays: `custom_scripts/screenplays/caves/{name}.lua`

### Config
- Settings: `.vscode/settings.json`

## Examples

### Example 1: Small Bunker (10 cells)

**POB:** `poi_all_impl_bunker_s02.pob`
**Screenplay:** `test_bunker`

- Cell 0 (exterior): 0 spawns (outside)
- Cell 1 (entry): 4 × Tier 1 stormtroopers
- Cells 2-5 (halls): 2-3 × Tier 2 squad leaders per cell
- Cells 6-9 (rooms): 3-4 × Tier 3 commandos per cell
- Cell 10 (bunker): 1 × Tier 5 dark_trooper (boss)

**Total:** ~25 NPCs

### Example 2: Massive Warren (88 cells)

**POB:** `poi_all_impl_bunker_warren_s01.pob`
**Screenplay:** `krayt_graveyard`

Progressive density:
- Cells 1-20: Tier 1-2, 3 NPCs/cell = 60 NPCs
- Cells 21-60: Tier 2-3, 4 NPCs/cell = 160 NPCs
- Cells 61-87: Tier 3-4, 5 NPCs/cell = 135 NPCs
- Cell 88 (final): Tier 5, 1 boss + 4 elites = 5 NPCs

**Total:** ~360 NPCs

## Support

- Report issues: [SWG Forge GitHub Issues](https://github.com/monkjames/SWG-Forge/issues)
- Ask questions: Add comments to generated screenplays with `-- TODO` for Claude AI assistance

## Version History

- **1.1.0** - Patrol Paths
  - Spawn Mode / Path Mode toggle
  - Visual waypoint drawing on 2D canvas (diamond markers with numbered labels)
  - Loop and Ping-Pong patrol modes
  - Configurable wait times at waypoints
  - Patrol path assignment dropdown on each spawn point
  - Generated Lua includes full patrol system (walkPatrol AI, combat handling, respawn restore)
- **1.0.0** - Initial release
  - POB file browser
  - Interactive 2D canvas
  - 5-tier system
  - Lua screenplay export
  - 26 POB files tested and validated
