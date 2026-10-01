import { beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertIfcToPascal } from '@pascal-app/ifc-converter'
import * as WebIFC from 'web-ifc'
import { exportEditedSource, type RoundtripGraph } from './source-update'

const wasmPath = `${dirname(fileURLToPath(import.meta.resolve('web-ifc')))}/`
const fixture = new URL(
  '../../../ifc-converter/public/test-ifc-files/04-ifc-open-house.ifc',
  import.meta.url,
)
let source: Uint8Array
let baseline: RoundtripGraph
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const wall = (graph: RoundtripGraph, expressID = 40): Record<string, unknown> =>
  Object.values(graph.nodes).find(
    (node) => (node.metadata as Record<string, unknown>)?.expressID === expressID,
  )!
const exportGraph = (current: RoundtripGraph, bytes = source, original = baseline) =>
  exportEditedSource({ source: bytes, baseline: original, current, wasmPath })
const derivedZoneId = 'zone_auto_room'
function graphWithDerivedZone(input = baseline): RoundtripGraph {
  const graph = copy(input)
  const level = Object.values(graph.nodes).find((node) => node.type === 'level')!
  graph.nodes[derivedZoneId] = {
    object: 'node',
    id: derivedZoneId,
    type: 'zone',
    name: 'Room 1',
    autoFromWalls: true,
    parentId: level.id,
    metadata: {},
    children: [],
    height: 2.5,
    polygon: {
      type: 'polygon',
      points: [
        [-5, 0],
        [5, 0],
        [5, -5],
        [-5, -5],
      ],
    },
    boundaryWallIds: Object.values(graph.nodes)
      .filter((node) => node.type === 'wall')
      .map((node) => node.id),
  }
  level.children = [...(level.children as string[]), derivedZoneId]
  return graph
}
const exportDerived = (
  original: RoundtripGraph,
  current = copy(original),
  ids = [derivedZoneId],
  bytes = source,
) =>
  exportEditedSource({
    source: bytes,
    baseline: original,
    current,
    wasmPath,
    editorDerivedNodeIds: ids,
  })

async function importGraph(bytes: Uint8Array): Promise<RoundtripGraph> {
  const log = console.log
  console.log = () => {}
  try {
    return (await convertIfcToPascal(bytes, undefined, {
      simplify: false,
      wasmPath,
    })) as unknown as RoundtripGraph
  } finally {
    console.log = log
  }
}

async function withModel<T>(
  bytes: Uint8Array,
  callback: (api: WebIFC.IfcAPI, model: number) => T,
): Promise<T> {
  const api = new WebIFC.IfcAPI()
  api.SetWasmPath(wasmPath, true)
  await api.Init()
  const model = api.OpenModel(bytes.slice())
  try {
    return callback(api, model)
  } finally {
    api.CloseModel(model)
    api.Dispose()
  }
}

async function alterSource(
  callback: (api: WebIFC.IfcAPI, model: number) => void,
): Promise<Uint8Array> {
  return withModel(source, (api, model) => {
    callback(api, model)
    return api.SaveModel(model)
  })
}

async function sourceRecords(bytes: Uint8Array): Promise<Map<number, string>> {
  return withModel(bytes, (api, model) => {
    const ids = api.GetAllLines(model)
    const records = new Map<number, string>()
    for (let i = 0; i < ids.size(); i++)
      records.set(ids.get(i), JSON.stringify(api.GetRawLineData(model, ids.get(i))))
    return records
  })
}

const cloneEntity = (line: any, expressID: number) =>
  Object.assign(Object.create(Object.getPrototypeOf(line)), line, { expressID })
async function sharedShapeSource(): Promise<Uint8Array> {
  return alterSource((api, model) => {
    const sibling = cloneEntity(api.GetLine(model, 40), 100000)
    sibling.GlobalId = new WebIFC.IFC4.IfcGloballyUniqueId('2Iicv0RnfAVPda6Sg4SE79')
    sibling.Name = new WebIFC.IFC4.IfcLabel('Shared-shape sibling')
    api.WriteLine(model, sibling)
    const materials = api.GetLineIDsWithType(model, WebIFC.IFCRELASSOCIATESMATERIAL)
    for (let index = 0; index < materials.size(); index++) {
      const relation = api.GetLine(model, materials.get(index))
      if (relation.RelatedObjects.some((ref: { value: number }) => ref.value === 40)) {
        relation.RelatedObjects = [...relation.RelatedObjects, new WebIFC.Handle(sibling.expressID)]
        api.WriteLine(model, relation)
      }
    }
  })
}
async function sharedSolidSource(): Promise<Uint8Array> {
  return alterSource((api, model) => {
    const north = api.GetLine(model, 221)
    const shape = api.GetLine(model, north.Representation.value)
    const body = shape.Representations.map((ref: { value: number }) =>
      api.GetLine(model, ref.value),
    ).find((rep: any) => rep.RepresentationIdentifier?.value === 'Body')
    body.Items = [new WebIFC.Handle(57)]
    api.WriteLine(model, body)
  })
}

