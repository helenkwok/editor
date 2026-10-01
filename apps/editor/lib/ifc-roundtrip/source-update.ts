import * as WebIFC from 'web-ifc'

export type RoundtripGraph = {
  nodes: Record<string, Record<string, unknown>>
  rootNodeIds: string[]
  collections?: unknown
  materials?: unknown
  installedPlugins?: unknown
}

export type SourceUpdateReport = {
  sourceSchema: string
  sourceEntityCount: number
  exportedEntityCount: number
  addedEntityCount: number
  editorDerivedNodeCount?: number
  changedNodes: {
    nodeId: string
    globalId: string
    expressID: number
    fields: string[]
    updatedExpressIDs: number[]
    clonedExpressIDs: number[]
  }[]
  warnings: string[]
}

type IfcLine = ReturnType<WebIFC.IfcAPI['GetLine']>
type Update = {
  nodeId: string
  globalId: string
  wall: IfcLine
  fields: string[]
  nameField?: 'Name' | 'LongName'
  name?: string
  height?: number
  solid?: IfcLine
  body?: IfcLine
  shape?: IfcLine
  styles?: IfcLine[]
  representations?: IfcLine[]
  shapeUsers?: Set<number>
  solidUsers?: Set<number>
  geometryMode?: 'private' | 'shared-shape' | 'shared-solid'
}

