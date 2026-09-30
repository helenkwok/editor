# @pascal-app/ifc-converter

Pure conversion logic for IFC ↔ Pascal scene graphs. `convertIfcToPascal`
takes a `Uint8Array` of IFC bytes and returns `{ nodes, rootNodeIds }` shaped
against `@pascal-app/core` schemas. `convertPascalToIfc` writes a bounded
IFC4 subset (site, building, storey, walls, doors, windows, spaces) back out
as STEP text. Plan mapping matches current main: IFC `(X, Y)` is Pascal
`(x, z) = (X, -Y)`. Each level is its own storey at that level's elevation.
Wall and space placements are in the storey frame, so the elevation is
written once.

No DOM, no React. The UI lives in `apps/ifc-converter`.

`IFCBEAM` and `IFCBEAMSTANDARDCASE` are imported as editable `block` nodes.
Their triangulated IFC geometry preserves cross-sections, rotations, and slopes;
positions are relative to the containing storey. IFC IDs, names, properties,
and material metadata are retained. Beams without renderable geometry are
reported in the conversion log. Imported beams use the block editor rather than
dedicated parametric beam controls.

Native Pascal nodes are produced when the converter can recover the required
parameters for sites, buildings, levels, walls, doors, windows, slabs, columns,
and IFC spaces (as room zones). IFC stair flights are retained as exact imported
meshes; roofs retain Pascal hierarchy and source metadata but are not yet a
complete parametric conversion. Railings, coverings, furnishings, proxies,
curtain walls, plates, members,
footings, and elements whose native parameters cannot be recovered are retained
as selectable `imported-mesh` nodes using their IFC triangle geometry and color.
Imported meshes are import-only and do not appear as empty objects in the editor
palette.

Door families are derived from `IfcDoor.OperationType`. Glazing is applied from
the standardized `Pset_DoorCommon.GlazingAreaFraction` property rather than
from element names or project-specific conventions.

Browser callers use the default WebIFC WASM path (`/`). Node callers can pass
`{ wasmPath: '/absolute/path/to/web-ifc/' }` in `ConversionOptions`.
