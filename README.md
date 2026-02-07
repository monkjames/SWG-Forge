# SWG Forge

VSCode extensions for Star Wars Galaxies Emulator (SWGEmu) development. Visual editors and tools for SWG binary file formats: IFF, STF, DDS, CRC tables, TRE archives, and more.

## Extensions

| Package | Description |
|---------|-------------|
| **stf-editor** | Visual editor for string table files (.stf) |
| **crc-editor** | Editor for CRC string table files |
| **iff-editor** | Template-driven visual editor for IFF files |
| **datatable-editor** | Spreadsheet-style editor for datatable IFF files |
| **dds-editor** | View and edit DDS textures (DXT1/DXT5) |
| **appearance-chain** | Edit SWG appearance chains with inline IFF trees |
| **art-workshop** | Generate in-game art objects from DDS textures |
| **crafting-workshop** | Simulate and design craftable items |
| **mount-wizard** | Automate making creatures/speeders into mounts |
| **tre-builder** | Build TRE archives from tre/working folder |
| **trn-viewer** | View and query terrain (.trn) files |

## Prerequisites

This extension suite is designed for use with the SWGEmu Infinity workspace which provides:

```
workspace/
├── swgemu-vscode/              # This repo
├── infinity4.0.0/              # Active server codebase
├── tre/
│   ├── working/                # Editable TRE files (client assets)
│   ├── vanilla/                # Reference vanilla SOE assets (read-only)
│   └── infinity/               # Reference Infinity assets (read-only)
└── tre_original/               # Compressed TRE archives (read-only)
```

The extensions read/write files from `tre/working/` and interact with the server-side Lua scripts in `infinity4.0.0/`.

## Repository Structure

```
swgemu-vscode/
├── packages/
│   ├── core/                   # Shared library (IFF, CRC, DDS codecs)
│   ├── stf-editor/             # String table editor
│   ├── crc-editor/             # CRC table editor
│   ├── iff-editor/             # IFF file editor
│   ├── datatable-editor/       # Datatable editor
│   ├── dds-editor/             # DDS texture editor
│   ├── appearance-chain/       # Appearance chain editor
│   ├── art-workshop/           # Art object generator
│   ├── crafting-workshop/      # Crafting simulator
│   ├── mount-wizard/           # Mount creation wizard
│   ├── tre-builder/            # TRE archive builder
│   └── trn-viewer/             # Terrain viewer
├── scripts/
│   ├── build-all.js            # Build all extensions to dist/
│   ├── deploy-ssh.js           # Deploy to SSH remote VSCode
│   └── clean.js                # Clean build artifacts
├── dist/                       # Built VSIX files (git-ignored)
├── package.json                # npm workspaces root
└── tsconfig.base.json          # Shared TypeScript config
```

## Building

```bash
# Install dependencies (run from repo root)
npm install

# Build all extensions
npm run build

# Build a single extension
node scripts/build-all.js stf-editor

# Deploy to SSH remote (builds + installs)
node scripts/deploy-ssh.js --build

# Deploy specific extension
node scripts/deploy-ssh.js --build stf-editor

# Clean all build artifacts
npm run clean
```

Built VSIX files are placed in `dist/`.

## Deploying to SSH Remote

The primary use case is VSCode connected to a remote server via SSH. After building:

```bash
# Option 1: Build and deploy in one step
node scripts/deploy-ssh.js --build

# Option 2: Deploy pre-built VSIX files
npm run build
npm run deploy
```

Then reload the VSCode window: `Ctrl+Shift+P` -> "Reload Window"

## Shared Core Library

The `@swgemu/core` package provides shared parsers and codecs used by multiple extensions:

- **IFF Parser** - Parse/serialize SWG Interchange File Format binary files
- **CRC-32** - SWG MPEG-2 CRC-32 calculation (polynomial 0x04C11DB7)
- **CRC Table** - Parse/serialize CSTB (CRC String Table) files
- **DDS Codec** - DXT1/DXT5 texture decode/encode with mipmap generation

Extensions import from `@swgemu/core`:

```typescript
import { parseIFF, serializeIFF, calculateCRC, decodeDDS } from '@swgemu/core';
```

## Development

To work on an extension:

```bash
npm install                     # Install all workspace deps
npm run compile:core            # Build core library first
cd packages/stf-editor          # Go to extension
npm run watch                   # Watch mode for development
```

Press F5 in VSCode to launch the Extension Development Host for testing.
