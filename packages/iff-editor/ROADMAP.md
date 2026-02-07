# VS Code IFF Editor - Draft Schematic Features Roadmap

## Completed Features

### Core IFF Editor
- [x] Binary IFF parsing and serialization
- [x] FORM/chunk tree visualization
- [x] Property editing (strings, STF references, numbers, booleans)
- [x] Template builder for custom chunk parsing
- [x] Round-trip editing without data loss

### Draft Schematic Editor
- [x] Auto-detect draft schematic IFFs (`object/draft_schematic/**/*.iff`)
- [x] Find and parse corresponding Lua files
- [x] Schematic tab with ingredient slot grid view
- [x] Display all slot fields: Template Name, Title Name, Resource Type, Slot Type, Quantity, Contribution

### Bidirectional Sync (IFF <-> Lua)
- [x] Edit slot - updates both IFF and Lua simultaneously
- [x] Add new slot - adds to both files
- [x] Delete slot - removes from both files
- [x] Sync buttons: "Lua -> IFF" and "IFF -> Lua"
- [x] "Save Both Files" button

### Mismatch Detection
- [x] Visual indicators for sync status (green=match, red=mismatch, yellow=Lua only, blue=IFF only)
- [x] Header summary showing mismatch counts
- [x] Per-slot highlighting for differences

### Experimental Property Validation
- [x] Parse target template for required experimental properties
- [x] Resource property map (which properties exist on each resource type)
- [x] Validate ingredient resource types against required properties
- [x] Warning banners for mismatched resources (e.g., "fruit doesn't have: Conductivity")

---

## In Progress

### String Validation for Ingredients
- [ ] Validate `ingredientTemplateNames` exist in STF files
- [ ] Validate `ingredientTitleNames` exist in corresponding STF files
- [ ] Show warning if string key is missing from STF
- [ ] Quick-link to create missing STF entries
- [ ] Cross-reference with `string/en/` STF files in tre/working

### Crafting Simulator
- [ ] Form to enter resource/component stats for each ingredient slot
- [ ] Input fields for relevant experimental properties per slot
- [ ] Calculate assembly values based on:
  - Resource quality stats (OQ, CD, etc.)
  - Contribution percentages
  - Combine types (linear, percentage, resource, override)
- [ ] Display predicted experimental attribute ranges
- [ ] Show min/max/average outcomes
- [ ] Support for experimentation point simulation

---

## Planned Features

### Enhanced Validation
- [ ] Validate crafting tool tab compatibility
- [ ] Check skill requirements exist in skill trees
- [ ] Validate XP types are valid
- [ ] Warn on duplicate slot names
- [ ] Validate target template path exists

### Resource Type Browser
- [ ] Searchable list of all resource types
- [ ] Show available properties for each type
- [ ] Quick-insert resource type into slot
- [ ] Resource hierarchy visualization (e.g., iron -> ferrous_metal -> metal -> mineral)

### Target Template Integration
- [ ] Load and display target template properties
- [ ] Show full experimental attribute definitions
- [ ] Edit experimental min/max ranges
- [ ] Visualize attribute-to-slot contribution mapping

### Schematic Diffing
- [ ] Compare two schematics side-by-side
- [ ] Highlight differences in ingredients, quantities, properties
- [ ] Generate diff report

### Batch Operations
- [ ] Update resource type across multiple slots
- [ ] Bulk adjust quantities/contributions
- [ ] Copy slots between schematics
- [ ] Template-based schematic creation

### IFF SSIS/ASSD Editing
- [ ] Direct editing of SSIS forms (ingredient slot definitions)
- [ ] Direct editing of ASSD forms (experimental attribute definitions)
- [ ] Sync SSIS/ASSD changes back to Lua

---

## Technical Debt

- [ ] Unit tests for schematic parser
- [ ] Unit tests for IFF round-trip
- [ ] Error handling for malformed Lua files
- [ ] Performance optimization for large schematics
- [ ] Caching for target template lookups

---

## Notes

### Resource Property Reference

| Resource Type | Available Properties |
|--------------|---------------------|
| Minerals/Metals | CD, CR, DR, HR, MA, OQ, SR, UT |
| Flora Food (fruit, vegetable) | FL, PE, OQ |
| Organic Structural (bone, hide) | DR, HR, MA, OQ, SR |
| Wood | DR, OQ, SR, UT |
| Water | PE, OQ |
| Gas | OQ |
| Gemstone | OQ |

### Property Code Reference

| Code | Full Name |
|------|-----------|
| CD | Conductivity |
| CR | Cold Resistance |
| DR | Decay Resistance |
| FL | Flavor |
| HR | Heat Resistance |
| MA | Malleability |
| OQ | Overall Quality |
| PE | Potential Energy |
| SR | Shock Resistance |
| UT | Unit Toughness |

### Slot Type Reference

| Value | Type | Description |
|-------|------|-------------|
| 0 | RESOURCESLOT | Raw resource input |
| 1 | IDENTICALSLOT | Requires identical components |
| 2 | MIXEDSLOT | Can mix different resources |
| 3 | OPTIONALIDENTICALSLOT | Optional identical component |
| 4 | OPTIONALMIXEDSLOT | Optional mixed resource |
