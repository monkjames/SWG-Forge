# Egg Maker - VSCode Extension Design

## Overview

A VSCode plugin that generates a complete incubator egg and all its associated files. The user picks an egg style (appearance), names it, defines creatures, and the plugin spits out every file needed — TRE client assets, Lua server templates, loot chain, and the incubator_data entry. All generated egg creatures are stored in a dedicated output folder for easy tracking and management.

## What Exists Today

The incubator system currently has **22 egg slots** (`inf_egg_01` through `inf_egg_22`), but only 7 are populated (1-5, 7, 21-22). Slots 8-20 are empty placeholders with `level = 0` and no creatures. The system is defined across ~8 file types:

| Layer | File | Purpose |
|-------|------|---------|
| **TRE** | `object/tangible/item/egg/shared_inf_egg_NN.iff` | Client-side egg object (appearance, name ref) |
| **TRE** | `draft_schematic/item/shared_egg_schem_NN.iff` | Client-side crafting schematic |
| **TRE** | `tangible/loot/loot_schematic/shared_egg_schematic_NN.iff` | Client-side loot schematic |
| **TRE** | `misc/object_template_crc_string_table.iff` | CRC registration for all 3 IFFs above |
| **TRE** | `string/en/*.stf` | Egg name, description, schematic names |
| **Lua** | `custom_scripts/object/tangible/item/egg/inf_egg_NN.lua` | Server egg template (experimental properties) |
| **Lua** | `custom_scripts/object/draft_schematic/item/egg_schem_NN.lua` | Draft schematic (ingredients, target) |
| **Lua** | `custom_scripts/object/tangible/loot/loot_schematic/egg_schematic_NN.lua` | Loot schematic (skill req, target draft) |
| **Lua** | `custom_scripts/loot/items/component/chemistry/egg_lootschem_NN.lua` | Loot item (points to loot schematic IFF) |
| **Lua** | `custom_scripts/loot/groups/component/eggs/egg_group_NN.lua` | Loot group (wraps loot item with weight) |
| **Lua** | `incubator_data.lua` | INCUBATOR_EGGS table entry (egg→creature mapping) |
| **Lua** | `objects.lua` / `serverobjects.lua` | Registration includes for egg templates |

## Existing File Patterns (Templates)

### Egg Item Lua (`inf_egg_NN.lua`)
```lua
object_tangible_item_egg_inf_egg_NN = object_tangible_item_egg_shared_inf_egg_NN:new {
    objectMenuComponent = "egg_Menu",
    numberExperimentalProperties = {1, 1, 4, 1},
    experimentalProperties = {"XX", "XX", "DR", "OQ", "MA", "SR", "XX"},
    experimentalWeights = {1, 1, 2, 2, 1, 1, 1},
    experimentalGroupTitles = {"null", "null", "exp_effectiveness", "null"},
    experimentalSubGroupTitles = {"null", "null", "energy", "hitpoints"},
    experimentalMin = {0, 0, 0, 1000},
    experimentalMax = {0, 0, 100, 1000},
    experimentalPrecision = {0, 0, 0, 0},
    experimentalCombineType = {0, 0, 1, 4},
}
ObjectTemplates:addTemplate(object_tangible_item_egg_inf_egg_NN, "object/tangible/item/egg/inf_egg_NN.iff")
```

### Draft Schematic Lua (`egg_schem_NN.lua`)
```lua
object_draft_schematic_item_egg_schem_NN = object_draft_schematic_item_shared_egg_schem_NN:new {
    templateType = DRAFTSCHEMATIC,
    customObjectName = "CREATURE_NAME Egg",
    craftingToolTab = 64,
    complexity = 1, size = 2,
    xpType = "crafting_bio_engineer_creature", xp = 228,
    factoryCrateSize = 0,
    assemblySkill = "bio_engineer_assembly",
    experimentingSkill = "bio_engineer_experimentation",
    customizationSkill = "bio_customization",
    customizationOptions = {}, customizationStringNames = {}, customizationDefaults = {},
    ingredientTemplateNames = {"art_n", "art_n", "art_n"},
    ingredientTitleNames = {"craft_shell", "craft_egg_mass", "craft_egg_embryo"},
    ingredientSlotType = {0, 0, 2},
    resourceTypes = {"meat_egg_PLANET", "bone_avian_PLANET", "object/tangible/.../shared_EMBRYO.iff"},
    resourceQuantities = {NN, NN, NN},
    contribution = {100, 100, 0},
    targetTemplate = "object/tangible/item/egg/inf_egg_NN.iff",
}
ObjectTemplates:addTemplate(object_draft_schematic_item_egg_schem_NN, "object/draft_schematic/item/egg_schem_NN.iff")
```

