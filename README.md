# SWG Forge

VSCode extensions for Star Wars Galaxies Emulator (SWGEmu) development. Visual editors and tools for SWG binary file formats: IFF, STF, DDS, CRC tables, TRE archives, and more.

> **Acknowledgment:** This project would not have been possible without the pioneering work of **Sytner** and [SIE (SWG Information Extractor)](https://modthegalaxy.com/index.php?resources/sie.1/). SIE's deep documentation and tooling for SWG's binary formats laid the groundwork that made building these editors a reality. Thank you, Sytner.

## Extensions

### File Editors

Open these file types in VSCode and the editor activates automatically.

| Extension | File Types | Description |
|-----------|-----------|-------------|
| **IFF Editor** | `.iff`, `.apt`, `.sat`, `.lod`, `.msh`, `.mgn`, `.sht`, `.pob` | Template-driven visual editor for IFF binary files |
| **STF Editor** | `.stf` | Two-column editor for string table files with search and pagination |
| **CRC Editor** | `*crc_string_table.iff` | Editor for CRC-to-path mapping tables |
| **Datatable Editor** | `datatables/**/*.iff` | Spreadsheet-style editor for SWG datatables |
| **DDS Editor** | `.dds` | View and edit DDS textures (DXT1/DXT5) with mipmap display |
| **Palette Editor** | `.pal` | Visual color grid editor for SWG RIFF PAL files |
| **TRN Viewer** | `.trn` | View and query terrain files — check boundaries at coordinates |
| **ILF Viewer** | `.ilf` | 2D interior layout viewer for building ILF files |
| **TRE Viewer** | `.tre` | Browse contents of TRE archive files |

### Tools

Launch from the command palette (`Ctrl+Shift+P` > `SWG:`) or the Forge Hub page.

| Extension | Description |
|-----------|-------------|
| **Art Workshop** | Visual art asset browser and editor for SWG textures and appearances |
| **Combat Sim** | Combat simulation and testing tool for balancing damage, armor, and states |
| **Crafting Workshop** | Crafting schematic designer with resource quality and experimentation preview |
| **Mount Wizard** | Mount creation tool — configure speed, terrain, and appearance |
| **TRE Builder** | Build TRE archives from tre/working — sidebar panel with validation and change tracking |
| **SWG Forge Config** | Shared workspace settings, path configuration, and Forge Hub launcher |

### Read-Only Protection

Files opened from `tre/vanilla/` or `tre/infinity/` are automatically read-only. A toolbar banner shows the file source with an "Edit in Working" button that copies the file to `tre/working/` and opens it there.

---

## Quick Start

```bash
git clone git@github.com:monkjames/SWG-Forge.git
cd SWG-Forge
npm install
npm run build
node scripts/deploy-ssh.js      # if using VSCode SSH Remote
```

Then reload VSCode: `Ctrl+Shift+P` > **Developer: Reload Window**

Open the Forge Hub: `Ctrl+Shift+P` > **SWG: Open Forge**

---

## Workspace Setup

SWG Forge expects your workspace to have a specific folder layout. The exact folder names are **fully configurable** (see [Configuration](#configuration)), but the structure should look like this:

```
your-workspace/
|
+-- SWG-Forge/                          # This repo (extension source code)
|
+-- <server-code>/                      # Your SWGEmu server code
|   +-- MMOCoreORB/
|       +-- bin/
|           +-- scripts/                # Lua scripts root
|           |   +-- object/             # Vanilla object templates
|           |   +-- managers/           # Core managers
|           |   +-- custom_scripts/     # Your custom Lua work
|           +-- conf/                   # Server config (config-local.lua)
|
+-- <tre-working>/                      # YOUR EDITABLE TRE FILES
|   +-- object/                         # IFF object templates
|   +-- string/en/                      # STF string files
|   +-- appearance/                     # APT/LOD/MSH appearance files
|   +-- texture/                        # DDS textures
|   +-- shader/                         # SHT shader files
|   +-- misc/                           # CRC tables, datatables
|
+-- <tre-vanilla>/                      # Read-only: vanilla SOE game assets
|   +-- (same structure as above)
|
+-- <tre-reference>/                    # Read-only: your server's custom assets
    +-- (same structure as above)
```

> **Key concept:** The TRE working directory is the ONLY folder where files get created or modified. Vanilla and reference TRE folders are read-only - extensions use them to look up original game data.

### Example: Standard Core3 Server

```
workspace/
+-- SWG-Forge/
+-- Core3/MMOCoreORB/bin/scripts/
+-- tre/working/
+-- tre/vanilla/
```

Add to `.vscode/settings.json`:
```json
{
    "swgForge.serverScriptsPath": "Core3/MMOCoreORB/bin/scripts",
    "swgForge.serverConfPath": "Core3/MMOCoreORB/bin/conf"
}
```

---

## Configuration

All settings live in `.vscode/settings.json` at the workspace root. You can also change them through the VSCode Settings UI by searching for **"SWG Forge"**.

To see your current resolved paths: `Ctrl+Shift+P` > **SWG Forge: Show Config**

### Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `swgForge.serverScriptsPath` | `infinity_wicked/MMOCoreORB/bin/scripts` | Server Lua scripts directory |
| `swgForge.serverConfPath` | `infinity_wicked/MMOCoreORB/bin/conf` | Server configuration directory |
| `swgForge.customScriptsFolder` | `custom_scripts` | Custom scripts subfolder |
| `swgForge.tre.workingPath` | `tre/working` | Editable TRE files |
| `swgForge.tre.vanillaPath` | `tre/vanilla` | Read-only vanilla SOE assets |
| `swgForge.tre.referencePath` | `tre/infinity` | Read-only server-specific assets |

All paths are **relative to the workspace root**.

---

## Building

```bash
npm install                              # Install dependencies
npm run build                            # Build all extensions to dist/
node scripts/build-all.js stf-editor     # Build one extension
npm run clean                            # Clean build artifacts
```

## Deploying to SSH Remote

```bash
node scripts/deploy-ssh.js --build                # Build + deploy all
node scripts/deploy-ssh.js --build stf-editor     # Build + deploy one
```

After deploying, reload VSCode: `Ctrl+Shift+P` > **Developer: Reload Window**

---

## Repository Structure

```
SWG-Forge/
+-- packages/
|   +-- config/                 # Shared settings and Forge Hub
|   +-- core/                   # Shared library (IFF, CRC, DDS, POB, STF codecs)
|   +-- iff-editor/             # IFF file editor
|   +-- stf-editor/             # String table editor
|   +-- crc-editor/             # CRC table editor
|   +-- datatable-editor/       # Datatable editor
|   +-- dds-editor/             # DDS texture editor
|   +-- palette-editor/         # Palette color editor
|   +-- tre-viewer/             # TRE archive browser
|   +-- tre-builder/            # TRE archive builder
|   +-- trn-viewer/             # Terrain viewer
|   +-- ilf-viewer/             # Interior layout viewer
|   +-- art-workshop/           # Art asset browser and editor
|   +-- combat-sim/             # Combat simulation tool
|   +-- crafting-workshop/      # Crafting schematic designer
|   +-- mount-wizard/           # Mount creation tool
+-- scripts/
|   +-- build-all.js            # Build all extensions
|   +-- deploy-ssh.js           # Deploy to SSH remote
|   +-- clean.js                # Clean build artifacts
+-- docs/                       # Design documents
+-- dist/                       # Built VSIX files (git-ignored)
```

## Shared Core Library

The `@swgemu/core` package provides shared parsers and codecs:

- **IFF** - Parse/serialize SWG Interchange File Format binary files
- **CRC-32** - SWG MPEG-2 CRC-32 calculation (polynomial 0x04C11DB7)
- **CRC Table** - Parse/serialize CSTB (CRC String Table) files
- **DDS** - DXT1/DXT5 texture decode/encode with mipmap generation
- **STF** - String table file parser/serializer
- **POB** - Portalized Object Building parser/serializer (v0003/v0004)
- **FLR** - Floor mesh parser
- **PAL** - Palette parser/serializer
- **ACM** - Asset Customization Manager parser/serializer

```typescript
import { parseIFF, serializeIFF, calculateCRC, decodeDDS, parsePOB, serializePOB } from '@swgemu/core';
```
