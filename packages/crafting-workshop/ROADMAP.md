# Crafting Workshop Roadmap

## Current State

The Crafting Workshop VS Code plugin provides:
- **Tab 1: Crafting Simulation** - Real-time simulation with resource stat inputs
- **Tab 2: Formula Editor** - Edit/create experimental property formulas
- **Tab 3: Blue Frog Defaults** - Edit baseline values for non-crafted items (with smart defaults)

---

## Roadmap Items

### 1. Smart Blue Frog Defaults Based on Object Type

**Status:** Implemented (v1.1.0)

**Problem:**
The Blue Frog Defaults tab shows blank when a template has no explicit values defined. This happens because `parseBlueFrogDefaults()` only reads values that exist in the Lua file.

**Current Behavior:**
```
Template has: useCount = 10, effectiveness = 50
UI shows: useCount, effectiveness fields only

Template has: (nothing)
UI shows: "No blue frog properties found"
```

**Desired Behavior:**
When a template has no Blue Frog values defined, show a predefined list of relevant fields based on:

1. **Object Type Detection** (from target template path):
   - `tangible/medicine/` → Medicine properties
   - `tangible/weapon/` → Weapon damage + attack costs
   - `tangible/wearables/armor/` → Armor resistances
   - `tangible/component/` → Component properties (if applicable)

2. **Experimental Attribute Inference** (from formula definitions):
   - If formulas include `power`, `charges` → show medicine fields
   - If formulas include `mindamage`, `maxdamage`, `attackspeed` → show weapon fields
   - If formulas include `kinetic`, `energy`, etc. → show armor fields

3. **Sensible Defaults:**
   - Derive initial values from experimental `min`/`max` ranges
   - Example: If `power` has range 50-200, default Blue Frog `effectiveness` to 50 (the min)

**Implementation:**

Added the following to `src/schematicLoader.ts`:
- `detectObjectType(templatePath)` - Detects object type from file path (medicine, weapon, armor, etc.)
- `detectObjectTypeFromAttributes(attributeNames)` - Fallback detection from experimental attributes
- `inferBlueFrogDefaults(...)` - Generates smart defaults based on:
  - Object type (from path or attributes)
  - Experimental formula min values as baseline
- `BLUEFROG_DEFAULTS_BY_TYPE` - Base defaults for each object type
- `EXPERIMENTAL_BLUEFROG_MAP` - Maps experimental attrs to blue frog props

Added to `src/workshopPanel.ts`:
- Visual indicator for inferred values (dashed border, "auto" badge)
- Notice banner showing detected object type when values are inferred
- When user edits an inferred value, it becomes explicit (badge removed)

**Files Modified:**
- `src/schematicLoader.ts` - Detection and inference logic
- `src/workshopPanel.ts` - UI changes for inferred value display

---

### 2. Experimentation Point Simulator

**Status:** Planned (High Priority)

**Problem:**
The current simulation shows assembly results but doesn't simulate experimentation attempts with success/failure rolls. Crafters need to understand expected outcomes when spending points.

**Features Needed:**
- Input total experimentation points (skill-based, typically 0-14, +2.5 from skill tapes)
- Show experimentation rows derived from unique `experimentalGroupTitles`
- Each row groups attributes that share the same experiment group
- **Display predicted bubble count per row** (based on resource quality)
- Simulate spending N points on a row and show success/failure outcomes
- The server uses `calculateExperimentationFailureRate()` for failure chances

**Technical Notes:**
- Experimentation points come from player skills (divided by 10, so +25 skill tape = +2.5 points)
- Rows = unique values from `experimentalGroupTitles` (not counting `null` placeholders)
- Multiple attributes in the same group improve together when you experiment on that row

**Bubble Count Formula (DISCOVERED):**

The number of experimentation bubbles is **dynamic per crafting session**, NOT fixed. It depends on resource quality:

```cpp
// From ResourceLabratory.cpp:92-93
maxPercentage = ((weightedSum / 10.0f) * .01f);
// Simplified: maxPercentage = weightedSum / 1000
```

- `weightedSum` = sum of (resource stat × weight) for all contributing resources
- `maxPercentage` is a float from 0.0 to 1.0 (capped at 1.0)
- Client displays this as bubbles: `bubbles = floor(maxPercentage * 10)`
- **Better resources → higher weightedSum → more bubbles**

**Example:**
- Poor resources: weightedSum = 400 → maxPercentage = 0.4 → 4 bubbles
- Good resources: weightedSum = 800 → maxPercentage = 0.8 → 8 bubbles
- Amazing resources: weightedSum = 1000+ → maxPercentage = 1.0 → 10 bubbles (capped)

**Server Code References:**
- `ManufactureSchematicObjectDeltaMessage7.h:171-190` - `update0C()` sends `maxVisiblePercentage` to client
- `ResourceLabratory.cpp:92-93` - Actual formula calculation
- `AttributesMapImplementation.cpp:362-411` - `getMaxVisiblePercentage()` averages across group