### Loot Schematic Lua (`egg_schematic_NN.lua`)
```lua
object_tangible_loot_loot_schematic_egg_schematic_NN = object_tangible_loot_loot_schematic_shared_egg_schematic_NN:new {
    templateType = LOOTSCHEMATIC,
    objectMenuComponent = "LootSchematicMenuComponent",
    attributeListComponent = "LootSchematicAttributeListComponent",
    requiredSkill = "outdoors_bio_engineer_creature_01",
    targetDraftSchematic = "object/draft_schematic/item/egg_schem_NN.iff",
    targetUseCount = 1,
}
ObjectTemplates:addTemplate(object_tangible_loot_loot_schematic_egg_schematic_NN, "object/tangible/loot/loot_schematic/egg_schematic_NN.iff")
```

### Loot Item Lua (`egg_lootschem_NN.lua`)
```lua
egg_lootschem_NN = {
    minimumLevel = 0, maximumLevel = -1,
    customObjectName = "",
    directObjectTemplate = "object/tangible/loot/loot_schematic/egg_schematic_NN.iff",
    craftingValues = {},
    customizationStringName = {}, customizationValues = {}
}
addLootItemTemplate("egg_lootschem_NN", egg_lootschem_NN)
```

### Loot Group Lua (`egg_group_NN.lua`)
```lua
egg_group_NN = {
    description = "", minimumLevel = 0, maximumLevel = -1,
    lootItems = {
        {itemTemplate = "egg_lootschem_NN", weight = 100 * (100000)}
    }
}
addLootGroupTemplate("egg_group_NN", egg_group_NN)
```

### `objects.lua` Registration
```lua
object_tangible_item_egg_shared_inf_egg_NN = SharedTangibleObjectTemplate:new {
    clientTemplateFileName = "object/tangible/item/egg/shared_inf_egg_NN.iff"
}
ObjectTemplates:addClientTemplate(object_tangible_item_egg_shared_inf_egg_NN, "object/tangible/item/egg/shared_inf_egg_NN.iff")
```

### `serverobjects.lua` Include
```lua
includeFile("../custom_scripts/object/tangible/item/egg/inf_egg_NN.lua")
```

### `incubator_data.lua` Entry
```lua
--[[ NN CREATURE_NAME ]]
{"object/tangible/item/egg/inf_egg_NN.iff", {
    {"Creature Display Name", "creature_mobile_name", 100},
}, LEVEL},
```

## Plugin Design

### User Inputs (Webview Form)

| Field | Type | Description |
|-------|------|-------------|
| **Egg Number** | Dropdown (8-20) | Which empty slot to fill, or "Next Available" |
| **Egg Name** | Text | Display name (e.g., "Corellian Critter Egg") |
| **Egg Style** | Dropdown + Preview | Which existing egg IFF to clone appearance from |
| **Planet** | Dropdown | Determines resource types (meat_egg_PLANET, bone_avian_PLANET) |
| **Pet Level** | Number (1-102) | Required tame level for hatching |
| **Embryo Item** | Text/Browse | The IFF path for the embryo crafting ingredient (slot 3) |
| **Resource Quantities** | 3x Number | Shell / Egg Mass / Embryo counts |
| **Creatures** | Creature List | Array of {display_name, mobile_name, weight} |

### Creature List Sub-Form

