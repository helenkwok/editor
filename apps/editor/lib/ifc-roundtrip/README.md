# IFC4 source-preserving workflow spike

`/ifc-roundtrip` imports an IFC4 file into the native editor, saves and reopens its
scene, and exports edits against the original IFC source. Original bytes and the
post-hydration baseline live beside the scene database in a separate artifact
directory. Scene metadata retains their identity and hash.

Supported exports are source object names and heights of direct, upright straight
wall extrusions. Shared geometry is copied only when an edit needs a private
branch. Unsupported geometry, identity, material, or scene changes reject export.
Roof-clipped walls and their hosted fills retain their exact imported meshes;
they do not support native wall height edits.

## Run locally

From the repository root, with workspace dependencies installed and built:

```sh
bun install --frozen-lockfile
bun run build --filter=@pascal-app/ifc-converter
mkdir -p out/ifc-roundtrip/artifacts
PASCAL_DATA_DIR="$PWD/out/ifc-roundtrip" \
PASCAL_IFC_SPIKE_DIR="$PWD/out/ifc-roundtrip/artifacts" \
bun run --cwd apps/editor dev -- --hostname 127.0.0.1 --port 3012
```

Open `http://127.0.0.1:3012/ifc-roundtrip`. Import an IFC4 file, wait for the ready
message, rename an object in the Scene tree or edit a straight wall height in its
native inspector, save, reopen, and export. The API remains disabled until
`PASCAL_IFC_SPIKE_DIR` is set. Use a dedicated `PASCAL_DATA_DIR` to keep spike scenes
separate from regular editor scenes. Runtime files in `out/` are ignored by Git.

## Verification

```sh
bun test apps/editor/lib/ifc-roundtrip
bun test packages/ifc-converter/tests
```

The tests use the existing Open House fixture in `apps/ifc-converter` and cover
baseline drift, source identity, shared geometry ownership, unsupported edits,
and roof-clipped wall preservation. The broader BIMCode spike also validates
the native browser workflow and exported files with IfcOpenShell.
