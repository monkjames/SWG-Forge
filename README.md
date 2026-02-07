# SWG Forge

VSCode extensions for Star Wars Galaxies Emulator (SWGEmu) development. Visual editors and tools for SWG binary file formats: IFF, STF, DDS, CRC tables, TRE archives, and more.

## Extensions

| Extension | Description |
|-----------|-------------|
| **SWG Forge Config** | Shared workspace settings for all extensions |
| **STF Editor** | Visual editor for string table files (.stf) |
| **CRC Editor** | Editor for CRC string table files |
| **IFF Editor** | Template-driven visual editor for IFF files |
| **Datatable Editor** | Spreadsheet-style editor for datatable IFF files |
| **DDS Editor** | View and edit DDS textures (DXT1/DXT5) |
| **Appearance Chain** | Edit SWG appearance chains with inline IFF trees |
| **Art Workshop** | Generate in-game art objects from DDS textures |
| **Crafting Workshop** | Simulate and design craftable items |
| **Mount Wizard** | Automate making creatures/speeders into mounts |
| **TRE Builder** | Build TRE archives from working folder |
| **TRN Viewer** | View and query terrain (.trn) files |

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
|           |   +-- managers/           # Core managers (pet_manager, etc.)
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

### Example: Infinity Server (defaults, no config needed)

```
workspace/
+-- SWG-Forge/
+-- infinity4.0.0/MMOCoreORB/bin/scripts/
+-- tre/working/
+-- tre/vanilla/
+-- tre/infinity/
```

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

### Example: Completely Custom Layout

```
workspace/
+-- SWG-Forge/
+-- my-server/MMOCoreORB/bin/scripts/
+-- clientdata/editable/
+-- clientdata/vanilla/
+-- clientdata/server-custom/
```

```json
{
    "swgForge.serverScriptsPath": "my-server/MMOCoreORB/bin/scripts",
    "swgForge.serverConfPath": "my-server/MMOCoreORB/bin/conf",
    "swgForge.tre.workingPath": "clientdata/editable",
    "swgForge.tre.vanillaPath": "clientdata/vanilla",
    "swgForge.tre.referencePath": "clientdata/server-custom"
}
```

---

## Configuration

All settings live in `.vscode/settings.json` at the workspace root. You can also change them through the VSCode Settings UI by searching for **"SWG Forge"**.

To see your current resolved paths: `Ctrl+Shift+P` > **SWG Forge: Show Config**

### Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `swgForge.serverScriptsPath` | `infinity4.0.0/MMOCoreORB/bin/scripts` | Server Lua scripts directory |
| `swgForge.serverConfPath` | `infinity4.0.0/MMOCoreORB/bin/conf` | Server configuration directory |
| `swgForge.customScriptsFolder` | `custom_scripts` | Custom scripts subfolder inside scripts directory |
| `swgForge.tre.workingPath` | `tre/working` | Editable TRE files (the only writable TRE folder) |
| `swgForge.tre.vanillaPath` | `tre/vanilla` | Read-only vanilla SOE TRE assets |
| `swgForge.tre.referencePath` | `tre/infinity` | Read-only server-specific TRE assets |
| `swgForge.tre.exportPath` | `tre/export` | TRE text export directory (CSV/TXT) |

All paths are **relative to the workspace root**. Do not use absolute paths.

---

## Building

```bash
npm install                              # Install dependencies
npm run build                            # Build all extensions to dist/
node scripts/build-all.js stf-editor     # Build one extension
npm run clean                            # Clean build artifacts
```

## Deploying to SSH Remote

The primary use case is VSCode connected to a remote server via SSH.

```bash
node scripts/deploy-ssh.js --build                # Build + deploy all
node scripts/deploy-ssh.js --build stf-editor     # Build + deploy one
npm run deploy                                     # Deploy pre-built only
```

After deploying, reload VSCode: `Ctrl+Shift+P` > **Developer: Reload Window**

---

## Repository Structure

```
SWG-Forge/
+-- packages/
|   +-- config/                 # Shared workspace configuration settings
|   +-- core/                   # Shared library (IFF, CRC, DDS codecs)
|   +-- stf-editor/             # String table editor
|   +-- crc-editor/             # CRC table editor
|   +-- iff-editor/             # IFF file editor
|   +-- datatable-editor/       # Datatable editor
|   +-- dds-editor/             # DDS texture editor
|   +-- appearance-chain/       # Appearance chain editor
|   +-- art-workshop/           # Art object generator
|   +-- crafting-workshop/      # Crafting simulator
|   +-- mount-wizard/           # Mount creation wizard
|   +-- tre-builder/            # TRE archive builder
|   +-- trn-viewer/             # Terrain viewer
+-- scripts/
|   +-- build-all.js            # Build all extensions to dist/
|   +-- deploy-ssh.js           # Deploy to SSH remote VSCode
|   +-- clean.js                # Clean build artifacts
+-- dist/                       # Built VSIX files (git-ignored)
+-- package.json                # npm workspaces root
+-- tsconfig.base.json          # Shared TypeScript config
```

## Shared Core Library

The `@swgemu/core` package provides shared parsers and codecs:

- **IFF Parser** - Parse/serialize SWG Interchange File Format binary files
- **CRC-32** - SWG MPEG-2 CRC-32 calculation (polynomial 0x04C11DB7)
- **CRC Table** - Parse/serialize CSTB (CRC String Table) files
- **DDS Codec** - DXT1/DXT5 texture decode/encode with mipmap generation

```typescript
import { parseIFF, serializeIFF, calculateCRC, decodeDDS } from '@swgemu/core';
```

## Development

```bash
npm install                     # Install all workspace deps
npm run compile:core            # Build core library first
cd packages/stf-editor          # Go to extension
npm run watch                   # Watch mode for development
```

Press F5 in VSCode to launch the Extension Development Host for testing.