Each creature entry has:
- **Display Name**: Text input — what shows in-game (e.g., "Deaths Head Merek")
- **Mobile Name**: Text input — the server mobile template name (e.g., "merek_deaths_head")
- **Weight**: Number input — chance weight (1-100), same system as existing eggs

**v1**: Simple text fields for all three values. No validation against existing mobiles.

**Future**: Creature-feature integration — a browse/search button that opens the existing creature-feature browser from the monorepo to search/select mobile templates, preventing typos.

### Generated Output

Given inputs: `eggNum=23, name="Dathomir Horror Egg", planet=dathomir, level=90, creatures=[...]`

The plugin generates:

#### TRE Files (in `tre/working/`)
1. **`object/tangible/item/egg/shared_inf_egg_23.iff`** — Clone from selected egg style, update string refs
2. **`draft_schematic/item/shared_egg_schem_23.iff`** — Clone from existing egg schematic IFF
3. **`tangible/loot/loot_schematic/shared_egg_schematic_23.iff`** — Clone from existing loot schematic IFF
4. **CRC table update** — Add all 3 new IFF paths to `misc/object_template_crc_string_table.iff`
5. **STF string update** — Add egg name/description to appropriate string tables

#### Lua Files (in `infinity_jtl/MMOCoreORB/bin/scripts/custom_scripts/`)
6. **`object/tangible/item/egg/inf_egg_23.lua`** — Egg server template
7. **`object/draft_schematic/item/egg_schem_23.lua`** — Draft schematic with ingredients
8. **`object/tangible/loot/loot_schematic/egg_schematic_23.lua`** — Loot schematic
9. **`loot/items/component/chemistry/egg_lootschem_23.lua`** — Loot item
10. **`loot/groups/component/eggs/egg_group_23.lua`** — Loot group

#### Egg Maker Output Folder

All generated eggs are **also saved** to a dedicated tracking folder:

```
packages/egg-maker/eggs/
├── egg_23_dathomir_horror/
│   ├── egg.json              # Full config (inputs + generated paths) — reloadable
│   ├── inf_egg_23.lua        # Copy of generated egg template
│   ├── egg_schem_23.lua      # Copy of generated draft schematic
│   ├── egg_schematic_23.lua  # Copy of generated loot schematic
│   └── egg_lootschem_23.lua  # Copy of generated loot item
├── egg_24_kashyyyk_beast/
│   ├── egg.json
│   └── ...
└── index.json                # Master list of all generated eggs
```

The `egg.json` stores the complete input config so eggs can be:
- **Reviewed**: See exactly what was generated and when
- **Re-generated**: Load a previous egg config, tweak, regenerate
- **Shared**: Copy the folder to another developer's setup

The `index.json` tracks all generated eggs with their slot numbers, names, and status (generated/deployed).

#### Registration Updates (append to existing files)
11. **`object/tangible/item/egg/objects.lua`** — Add SharedTangibleObjectTemplate client registration
12. **`object/tangible/item/egg/serverobjects.lua`** — Add includeFile for new egg
13. **`incubator_data.lua`** — Add INCUBATOR_EGGS entry at slot NN
14. **Draft schematic `objects.lua` / `serverobjects.lua`** — Register draft schematic
15. **Loot schematic `objects.lua` / `serverobjects.lua`** — Register loot schematic
16. **Loot item `serverobjects.lua`** — Register loot item
17. **Loot group `serverobjects.lua`** — Register loot group

### Architecture

```
packages/egg-maker/
├── src/
│   ├── extension.ts          # Activate, register commands
│   ├── eggMakerPanel.ts      # Webview panel (form UI)
│   ├── eggGenerator.ts       # Core generation logic
│   ├── templates/
│   │   ├── luaTemplates.ts   # String templates for all Lua files
│   │   └── iffCloner.ts      # Clone + modify IFF binary files
│   ├── registrations.ts      # Append to objects.lua, serverobjects.lua, incubator_data.lua
│   └── crcUpdater.ts         # Update CRC string table
├── package.json
└── tsconfig.json
```

### Dependencies on Existing `@swgemu/core`