beforeAll(async () => {
  source = new Uint8Array(await readFile(fixture))
  baseline = await importGraph(source)
})

describe('IFC4 original-source edits', () => {
  test('accepts only unchanged, explicitly listed automatic source-wall rooms', async () => {
    const roomSource = await sharedShapeSource()
    const original = graphWithDerivedZone(await importGraph(roomSource))
    const noOp = await exportDerived(original, copy(original), [derivedZoneId], roomSource)
    expect(digest(noOp.bytes)).toBe(digest(roomSource))
    expect(noOp.report.editorDerivedNodeCount).toBe(1)
    expect(noOp.report.changedNodes).toEqual([])
    const current = copy(original)
    wall(current).height = 3.1
    const result = await exportDerived(original, current, [derivedZoneId], roomSource)
    expect(wall(await importGraph(result.bytes)).height).toBe(3.1)
    expect(result.report.editorDerivedNodeCount).toBe(1)
    expect(result.report.changedNodes).toHaveLength(1)
    expect(result.report.exportedEntityCount).toBe(2891)
  })

  test('rejects edits to generated rooms and unlisted derived rooms', async () => {
    const original = graphWithDerivedZone()
    for (const [field, value] of Object.entries({
      name: 'Edited room',
      height: 3.1,
      boundaryWallIds: [],
    })) {
      const current = copy(original)
      current.nodes[derivedZoneId]![field] = value
      await expect(exportDerived(original, current)).rejects.toThrow('edits to editor-derived zone')
    }
    await expect(exportDerived(original, copy(original), [])).rejects.toThrow(
      'missing source identity',
    )
    const added = copy(original)
    added.nodes.unknown = { ...copy(original.nodes[derivedZoneId]), id: 'unknown' }
    await expect(exportDerived(original, added)).rejects.toThrow('additions or deletions')
  })

  test('rejects fake derived exemptions and non-source room references', async () => {
    const original = graphWithDerivedZone()
    await expect(
      exportDerived(original, copy(original), [derivedZoneId, derivedZoneId]),
    ).rejects.toThrow('duplicate or unknown')
    await expect(exportDerived(original, copy(original), ['unknown'])).rejects.toThrow(
      'duplicate or unknown',
    )
    await expect(
      exportDerived(baseline, copy(baseline), [wall(baseline).id as string]),
    ).rejects.toThrow('invalid editor-derived zone')
    for (const [field, value] of Object.entries({
      autoFromWalls: false,
      metadata: { globalId: 'fake', expressID: 100000 },
      parentId: 'unknown',
      boundaryWallIds: [wall(baseline).id, wall(baseline, 221).id, 'unknown'],
    })) {
      const fake = copy(original)
      fake.nodes[derivedZoneId]![field] = value
      await expect(exportDerived(fake)).rejects.toThrow('editor-derived zone')
    }
  })

  test('no-op preserves every source byte and ignores only the site artifact marker', async () => {
    const current = copy(baseline)
    const site = Object.values(current.nodes).find((node) => node.type === 'site')!
    ;(site.metadata as Record<string, unknown>).ifcRoundtrip = { artifactId: 'persisted-fixture' }
    const result = await exportGraph(current)
    expect(digest(result.bytes)).toBe(digest(source))
    expect(result.bytes).not.toBe(source)
    expect(result.report.changedNodes).toEqual([])
    expect(result.report.addedEntityCount).toBe(0)
  })

  test('name and height survive reimport, preserve typed values, and never mutate inputs', async () => {
    const current = copy(baseline)
    wall(current).name = 'Editor roundtrip wall'
    wall(current).height = 3.1
    const snapshots = [digest(source), JSON.stringify(baseline), JSON.stringify(current)]
    const result = await exportGraph(current)
    expect(result.report.sourceSchema).toBe('IFC4')
    expect(result.report.sourceEntityCount).toBe(2885)
    expect(result.report.addedEntityCount).toBe(0)
    expect(result.report.exportedEntityCount).toBe(2885)
    expect(result.report.changedNodes[0].updatedExpressIDs).toEqual([40, 57])
    expect(result.report.changedNodes[0].clonedExpressIDs).toEqual([])
    expect(result.report.changedNodes[0].fields).toEqual(['height', 'name'])
    const imported = await importGraph(result.bytes)
    expect(wall(imported).height).toBe(3.1)
    expect(wall(imported).name).toBe('Editor roundtrip wall')
    const oldRecords = await sourceRecords(source),
      newRecords = await sourceRecords(result.bytes)
    for (const [id, value] of oldRecords)
      if (id !== 40 && id !== 57) expect(newRecords.get(id)).toBe(value)
    await withModel(result.bytes, (api, model) => {
      const editedWall = api.GetLine(model, 40)
      expect(editedWall.Name).toBeInstanceOf(WebIFC.IFC4.IfcLabel)
      const shape = api.GetLine(model, editedWall.Representation.value)
      const body = shape.Representations.map((ref: { value: number }) =>
        api.GetLine(model, ref.value),
      ).find((rep: any) => rep.RepresentationIdentifier?.value === 'Body')
      const solid = api.GetLine(model, body.Items[0].value)
      expect(solid.Depth).toBeInstanceOf(WebIFC.IFC4.IfcPositiveLengthMeasure)
      expect(solid.Depth.value).toBe(3100)
      expect(api.GetLine(model, 57).Depth.value).toBe(3100)
      expect(editedWall.Representation.value).toBe(42)
      expect(shape.Representations[0].value).toBe(43)
      expect(solid.SweptArea.value).toBe(56)
      expect(solid.Position.value).toBe(54)
    })
    expect([digest(source), JSON.stringify(baseline), JSON.stringify(current)]).toEqual(snapshots)
  })

  test('name-only edits add no source entities', async () => {
    const current = copy(baseline)
    wall(current).name = 'Name only'
    const result = await exportGraph(current)
    expect(result.report.addedEntityCount).toBe(0)
    expect(result.report.changedNodes[0].clonedExpressIDs).toEqual([])
    expect(wall(await importGraph(result.bytes)).name).toBe('Name only')
  })

  test('rejects names that cannot survive reimport', async () => {
    for (const name of ['', 'x'.repeat(256), 'bad\0name']) {
      const current = copy(baseline)
      wall(current).name = name
      await expect(exportGraph(current)).rejects.toThrow('nonempty label')
    }
  })

  test('unsupported thickness anywhere rejects the entire edit transaction', async () => {
    const current = copy(baseline)
    wall(current).height = 3.1
    wall(current, 221).thickness = 0.5
    const snapshot = digest(source)
    await expect(exportGraph(current)).rejects.toThrow('thickness')
    expect(digest(source)).toBe(snapshot)
  })

  test('rejects additions and deletions', async () => {
    const added = copy(baseline)
    added.nodes.extra = { ...copy(wall(added)), id: 'extra' }
    await expect(exportGraph(added)).rejects.toThrow('additions or deletions')
    const deleted = copy(baseline)
    delete deleted.nodes[wall(deleted).id as string]
    await expect(exportGraph(deleted)).rejects.toThrow('additions or deletions')
  })

  test('rejects reparenting, altered geometry, materials, and metadata', async () => {
    for (const [field, value] of Object.entries({
      parentId: null,
      start: [0, 0],
      visible: false,
      metadata: { ...(wall(baseline).metadata as Record<string, unknown>), arbitrary: true },
    })) {
      const current = copy(baseline)
      wall(current)[field] = value
      await expect(exportGraph(current)).rejects.toThrow(field)
    }
    const current = copy(baseline)
    current.materials = { a: { color: 'red' } }
    await expect(exportGraph(current)).rejects.toThrow('materials')
  })

  test('rejects missing, changed, duplicate, and mismatched source identities', async () => {
    const missing = copy(baseline)
    delete (wall(missing).metadata as Record<string, unknown>).globalId
    await expect(exportGraph(missing)).rejects.toThrow('identity')
    const duplicateBaseline = copy(baseline)
    wall(duplicateBaseline, 221).metadata = copy(wall(duplicateBaseline).metadata)
    await expect(exportGraph(copy(duplicateBaseline), source, duplicateBaseline)).rejects.toThrow(
      'duplicate graph GlobalId',
    )
    const hintBaseline = copy(baseline)
    ;(wall(hintBaseline).metadata as Record<string, unknown>).expressID = 221
    await expect(exportGraph(copy(hintBaseline), source, hintBaseline)).rejects.toThrow(
      'do not match',
    )
    const duplicateSource = await alterSource((api, model) => {
      const north = api.GetLine(model, 221)
      north.GlobalId = api.GetLine(model, 40).GlobalId
      api.WriteLine(model, north)
    })
    await expect(exportGraph(copy(baseline), duplicateSource)).rejects.toThrow(
      'duplicate source GlobalId',
    )
  })

  test('shared geometry remains unchanged for a sibling and copied styles preserve appearance', async () => {
    const shared = await sharedShapeSource()
    const original = await importGraph(shared)
    const current = copy(original)
    wall(current).height = 3.1
    const result = await exportGraph(current, shared, original)
    const imported = await importGraph(result.bytes)
    expect(wall(imported).height).toBe(3.1)
    expect(wall(imported, 100000).height).toBe(wall(original, 100000).height)
    expect(result.report.addedEntityCount).toBe(5)
    expect(result.report.sourceEntityCount).toBe(2886)
    expect(result.report.exportedEntityCount).toBe(2891)
    expect(result.report.changedNodes[0].updatedExpressIDs).toEqual([40])
    const originalRecords = await sourceRecords(shared),
      exportedRecords = await sourceRecords(result.bytes)
    for (const [id, value] of originalRecords)
      if (id !== 40) expect(exportedRecords.get(id)).toBe(value)
    await withModel(result.bytes, (api, model) => {
      const south = api.GetLine(model, 40),
        north = api.GetLine(model, 100000)
      expect(north.Representation.value).toBe(42)
      expect(south.Representation.value).not.toBe(42)
      expect(api.GetLine(model, 57).Depth.value).toBe(3000)
      const shape = api.GetLine(model, south.Representation.value)
      const axis = shape.Representations.map((ref: { value: number }) =>
        api.GetLine(model, ref.value),
      ).find((rep: any) => rep.RepresentationIdentifier?.value === 'Axis')
      expect(axis.expressID).not.toBe(43)
      expect(axis.Items[0].value).toBe(60)
      const body = shape.Representations.map((ref: { value: number }) =>
        api.GetLine(model, ref.value),
      ).find((rep: any) => rep.RepresentationIdentifier?.value === 'Body')
      const newSolidID = body.Items[0].value
      const ids = api.GetLineIDsWithType(model, WebIFC.IFCSTYLEDITEM)
      const styles = Array.from({ length: ids.size() }, (_, index) =>
        api.GetLine(model, ids.get(index)),
      )
      const oldStyle = styles.find((style) => style.Item?.value === 57),
        newStyle = styles.find((style) => style.Item?.value === newSolidID)
      expect(oldStyle).toBeDefined()
      expect(newStyle).toBeDefined()
      expect(newStyle.Styles).toEqual(oldStyle.Styles)
      expect(newStyle.Name).toEqual(oldStyle.Name)
      const mesh = api.GetFlatMesh(model, 40),
        sibling = api.GetFlatMesh(model, 100000)
      expect(mesh.geometries.get(0).color).toEqual(sibling.geometries.get(0).color)
    })
  })

  test('shared solids copy only extrusion and style while retaining the private shape and Axis', async () => {
    const shared = await sharedSolidSource()
    const original = await importGraph(shared)
    const current = copy(original)
    wall(current).height = 3.1
    const result = await exportGraph(current, shared, original)
    expect(result.report.addedEntityCount).toBe(2)
    expect(result.report.exportedEntityCount).toBe(2887)
    expect(result.report.changedNodes[0].updatedExpressIDs).toEqual([44])
    expect(wall(await importGraph(result.bytes), 221).height).toBe(wall(original, 221).height)
    await withModel(result.bytes, (api, model) => {
      expect(api.GetLine(model, 40).Representation.value).toBe(42)
      expect(api.GetLine(model, 42).Representations[0].value).toBe(43)
      const solid = api.GetLine(model, api.GetLine(model, 44).Items[0].value)
      expect(solid.expressID).not.toBe(57)
      expect(solid.Depth.value).toBe(3100)
      expect(api.GetLine(model, 57).Depth.value).toBe(3000)
      const styles = api.GetLineIDsWithType(model, WebIFC.IFCSTYLEDITEM)
      expect(
        Array.from({ length: styles.size() }, (_, index) =>
          api.GetLine(model, styles.get(index)),
        ).some((style) => style.Item?.value === solid.expressID),
      ).toBe(true)
    })
  })

  test('editing every shared owner retains one original branch without orphaning shapes', async () => {
    for (const [bytes, siblingID, additions] of [
      [await sharedShapeSource(), 100000, 5],
      [await sharedSolidSource(), 221, 2],
    ] as const) {
      const original = await importGraph(bytes)
      const current = copy(original)
      wall(current).height = 3.1
      wall(current, siblingID).height = 3.2
      const result = await exportGraph(current, bytes, original)
      const imported = await importGraph(result.bytes)
      expect(wall(imported).height).toBe(3.1)
      expect(wall(imported, siblingID).height).toBe(3.2)
      expect(result.report.addedEntityCount).toBe(additions)
      await withModel(result.bytes, (api, model) => {
        const productIds = api.GetAllLines(model)
        const lines = Array.from({ length: productIds.size() }, (_, index) =>
          api.GetLine(model, productIds.get(index)),
        )
        const shapeOwners = lines.filter((line) => line.Representation?.value === 42)
        expect(shapeOwners).toHaveLength(1)
        const solidOwners = lines.filter(
          (line) =>
            line.type === WebIFC.IFCSHAPEREPRESENTATION &&
            line.Items.some((ref: { value: number }) => ref.value === 57),
        )
        expect(solidOwners).toHaveLength(1)
        for (const shape of lines.filter(
          (line) => line.type === WebIFC.IFCPRODUCTDEFINITIONSHAPE,
        )) {
          expect(lines.some((line) => line.Representation?.value === shape.expressID)).toBe(true)
        }
      })
    }
  }, 30000)

  test('rejects additional source representations and unknown extrusion inverse attachments', async () => {
    const boxed = await alterSource((api, model) => {
      const box = new WebIFC.IFC4.IfcBoundingBox(
        new WebIFC.Handle(53),
        new WebIFC.IFC4.IfcPositiveLengthMeasure(10000),
        new WebIFC.IFC4.IfcPositiveLengthMeasure(360),
        new WebIFC.IFC4.IfcPositiveLengthMeasure(3000),
      )
      box.expressID = 100000
      api.WriteLine(model, box)
      const representation = cloneEntity(api.GetLine(model, 44), 100001)
      representation.RepresentationIdentifier = new WebIFC.IFC4.IfcLabel('Box')
      representation.RepresentationType = new WebIFC.IFC4.IfcLabel('BoundingBox')
      representation.Items = [new WebIFC.Handle(box.expressID)]
      api.WriteLine(model, representation)
      const shape = api.GetLine(model, 42)
      shape.Representations = [
        ...shape.Representations,
        new WebIFC.Handle(representation.expressID),
      ]
      api.WriteLine(model, shape)
    })
    const current = copy(baseline)
    wall(current).height = 3.1
    await expect(exportGraph(current, boxed)).rejects.toThrow('additional source representations')
    const booleanUser = await alterSource((api, model) => {
      const boolean = api.GetLine(
        model,
        api.GetLineIDsWithType(model, WebIFC.IFCBOOLEANCLIPPINGRESULT).get(0),
      )
      boolean.FirstOperand = new WebIFC.Handle(57)
      api.WriteLine(model, boolean)
    })
    await expect(exportGraph(current, booleanUser)).rejects.toThrow(
      'unsupported source extrusion ownership',
    )
  })

  test('rejects stale baseline heights, invalid heights, and tilted placements', async () => {
    const stale = copy(baseline)
    wall(stale).height = 2.9
    const changed = copy(stale)
    wall(changed).height = 3.1
    await expect(exportGraph(changed, source, stale)).rejects.toThrow('does not match')
    for (const height of [0, -1, Infinity, NaN]) {
      const current = copy(baseline)
      wall(current).height = height
      await expect(exportGraph(current)).rejects.toThrow('positive finite')
    }
    const tilted = await alterSource((api, model) => {
      const axis = api.GetLine(model, 54)
      const direction = api.GetLine(model, axis.Axis.value)
      direction.DirectionRatios = [
        new WebIFC.IFC4.IfcReal(0),
        new WebIFC.IFC4.IfcReal(1),
        new WebIFC.IFC4.IfcReal(0),
      ]
      api.WriteLine(model, direction)
    })
    const current = copy(baseline)
    wall(current).height = 3.1
    await expect(exportGraph(current, tilted)).rejects.toThrow('upright')
  })

  test('rejects source presentation layers attached to copied geometry', async () => {
    const layered = await alterSource((api, model) => {
      const layer = new WebIFC.IFC4.IfcPresentationLayerAssignment(
        new WebIFC.IFC4.IfcLabel('Walls'),
        null,
        [new WebIFC.Handle(57)],
        null,
      )
      layer.expressID = 100000
      api.WriteLine(model, layer)
    })
    const current = copy(baseline)
    wall(current).height = 3.1
    await expect(exportGraph(current, layered)).rejects.toThrow('presentation layer')
  })

  test('rejects mapped and boolean Body geometry', async () => {
    for (const type of [WebIFC.IFCMAPPEDITEM, WebIFC.IFCBOOLEANCLIPPINGRESULT]) {
      const indirect = await alterSource((api, model) => {
        const body = api.GetLine(model, 44)
        body.Items = [new WebIFC.Handle(api.GetLineIDsWithType(model, type).get(0))]
        api.WriteLine(model, body)
      })
      const current = copy(baseline)
      wall(current).height = 3.1
      await expect(exportGraph(current, indirect)).rejects.toThrow('mapped or boolean')
    }
  })

  test('source property sets remain unchanged during a geometry edit', async () => {
    const enriched = await alterSource((api, model) => {
      const property = new WebIFC.IFC4.IfcPropertySingleValue(
        new WebIFC.IFC4.IfcIdentifier('Manufacturer'),
        null,
        new WebIFC.IFC4.IfcLabel('Keep this source value'),
        null,
      )
      property.expressID = 100000
      api.WriteLine(model, property)
      const set = new WebIFC.IFC4.IfcPropertySet(
        new WebIFC.IFC4.IfcGloballyUniqueId('2Iicv0RnfAVPda6Sg4SE79'),
        new WebIFC.Handle(5),
        new WebIFC.IFC4.IfcLabel('Preserved source properties'),
        null,
        [new WebIFC.Handle(property.expressID)],
      )
      set.expressID = 100001
      api.WriteLine(model, set)
      const relation = new WebIFC.IFC4.IfcRelDefinesByProperties(
        new WebIFC.IFC4.IfcGloballyUniqueId('2Iicv0RnfAVPda6Sg4SE7A'),
        new WebIFC.Handle(5),
        null,
        null,
        [new WebIFC.Handle(40)],
        new WebIFC.Handle(set.expressID),
      )
      relation.expressID = 100002
      api.WriteLine(model, relation)
    })
    const original = await importGraph(enriched)
    const current = copy(original)
    wall(current).height = 3.1
    const result = await exportGraph(current, enriched, original)
    const originalRecords = await sourceRecords(enriched),
      exportedRecords = await sourceRecords(result.bytes)
    for (const id of [100000, 100001, 100002])
      expect(exportedRecords.get(id)).toBe(originalRecords.get(id))
    expect(result.report.addedEntityCount).toBe(0)
  })

  test('rejects source quantities rather than silently making them stale', async () => {
    const quantified = await alterSource((api, model) => {
      const quantity = new WebIFC.IFC4.IfcQuantityLength(
        new WebIFC.IFC4.IfcLabel('Height'),
        null,
        null,
        new WebIFC.IFC4.IfcLengthMeasure(3000),
        null,
      )
      quantity.expressID = 100000
      api.WriteLine(model, quantity)
      const set = new WebIFC.IFC4.IfcElementQuantity(
        new WebIFC.IFC4.IfcGloballyUniqueId('2Iicv0RnfAVPda6Sg4SE79'),
        new WebIFC.Handle(5),
        new WebIFC.IFC4.IfcLabel('Wall quantities'),
        null,
        null,
        [new WebIFC.Handle(quantity.expressID)],
      )
      set.expressID = 100001
      api.WriteLine(model, set)
      const relation = new WebIFC.IFC4.IfcRelDefinesByProperties(
        new WebIFC.IFC4.IfcGloballyUniqueId('2Iicv0RnfAVPda6Sg4SE7A'),
        new WebIFC.Handle(5),
        null,
        null,
        [new WebIFC.Handle(40)],
        new WebIFC.Handle(set.expressID),
      )
      relation.expressID = 100002
      api.WriteLine(model, relation)
    })
    const current = copy(baseline)
    wall(current).height = 3.1
    await expect(exportGraph(current, quantified)).rejects.toThrow('explicit quantities')
  })
})