**Example:**
```
experimentalGroupTitles = {"null", "exp_damage", "exp_damage", "exp_effectiveness"}
experimentalSubGroupTitles = {"null", "mindamage", "maxdamage", "attackspeed"}

Result: 2 experimentation rows
- Row 0: "exp_damage" → affects mindamage AND maxdamage
- Row 1: "exp_effectiveness" → affects attackspeed only
```

---

### 3. Health Check / Validation Tab (Tab 4)

**Status:** Implemented (v1.2.0)

**Problem:**
Common mistakes in schematic setup are only discovered when testing in-game. A validation tab catches these errors early.

**Validations Implemented:**

**Schematic Lua:**
- [x] `targetTemplate` path exists
- [x] Ingredient slots defined
- [x] `contribution` values sum to reasonable total (warns if 0 or != 100)
- [x] `assemblySkill` defined
- [x] `experimentingSkill` defined

**Target Template Lua:**
- [x] Array lengths match: `numberExperimentalProperties`, `experimentalGroupTitles`, `experimentalSubGroupTitles`, `experimentalMin`, `experimentalMax`, `experimentalPrecision`, `experimentalCombineType`
- [x] Sum of `numberExperimentalProperties` equals length of `experimentalProperties` and `experimentalWeights`
- [x] `experimentalMin` <= `experimentalMax` for each attribute (warns on inversion)
- [x] Valid crafting formulas found (experimentalProperties not empty)
- [x] Blue frog defaults detection (info if auto-inferred)

**Draft Schematic IFF:**
- [x] File exists
- [x] Valid IFF format (FORM header check)

**Target Object IFF:**
- [x] File exists in tre/working, tre/infinity, or tre/vanilla

**Implementation:**

Added to `src/schematicLoader.ts`:
- `ValidationSeverity` type: 'error' | 'warning' | 'info'
- `ValidationResult` interface: severity, category, message, file, fix
- `ValidationReport` interface: passed, errors, warnings, infos, results
- `validateProject()` method: comprehensive validation

Added to `src/workshopPanel.ts`:
- Tab 4: "Health Check" with automatic validation on load
- Visual summary with error/warning/info counts
- Results grouped by category with clickable file links
- Suggested fixes for common issues
- Tab badge shows status (error count or ✓)

---

### 4. [Future] Formula Templates by Object Type

**Status:** Idea

Pre-populate formula editor with common attribute patterns when creating new items:
- **Weapon template**: mindamage, maxdamage, attackspeed, woundchance
- **Armor template**: kinetic, energy, electricity, etc.
- **Medicine template**: power, charges

---

### 5. [Future] Resource Presets

**Status:** Idea

Save/load resource stat combinations for quick testing:
- Save current slot values as a preset
- Load presets to populate all slots
- Could pull actual resources from `scripts/managers/resource_spawn_manager.lua`

---

## Technical Notes

### Blue Frog ↔ Experimental Attribute Mapping

```typescript
const BLUEFROG_EXPERIMENTAL_MAP = {
    'useCount': 'charges',
    'effectiveness': 'power',
    'minDamage': 'mindamage',
    'maxDamage': 'maxdamage',
    'attackSpeed': 'attackspeed',
    'woundsRatio': 'woundchance',
    'healthAttackCost': 'attackhealthcost',
    'actionAttackCost': 'attackactioncost',
    'mindAttackCost': 'attackmindcost',
};
```

### Object Type Detection Patterns

| Path Pattern | Object Type | Blue Frog Properties |
|--------------|-------------|---------------------|
| `tangible/medicine/` | medicine | useCount, effectiveness, duration, medicineUse |
| `tangible/weapon/melee/` | melee weapon | min/maxDamage, attackSpeed, woundsRatio, health/action/mindAttackCost |
| `tangible/weapon/ranged/` | ranged weapon | min/maxDamage, attackSpeed, woundsRatio, health/action/mindAttackCost |
| `tangible/wearables/armor/` | armor | armorRating, kinetic, energy, electricity, stun, blast, heat, cold, acid, lightSaber |
| `tangible/food/` | food | (TBD) |
| `tangible/component/` | component | Depends on component type |

### Experimentation Bubble Count Formula

The number of bubbles shown in the experimentation UI is calculated dynamically based on resource quality:

```
maxPercentage = weightedSum / 1000
bubbles = floor(maxPercentage × 10)   // capped at 10
```

Where `weightedSum` is the sum of (resource stat × experimental weight) for all resources in the crafting session.

**Key insight:** Bubble count varies between crafts of the same schematic because it depends on the actual resources used, not the schematic definition.

### Weighted Sum Calculation

For each experimental attribute:
1. Get all contributing resources for that attribute
2. For each resource: `contribution = resourceStat × weight`
3. Sum all contributions = `weightedSum`
4. `maxPercentage = weightedSum / 1000` (capped at 1.0)

---

## Version History

- **1.2.0** - Experimentation bubble count prediction + Health Check / Validation tab
- **1.1.0** - Smart Blue Frog defaults based on object type and experimental formulas
- **1.0.0** - Initial release with simulation, formula editor, and blue frog tabs