function fail(message: string): never {
  throw new Error(`IFC source export: ${message}`)
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid graph record')
  return value as Record<string, unknown>
}
const stable = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
    .join(',')}}`
}
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b)
const comparableNode = (node: Record<string, unknown>): Record<string, unknown> => {
  const copy = { ...node }
  if (node.type === 'site' && node.metadata && typeof node.metadata === 'object') {
    const metadata = { ...record(node.metadata) }
    delete metadata.ifcRoundtrip
    copy.metadata = metadata
  }
  return copy
}
const cloneLine = (line: IfcLine, expressID: number): IfcLine =>
  Object.assign(Object.create(Object.getPrototypeOf(line)), line, { expressID })
const near = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b))

export async function exportEditedSource({
  source,
  baseline,
  current,
  wasmPath,
  editorDerivedNodeIds = [],
}: {
  source: Uint8Array
  baseline: RoundtripGraph
  current: RoundtripGraph
  wasmPath: string
  editorDerivedNodeIds?: string[]
}): Promise<{ bytes: Uint8Array; report: SourceUpdateReport }> {
  if (!(source instanceof Uint8Array) || !source.byteLength) fail('missing original IFC bytes')
  for (const graph of [baseline, current]) {
    record(graph)
    record(graph.nodes)
    if (!Array.isArray(graph.rootNodeIds)) fail('invalid root node identities')
  }
  const oldIds = Object.keys(baseline.nodes).sort()
  const newIds = Object.keys(current.nodes).sort()
  if (!same(oldIds, newIds)) fail('node additions or deletions are unsupported')
  if (
    !Array.isArray(editorDerivedNodeIds) ||
    editorDerivedNodeIds.some((id) => typeof id !== 'string')
  )
    fail('invalid editor-derived node identities')
  const derivedIds = new Set(editorDerivedNodeIds)
  if (
    derivedIds.size !== editorDerivedNodeIds.length ||
    editorDerivedNodeIds.some((id) => !baseline.nodes[id])
  )
    fail('duplicate or unknown editor-derived node identity')
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    if (
      key !== 'nodes' &&
      !same((baseline as Record<string, unknown>)[key], (current as Record<string, unknown>)[key])
    ) {
      fail(`unsupported graph change: ${key}`)
    }
  }

  const api = new WebIFC.IfcAPI()
  let model: number | undefined
  let initialized = false
  try {
    api.SetWasmPath(wasmPath, true)
    await api.Init()
    initialized = true
    model = api.OpenModel(source.slice())
    if (model < 0) fail('could not open original IFC')
    const modelID = model
    const schema = api.GetModelSchema(modelID)
    if (schema !== 'IFC4') fail(`unsupported schema ${schema}; IFC4 is required`)
    const allIds = api.GetAllLines(modelID)
    const lines = new Map<number, IfcLine>()
    const globalIds = new Map<string, number>()
    let nextID = 1
    for (let index = 0; index < allIds.size(); index++) {
      const id = allIds.get(index)
      nextID = Math.max(nextID, id + 1)
      const line = api.GetLine(modelID, id, false)
      lines.set(id, line)
      const guid = line.GlobalId?.value
      if (typeof guid === 'string') {
        if (globalIds.has(guid)) fail(`duplicate source GlobalId ${guid}`)
        globalIds.set(guid, id)
      }
    }
    const references = new Map<number, { line: IfcLine; attribute: string }[]>()
    const collectReferences = (value: unknown, owner: IfcLine, attribute: string): void => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) {
        for (const child of value) collectReferences(child, owner, attribute)
        return
      }
      const object = value as Record<string, unknown>
      if (object.type === 5 && typeof object.value === 'number') {
        const users = references.get(object.value) ?? []
        users.push({ line: owner, attribute })
        references.set(object.value, users)
        return
      }
      for (const child of Object.values(object)) collectReferences(child, owner, attribute)
    }
    for (const line of lines.values()) {
      for (const [attribute, value] of Object.entries(line))
        collectReferences(value, line, attribute)
    }
    const get = (handle: { value: number } | null | undefined): IfcLine => {
      const line = handle && lines.get(handle.value)
      if (!line) fail('missing source geometry or placement reference')
      return line
    }
    const direction = (
      handle: { value: number } | null | undefined,
      fallback?: [number, number, number],
    ): [number, number, number] => {
      if (!handle) {
        if (fallback) return fallback
        fail('missing source direction')
      }
      const line = get(handle)
      if (line.type !== WebIFC.IFCDIRECTION || line.DirectionRatios.length !== 3)
        fail('unsupported direction')
      const values = line.DirectionRatios.map((v: { value: number }) => Number(v.value))
      const norm = Math.hypot(...values)
      if (!Number.isFinite(norm) || norm < 1e-10) fail('invalid source direction')
      return values.map((v: number) => v / norm) as [number, number, number]
    }
    const uprightAxis = (axis: IfcLine): void => {
      if (axis.type !== WebIFC.IFCAXIS2PLACEMENT3D) fail('height requires a rigid 3D placement')
      const z = direction(axis.Axis, [0, 0, 1])
      const x = direction(axis.RefDirection, [1, 0, 0])
      if (!near(z[0], 0) || !near(z[1], 0) || !near(z[2], 1) || !near(x[2], 0)) {
        fail('height requires an upright, orthogonal source placement')
      }
      const point = get(axis.Location)
      if (
        point.type !== WebIFC.IFCCARTESIANPOINT ||
        point.Coordinates.length !== 3 ||
        point.Coordinates.some((v: { value: number }) => !Number.isFinite(Number(v.value)))
      )
        fail('invalid source placement origin')
    }
    const uprightPlacement = (wall: IfcLine): void => {
      let handle = wall.ObjectPlacement
      const visited = new Set<number>()
      if (!handle) fail('height requires a source placement')
      while (handle) {
        if (visited.has(handle.value)) fail('cyclic source placement')
        visited.add(handle.value)
        const placement = get(handle)
        if (placement.type !== WebIFC.IFCLOCALPLACEMENT) fail('unsupported source placement')
        uprightAxis(get(placement.RelativePlacement))
        handle = placement.PlacementRelTo
      }
    }
    const unitFactor = (): number => {
      const projects = [...lines.values()].filter((line) => line.type === WebIFC.IFCPROJECT)
      if (projects.length !== 1) fail('height requires one project unit assignment')
      const units = get(projects[0].UnitsInContext)
      if (units.type !== WebIFC.IFCUNITASSIGNMENT) fail('missing source length units')
      const lengthUnits = units.Units.map(get).filter(
        (unit: IfcLine) => unit.UnitType?.value === 'LENGTHUNIT',
      )
      if (lengthUnits.length !== 1) fail('height requires one unambiguous source length unit')
      const unit = lengthUnits[0]
      if (unit.type !== WebIFC.IFCSIUNIT || unit.Name?.value !== 'METRE')
        fail('height requires SI metre source units')
      const prefixes: Record<string, number> = {
        EXA: 1e18,
        PETA: 1e15,
        TERA: 1e12,
        GIGA: 1e9,
        MEGA: 1e6,
        KILO: 1e3,
        HECTO: 1e2,
        DECA: 1e1,
        DECI: 1e-1,
        CENTI: 1e-2,
        MILLI: 1e-3,
        MICRO: 1e-6,
        NANO: 1e-9,
        PICO: 1e-12,
        FEMTO: 1e-15,
        ATTO: 1e-18,
      }
      const prefix = unit.Prefix?.value
      if (prefix == null) return 1
      const factor = prefixes[prefix]
      if (factor === undefined) fail('unsupported SI unit prefix')
      return factor
    }
    const rejectQuantities = (wall: IfcLine): void => {
      for (const relation of lines.values()) {
        if (
          !Array.isArray(relation.RelatedObjects) ||
          !relation.RelatedObjects.some((ref: { value: number }) => ref.value === wall.expressID)
        )
          continue
        if (relation.type === WebIFC.IFCRELDEFINESBYPROPERTIES) {
          const property = get(relation.RelatingPropertyDefinition)
          if (property.type === WebIFC.IFCELEMENTQUANTITY)
            fail(`wall #${wall.expressID} has explicit quantities; height would make them stale`)
        }
        if (relation.type === WebIFC.IFCRELDEFINESBYTYPE) {
          const type = get(relation.RelatingType)
          if (
            (type.HasPropertySets ?? []).some(
              (ref: { value: number }) => get(ref).type === WebIFC.IFCELEMENTQUANTITY,
            )
          ) {
            fail(`wall #${wall.expressID} has type quantities; height would make them stale`)
          }
        }
      }
    }
    const prepareHeight = (update: Update, old: Record<string, unknown>, height: unknown): void => {
      if (
        old.type !== 'wall' ||
        ![WebIFC.IFCWALL, WebIFC.IFCWALLSTANDARDCASE].includes(update.wall.type)
      )
        fail('height is only supported for source walls')
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)
        fail('wall height must be a positive finite number in metres')
      if (typeof old.height !== 'number' || !Number.isFinite(old.height) || old.height <= 0)
        fail('missing positive baseline wall height')
      for (const point of [old.start, old.end]) {
        if (
          !Array.isArray(point) ||
          point.length !== 2 ||
          point.some((v) => typeof v !== 'number' || !Number.isFinite(v))
        )
          fail('height requires a straight wall baseline')
      }
      const start = old.start as [number, number],
        end = old.end as [number, number]
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 1e-7)
        fail('height requires a nonzero straight wall axis')
      uprightPlacement(update.wall)
      const shape = get(update.wall.Representation)
      if (shape.type !== WebIFC.IFCPRODUCTDEFINITIONSHAPE) fail('unsupported wall representation')
      const representations = shape.Representations.map(get)
      if (
        representations.some(
          (rep: IfcLine) => !['Body', 'Axis'].includes(rep.RepresentationIdentifier?.value),
        )
      )
        fail('height edits with additional source representations are unsupported')
      const bodies = representations.filter(
        (rep: IfcLine) => rep.RepresentationIdentifier?.value === 'Body',
      )
      if (
        bodies.length !== 1 ||
        bodies[0].type !== WebIFC.IFCSHAPEREPRESENTATION ||
        bodies[0].Items.length !== 1
      )
        fail('height requires one direct Body extrusion')
      const body = bodies[0]
      if (body.RepresentationType?.value !== 'SweptSolid')
        fail('height requires a SweptSolid Body representation')
      const solid = get(body.Items[0])
      if (solid.type !== WebIFC.IFCEXTRUDEDAREASOLID)
        fail(
          'mapped or boolean geometry height edits are unsupported; one direct extrusion is required',
        )
      if (solid.Position) uprightAxis(get(solid.Position))
      const extrusion = direction(solid.ExtrudedDirection)
      if (
        extrusion.length !== 3 ||
        !near(extrusion[0], 0) ||
        !near(extrusion[1], 0) ||
        !near(extrusion[2], 1)
      )
        fail('height requires a vertical extrusion')
      const axes = representations.filter(
        (rep: IfcLine) => rep.RepresentationIdentifier?.value === 'Axis',
      )
      const profile = get(solid.SweptArea)
      if (axes.length) {
        if (axes.length !== 1 || axes[0].Items.length !== 1)
          fail('height requires one straight source wall axis')
        const axis = get(axes[0].Items[0])
        if (axis.type !== WebIFC.IFCPOLYLINE || axis.Points.length !== 2)
          fail('curved source wall height edits are unsupported')
        const points = axis.Points.map((ref: { value: number }) => {
          const point = get(ref)
          if (point.type !== WebIFC.IFCCARTESIANPOINT || ![2, 3].includes(point.Coordinates.length))
            fail('invalid source wall axis point')
          const coordinates = point.Coordinates.map((v: { value: number }) => Number(v.value))
          if (coordinates.some((v: number) => !Number.isFinite(v)))
            fail('invalid source wall axis point')
          return coordinates
        })
        if (
          !near(points[0][2] ?? 0, points[1][2] ?? 0) ||
          Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1]) < 1e-7
        )
          fail('height requires a horizontal straight source wall axis')
      } else if (profile.type !== WebIFC.IFCRECTANGLEPROFILEDEF)
        fail('height requires a straight source wall axis or rectangle profile')
      const factor = unitFactor()
      const depth = Number(solid.Depth?.value)
      if (!Number.isFinite(depth) || depth <= 0 || !near(depth * factor, old.height))
        fail('source extrusion depth does not match the baseline wall height')
      rejectQuantities(update.wall)
      const geometryIds = new Set([
        solid.expressID,
        shape.expressID,
        ...representations.map((rep: IfcLine) => rep.expressID),
      ])
      for (const line of lines.values()) {
        if (
          Array.isArray(line.AssignedItems) &&
          line.AssignedItems.some((ref: { value: number }) => geometryIds.has(ref.value))
        ) {
          fail('height edit has presentation layer attachments that cannot be copied safely')
        }
      }
      const shapeUsers = new Set<number>()
      for (const ref of references.get(shape.expressID) ?? []) {
        if (
          ref.attribute !== 'Representation' ||
          ref.line.Representation?.value !== shape.expressID ||
          !('ObjectPlacement' in ref.line) ||
          !ref.line.GlobalId
        )
          fail('unsupported source product-shape ownership or inverse attachment')
        shapeUsers.add(ref.line.expressID)
      }
      if (!shapeUsers.has(update.wall.expressID)) fail('source shape has no matching product owner')
      for (const representation of representations) {
        const owners = references.get(representation.expressID) ?? []
        if (
          owners.length !== 1 ||
          owners[0]!.line.expressID !== shape.expressID ||
          owners[0]!.attribute !== 'Representations'
        )
          fail('unsupported source representation ownership or inverse attachment')
      }
      const solidUsers = new Set<number>()
      for (const ref of references.get(solid.expressID) ?? []) {
        if (ref.line.type === WebIFC.IFCSTYLEDITEM && ref.attribute === 'Item') continue
        const owner = ref.line
        if (
          owner.type !== WebIFC.IFCSHAPEREPRESENTATION ||
          ref.attribute !== 'Items' ||
          owner.RepresentationIdentifier?.value !== 'Body' ||
          owner.RepresentationType?.value !== 'SweptSolid' ||
          owner.Items.length !== 1 ||
          owner.Items[0].value !== solid.expressID
        )
          fail('unsupported source extrusion ownership or inverse attachment')
        const representationOwners = references.get(owner.expressID) ?? []
        if (
          representationOwners.length !== 1 ||
          representationOwners[0]!.attribute !== 'Representations' ||
          representationOwners[0]!.line.type !== WebIFC.IFCPRODUCTDEFINITIONSHAPE
        )
          fail('shared extrusion requires independently owned Body representations')
        const productShape = representationOwners[0]!.line
        const productUsers = references.get(productShape.expressID) ?? []
        if (
          !productUsers.length ||
          productUsers.some(
            (user) =>
              user.attribute !== 'Representation' ||
              user.line.Representation?.value !== productShape.expressID ||
              !('ObjectPlacement' in user.line) ||
              !user.line.GlobalId,
          )
        )
          fail(
            'shared extrusion requires actual product owners without unsupported inverse attachments',
          )
        solidUsers.add(owner.expressID)
      }
      if (!solidUsers.has(body.expressID)) fail('source extrusion has no matching Body owner')
      const nativeHeight = height / factor
      if (!Number.isFinite(nativeHeight) || nativeHeight <= 0)
        fail('wall height cannot be represented in source units')
      update.height = nativeHeight
      update.solid = solid
      update.body = body
      update.shape = shape
      update.representations = representations
      update.shapeUsers = shapeUsers
      update.solidUsers = solidUsers
      update.styles = [...lines.values()].filter(
        (line) => line.type === WebIFC.IFCSTYLEDITEM && line.Item?.value === solid.expressID,
      )
    }

    const updates: Update[] = []
    const graphGuids = new Set<string>()
    const sourceNode = (node: Record<string, unknown>): IfcLine => {
      const metadata = record(node.metadata)
      const guid = metadata.globalId
      const hint = metadata.expressID
      if (typeof guid !== 'string' || typeof hint !== 'number' || globalIds.get(guid) !== hint)
        fail('editor-derived zone references a node without valid source identity')
      const line = lines.get(hint)
      if (!line) fail('editor-derived zone references an unknown source product')
      return line
    }
    for (const nodeId of oldIds) {
      const old = record(baseline.nodes[nodeId])
      const edited = record(current.nodes[nodeId])
      if (old.id !== nodeId || edited.id !== nodeId)
        fail(`node identity differs from its graph key: ${nodeId}`)
      const metadata = record(old.metadata)
      const editedMetadata = record(edited.metadata)
      if (derivedIds.has(nodeId)) {
        if (
          old.type !== 'zone' ||
          old.autoFromWalls !== true ||
          'globalId' in metadata ||
          'expressID' in metadata
        )
          fail(`invalid editor-derived zone ${nodeId}`)
        if (!same(old, edited)) fail(`edits to editor-derived zone ${nodeId} are unsupported`)
        const parent = typeof old.parentId === 'string' ? baseline.nodes[old.parentId] : undefined
        if (parent?.type !== 'level' || sourceNode(parent).type !== WebIFC.IFCBUILDINGSTOREY)
          fail(`editor-derived zone ${nodeId} requires a source level parent`)
        const boundaries = old.boundaryWallIds
        if (
          !Array.isArray(boundaries) ||
          boundaries.length < 3 ||
          new Set(boundaries).size !== boundaries.length
        )
          fail(`invalid editor-derived zone boundary on ${nodeId}`)
        for (const boundaryId of boundaries) {
          const boundary = typeof boundaryId === 'string' ? baseline.nodes[boundaryId] : undefined
          if (
            boundary?.type !== 'wall' ||
            boundary.parentId !== old.parentId ||
            ![WebIFC.IFCWALL, WebIFC.IFCWALLSTANDARDCASE].includes(sourceNode(boundary).type)
          )
            fail(`editor-derived zone ${nodeId} requires source wall boundaries on its level`)
        }
        continue
      }
      const guid = metadata.globalId
      if (
        typeof guid !== 'string' ||
        !guid ||
        typeof metadata.expressID !== 'number' ||
        !Number.isInteger(metadata.expressID)
      )
        fail(`missing source identity on ${nodeId}`)
      if (graphGuids.has(guid)) fail(`duplicate graph GlobalId ${guid}`)
      graphGuids.add(guid)
      if (editedMetadata.globalId !== guid || editedMetadata.expressID !== metadata.expressID)
        fail(`changed or missing source identity on ${nodeId}`)
      const expressID = globalIds.get(guid)
      if (expressID === undefined || expressID !== metadata.expressID)
        fail(`source GlobalId and expressID do not match on ${nodeId}`)
      const wall = lines.get(expressID)!
      if (
        typeof metadata.ifcType === 'string' &&
        metadata.ifcType.toUpperCase() !== api.GetNameFromTypeCode(wall.type).toUpperCase()
      )
        fail(`source IFC type does not match on ${nodeId}`)
      const before = comparableNode(old),
        after = comparableNode(edited)
      const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((key) => !same(before[key], after[key]))
        .sort()
      if (!fields.length) continue
      const unsupported = fields.filter((key) => key !== 'name' && key !== 'height')
      if (unsupported.length) fail(`unsupported changes on ${nodeId}: ${unsupported.join(', ')}`)
      const update: Update = { nodeId, globalId: guid, wall, fields }
      if (fields.includes('name')) {
        if (
          typeof edited.name !== 'string' ||
          !edited.name.length ||
          edited.name.length > 255 ||
          edited.name.includes('\0')
        )
          fail('name must be a nonempty label of at most 255 characters')
        const field = wall.type === WebIFC.IFCSPACE && wall.LongName?.value ? 'LongName' : 'Name'
        const sourceName = wall[field]?.value
        if (sourceName && sourceName !== old.name)
          fail(`source name does not match the baseline on ${nodeId}`)
        update.nameField = field
        update.name = edited.name
      }
      if (fields.includes('height')) prepareHeight(update, old, edited.height)
      updates.push(update)
    }

    const report: SourceUpdateReport = {
      sourceSchema: schema,
      sourceEntityCount: allIds.size(),
      exportedEntityCount: allIds.size(),
      addedEntityCount: 0,
      editorDerivedNodeCount: derivedIds.size,
      changedNodes: [],
      warnings: [],
    }
    if (!updates.length) return { bytes: source.slice(), report }
    // Reserve one original shape owner across the complete transaction so copying never leaves an orphan.
    const remainingShapeUsers = new Map<number, Set<number>>()
    const remainingSolidUsers = new Map<number, Set<number>>()
    for (const update of updates) {
      if (!update.shape || !update.body || !update.solid) continue
      const shapeUsers =
        remainingShapeUsers.get(update.shape.expressID) ?? new Set(update.shapeUsers)
      const solidUsers =
        remainingSolidUsers.get(update.solid.expressID) ?? new Set(update.solidUsers)
      remainingShapeUsers.set(update.shape.expressID, shapeUsers)
      remainingSolidUsers.set(update.solid.expressID, solidUsers)
      if (shapeUsers.size > 1) {
        update.geometryMode = 'shared-shape'
        shapeUsers.delete(update.wall.expressID)
      } else if (solidUsers.size > 1) {
        update.geometryMode = 'shared-solid'
        solidUsers.delete(update.body.expressID)
      } else update.geometryMode = 'private'
    }
    for (const update of updates) {
      const wall = cloneLine(update.wall, update.wall.expressID)
      const clonedExpressIDs: number[] = []
      const updatedExpressIDs: number[] = []
      let writeWall = Boolean(update.nameField)
      if (update.nameField) wall[update.nameField] = new WebIFC.IFC4.IfcLabel(update.name!)
      const writeClone = (line: IfcLine): void => {
        api.WriteLine(modelID, line)
        clonedExpressIDs.push(line.expressID)
      }
      if (update.solid && update.body && update.shape) {
        const solid = cloneLine(
          update.solid,
          update.geometryMode === 'private' ? update.solid.expressID : nextID++,
        )
        solid.Depth = new WebIFC.IFC4.IfcPositiveLengthMeasure(update.height!)
        if (update.geometryMode === 'private') {
          api.WriteLine(modelID, solid)
          updatedExpressIDs.push(solid.expressID)
        } else {
          writeClone(solid)
          if (update.geometryMode === 'shared-shape') {
            const representationHandles: WebIFC.Handle<unknown>[] = []
            for (const oldRepresentation of update.representations ?? []) {
              const representation = cloneLine(oldRepresentation, nextID++)
              if (oldRepresentation.expressID === update.body.expressID)
                representation.Items = [new WebIFC.Handle(solid.expressID)]
              writeClone(representation)
              representationHandles.push(new WebIFC.Handle(representation.expressID))
            }
            const shape = cloneLine(update.shape, nextID++)
            shape.Representations = representationHandles
            writeClone(shape)
            wall.Representation = new WebIFC.Handle(shape.expressID)
            writeWall = true
          } else {
            const body = cloneLine(update.body, update.body.expressID)
            body.Items = [new WebIFC.Handle(solid.expressID)]
            api.WriteLine(modelID, body)
            updatedExpressIDs.push(body.expressID)
          }
          for (const oldStyle of update.styles ?? []) {
            const style = cloneLine(oldStyle, nextID++)
            style.Item = new WebIFC.Handle(solid.expressID)
            writeClone(style)
          }
        }
      }
      if (writeWall) {
        api.WriteLine(modelID, wall)
        updatedExpressIDs.push(wall.expressID)
      }
      report.changedNodes.push({
        nodeId: update.nodeId,
        globalId: update.globalId,
        expressID: wall.expressID,
        fields: update.fields,
        updatedExpressIDs: updatedExpressIDs.sort((a, b) => a - b),
        clonedExpressIDs,
      })
      report.addedEntityCount += clonedExpressIDs.length
    }
    report.exportedEntityCount = api.GetAllLines(modelID).size()
    if (report.exportedEntityCount !== report.sourceEntityCount + report.addedEntityCount)
      fail('unexpected entity count after source updates')
    return { bytes: api.SaveModel(modelID), report }
  } finally {
    if (model !== undefined && model >= 0) api.CloseModel(model)
    if (initialized) api.Dispose()
  }
}
