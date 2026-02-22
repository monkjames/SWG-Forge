# Building NPC Planner - Quick Start

## Setup

1. **Reload VSCode** to activate the extension:
   - `Ctrl+Shift+P` → `Developer: Reload Window`

2. **Place POB files** in `tre/working/object/building/`:
   ```bash
   # Example: Copy from reference
   cp scripts/imported_files/buildings/appearance/*.pob tre/working/object/building/general/
   ```

## Using the Tool

### Step 1: Open the Planner

- `Ctrl+Shift+P`
- Type: `SWG: Plan NPC Spawns`
- Panel opens in editor

### Step 2: Load a Building

- Select POB file from dropdown
- Cell list appears (e.g., "Cell 0: r0", "Cell 1: r1_hall", etc.)

### Step 3: Name Your Screenplay

- Enter name in text box (e.g., `krayt_graveyard_cave`)
- This will be the filename: `custom_scripts/screenplays/caves/krayt_graveyard_cave.lua`

### Step 4: Place NPCs

**For each cell:**

1. Click cell from list (e.g., "Cell 1: r1_hall")
2. Canvas appears showing 2D top-down view
3. Configure spawn settings:
   - **Template**: Mobile template name (e.g., `giant_canyon_krayt_dragon`)
   - **Heading**: Direction NPC faces (-180 to 180 degrees)
   - **Tier**: Difficulty (1=easiest, 5=hardest)
4. **Click on canvas** to place spawn point
5. Repeat to add more spawns in this cell
6. Click another cell to place spawns there

**Canvas Legend:**
- Gray grid = 40x40 meter cell bounds
- Colored dots = spawn points (color = tier)
- Center = (0, 0) world coordinates

**Spawn List:**
- Shows all spawns in selected cell
- "Delete" button to remove spawn
- Tier badge shows difficulty at a glance

### Step 5: Add Patrol Paths (Optional)

1. Click **Path Mode** button above the canvas
2. Click **+ New Path** to create a patrol route
3. Click on the canvas to add waypoints (numbered diamond markers)
4. Set path mode (Loop / Ping-Pong) and wait time in the path list
5. Switch back to **Spawn Mode**
6. Use the patrol dropdown on each spawn to assign a path
7. NPCs with paths will walk the route in-game

### Step 6: Export

- Click **"Export Screenplay"** button
- File created at `custom_scripts/screenplays/caves/{your_name}.lua`
- Automatically opens in editor

## Generated Code Structure

```lua
krayt_graveyard_cave = ScreenPlay:new {
    spawnPoints = {
        -- Cell name (Cell index)
        [1] = {
            {
                template = "giant_canyon_krayt_dragon",
                x = 12.50,
                z = 0.00,
                y = 5.30,
                heading = 90,
                cellIndex = 1,
                tier = 5,
            },
        },
    },
}

registerScreenPlay("krayt_graveyard_cave", true)

function krayt_graveyard_cave:start()
    -- Zone check
    self:spawnMobiles()
end

function krayt_graveyard_cave:spawnMobiles()
    -- Spawns all NPCs in all cells
    -- Sets up creatureKilled observers
end

function krayt_graveyard_cave:notifyMobileDead(pMobile, pKiller)
    -- Triggered when NPC dies
    -- Creates 5-minute respawn timer
    return 0
end

function krayt_graveyard_cave:respawnMobile(pSceneObject, args)
    -- Respawns NPC at original position
    -- Re-attaches observer
    return 0
end
```

## Next Steps After Export

1. **Set building ID** in your screenplay:
   ```lua
   krayt_graveyard_cave = ScreenPlay:new {
       buildingId = 123456789,  -- Add this line
       spawnPoints = { ... },
   }
   ```

2. **Register in screenplay manager** (if needed)

3. **Reload server** and test

## Tips

- **Start with entrance cells** (Cell 0 or Cell 1) - place Tier 1 mobs
- **Progress deeper** - increase tier as you go deeper into building
- **Test in-game** - respawn logic works automatically
- **Edit manually** if needed - the Lua is clean and easy to modify

## Troubleshooting

**"No POB files found"**
- Check that files are in `tre/working/object/building/`
- Files must have `.pob` or `.iff` extension

**"Failed to load POB file"**
- File may be corrupted or unsupported version
- Check console for error details

**Canvas not showing**
- Make sure you selected a cell from the list first
- Try reloading the panel

**Screenplay already exists**
- Tool will ask to overwrite
- Or rename your screenplay

## Example Workflow

```
1. Load: poi_all_impl_bunker_s02.pob
2. Name: "death_watch_bunker"
3. Cell 0 (r0 - exterior): Skip or add 1-2 Tier 1 guards
4. Cell 1 (r1_entry): 4x Tier 1 guards (entryway)
5. Cell 2 (r2_hall): 6x Tier 2 soldiers + patrol path along corridor
6. Cell 3 (r3_barracks): 8x Tier 3 veterans (barracks)
7. Cell 4 (r4_command): 2x Tier 4 elite + 1x Tier 5 boss
8. Path Mode: Create "hall_patrol" path in Cell 2 with 4 waypoints
9. Spawn Mode: Assign "hall_patrol" to 2 soldiers in Cell 2
10. Export → death_watch_bunker.lua
11. Add buildingId, reload server, test
```

## Keyboard Reference

| Action | Key |
|--------|-----|
| Open Planner | `Ctrl+Shift+P` → "SWG: Plan NPC Spawns" |
| Place Spawn | Left click on canvas (Spawn Mode) |
| Add Waypoint | Left click on canvas (Path Mode) |
| Remove Spawn/Waypoint | Right click on canvas |
| Export | Click "Export Screenplay" |

## File Locations

| Type | Path |
|------|------|
| POB Files | `tre/working/object/building/` |
| Output | `custom_scripts/screenplays/caves/{name}.lua` |
| Extension | `swg-forge/packages/building-npc-planner/` |