- **IFF parser/serializer** — Clone egg IFF, draft schematic IFF, loot schematic IFF
- **CRC functions** — Calculate CRC-32 for new template paths
- **STF editor** — Add string entries for egg names
- **CRC table editor** — Register new IFF paths

### Webview Flow

```
┌──────────────────────────────────────────────────┐
│  EGG MAKER                                       │
├──────────────────────────────────────────────────┤
│                                                  │
│  Egg Number:  [Next Available ▼]                 │
│  Egg Name:    [Dathomir Horror Egg         ]     │
│  Egg Style:   [Peko Peko Style ▼] [Preview]      │
│  Planet:      [Dathomir ▼]                       │
│  Pet Level:   [90    ]                           │
│                                                  │
│  ─── Crafting Ingredients ───                    │
│  Shell Resource:   meat_egg_dathomir    [36]     │
│  Egg Mass:         bone_avian_dathomir  [44]     │
│  Embryo Item:      [Browse...         ] [ 4]     │
│                                                  │
│  ─── Creatures ───                               │
│  ┌─────────────────────┬──────────────┬────┐     │
│  │ Display Name        │ Mobile       │ Wt │     │
│  ├─────────────────────┼──────────────┼────┤     │
│  │ [Rancor Matriarch ] │ [rancor_m..] │[ 5]│     │
│  │ [Nightsister Razo ] │ [razor_ba..] │[30]│     │
│  │ [Malkloc Bull     ] │ [malkloc_..] │[65]│     │
│  │ [Purbole Stalker  ] │ [purbole_..] │[99]│     │
│  └─────────────────────┴──────────────┴────┘     │
│  [+ Add Creature]  [Remove Selected]             │
│                                                  │
│  ─── Preview ───                                 │
│  Files to generate: 11 new, 6 updates            │
│  [▶ Generate All]  [Preview Files...]            │
│                                                  │
└──────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Slot management**: Auto-detect next available slot by parsing `incubator_data.lua` for entries with `level = 0` and empty creature lists. Allow override.

2. **IFF cloning**: Use `@swgemu/core` IFF parser to clone an existing egg IFF (e.g., `shared_inf_egg_01.iff`), replacing only the string references (name/description). The appearance/mesh stays identical — just a different "style" of egg look.

3. **Planet-based resources**: The planet dropdown auto-fills the resource types (`meat_egg_PLANET`, `bone_avian_PLANET`). These are the standard SWG resource class names.

4. **Creature input (v1)**: Simple text fields for display name, mobile name, and weight. No mobile validation. Creature-feature browser integration is a future enhancement.

5. **Embryo flexibility**: Slot 3 (embryo) varies wildly between existing eggs — peko_head, infection_amplifier_donkuwah, palm_frond, etc. This is a free-form IFF path with a browse button.

6. **Preview before write**: Show a complete list of files that will be created/modified with diffs before committing. This is critical since it touches ~17 files.

7. **Numbering convention**: Egg numbers beyond 22 would require extending `INCUBATOR_EGGS` table. The plugin should handle both filling empty slots (8-20) and appending new ones (23+).

## Future Enhancements

- **Creature-feature integration**: Replace text inputs with a browse/search button that opens the creature-feature browser to select mobiles. Prevents typos and shows creature stats.
- **Egg appearance preview**: Render a DDS preview of the selected egg style in the webview.
- **Batch mode**: Generate multiple eggs at once from a CSV or JSON input.
- **Edit existing eggs**: Load an already-populated slot (1-7, 21-22) into the form for modification.

## Open Questions

- **Egg appearance variety**: How many distinct egg IFF appearances exist to choose from? Need to catalog the visual styles available in `tre/vanilla/` and `tre/infinity/`.
- **Multi-creature weighting**: Should the plugin validate that weights sum correctly, or just pass them through as-is? (Current system uses "first match >= random roll" not percentage-based.)
- **Loot group assignment**: After generating the loot group, where should it be assigned? (Which mob loot tables?) This might be out of scope for v1 — just generate the group and let the user assign it manually.
- **Draft schematic granting**: How does the player learn the schematic? Through the loot schematic system (current approach) or also via a skill box grant? The existing eggs use loot-only.
