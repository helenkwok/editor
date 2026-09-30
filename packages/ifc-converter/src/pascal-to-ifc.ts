/**
 * Bounded Pascal → IFC4 writer.
 *
 * Emits the subset `convertIfcToPascal` reads back into native nodes: site /
 * building / storey, IfcWallStandardCase with an Axis polyline and a
 * rectangular extrusion (YDim = thickness, depth = height), door and window
 * via IfcRelVoidsElement + IfcRelFillsElement, and IfcSpace from a swept
 * profile. Plan mapping matches current main (`planDepthSign = -1`): IFC
 * (X, Y) is the Pascal plan point (x, z) with Y = −z. Each Pascal level is
 * its own IfcBuildingStorey: the storey placement and Elevation attribute
 * carry that elevation once, and wall and space origins stay in the storey
 * frame. Curtain-wall authoring is recorded as a loss and leaves as a
 * standard wall.
 */
import {
  type AnyNode,
  type AnyNodeId,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  type DoorNode,
  type LevelNode,
  type WallNode,
  type WindowNode,
  type ZoneNode,
} from '@pascal-app/core'

/** Scene graph shape accepted by the writer (same as `PascalSceneGraph`). */
export interface PascalIfcExportScene {
  nodes: Record<string, AnyNode> | Record<AnyNodeId, AnyNode>
  rootNodeIds?: readonly string[]
}

const GUID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$'

export type PlanPoint = readonly [number, number]

export interface IfcExportLoss {
  pascalId: string
  globalId: string
  field: string
  note: string
}

export interface IfcExportAssignment {
  pascalId: string
  globalId: string
  kind: string
}

export interface ConvertPascalToIfcResult {
  /** IFC4 STEP text. */
  ifc: string
  assignments: IfcExportAssignment[]
  losses: IfcExportLoss[]
}

export interface ConvertPascalToIfcOptions {
  fileName?: string
}

/**
 * Pascal plan [x, z] → IFC (X, Y, Z). Seen from above, IFC north (+Y) is
 * Pascal −Z, so IFC Y = −Pascal z. Inverse of the `plan` helper in
 * `tests/handedness.test.ts`: (x, z) = (X, −Y).
 *
 * `elevation` is the Z of this point. A placement whose parent is already
 * the storey passes 0: the storey placement carries the level elevation.
 */
export function pascalPlanToIfc(point: PlanPoint, elevation = 0): [number, number, number] {
  return [point[0], -point[1], elevation]
}

/** IFC plan (X, Y) → Pascal plan [x, z]. Same mapping as handedness.test.ts. */
export function ifcPlanToPascal(ifcX: number, ifcY: number): [number, number] {
  return [ifcX, -ifcY]
}

function wallLength(wall: Pick<WallNode, 'start' | 'end'>): number {
  const dx = wall.end[0] - wall.start[0]
  const dz = wall.end[1] - wall.start[1]
  return Math.hypot(dx, dz)
}

function assertExportable(walls: WallNode[]): void {
  for (const wall of walls) {
    const len = wallLength(wall)
    if (!Number.isFinite(len) || len <= 1e-3) {
      throw new Error(`rejected zero-length wall ${wall.id}`)
    }
  }
}

export function ifcGuid(seed: string): string {
  let h = 2166136261
  let out = ''
  for (let i = 0; i < 22; i++) {
    const code = seed.charCodeAt(i % seed.length) || 1
    h ^= Math.imul(code + i * 131, 16777619)
    h >>>= 0
    out += GUID_ALPHABET[h % 64]!
  }
  return out
}

function guidOf(id: string, metadata?: Record<string, unknown>): string {
  const existing = metadata?.globalId
  if (typeof existing === 'string' && existing.length === 22) return existing
  return ifcGuid(id)
}

function num(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`non-finite coordinate ${value}`)
  const text = value.toFixed(6)
  return text === '-0.000000' ? '0.000000' : text
}

function stepString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

class Step {
  private readonly lines: string[] = []
  private n = 0

  add(body: string): number {
    const id = ++this.n
    this.lines.push(`#${id}=${body};`)
    return id
  }

  ref(id: number): string {
    return `#${id}`
  }

  serialize(name: string): string {
    const body = this.lines.join('\n')
    return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Pascal IFC4 export'),'2;1');
FILE_NAME(${stepString(name)},'${new Date().toISOString().slice(0, 19)}',('Pascal'),('Pascal'),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
${body}
ENDSEC;
END-ISO-10303-21;
`
  }
}

function point3(step: Step, x: number, y: number, z: number): number {
  return step.add(`IFCCARTESIANPOINT((${num(x)},${num(y)},${num(z)}))`)
}

function point2(step: Step, x: number, y: number): number {
  return step.add(`IFCCARTESIANPOINT((${num(x)},${num(y)}))`)
}

function direction(step: Step, x: number, y: number, z: number): number {
  return step.add(`IFCDIRECTION((${num(x)},${num(y)},${num(z)}))`)
}

function placement3(
  step: Step,
  origin: [number, number, number],
  ref: [number, number, number] | null,
  parent: number | null,
): number {
  const loc = point3(step, origin[0], origin[1], origin[2])
  const axis = direction(step, 0, 0, 1)
  const refId = ref ? direction(step, ref[0], ref[1], ref[2]) : null
  const axis2 = step.add(
    `IFCAXIS2PLACEMENT3D(${step.ref(loc)},${step.ref(axis)},${refId ? step.ref(refId) : '$'})`,
  )
  return step.add(`IFCLOCALPLACEMENT(${parent ? step.ref(parent) : '$'},${step.ref(axis2)})`)
}

function wallSolid(
  step: Step,
  length: number,
  thickness: number,
  height: number,
  axisCtx: number,
  bodyCtx: number,
): number {
  const p0 = point2(step, 0, 0)
  const p1 = point2(step, length, 0)
  const poly = step.add(`IFCPOLYLINE((${step.ref(p0)},${step.ref(p1)}))`)
  const axisRep = step.add(
    `IFCSHAPEREPRESENTATION(${step.ref(axisCtx)},'Axis','Curve2D',(${step.ref(poly)}))`,
  )

  const centre = point2(step, length / 2, 0)
  const xDir = step.add(`IFCDIRECTION((${num(1)},${num(0)}))`)
  const profilePos = step.add(`IFCAXIS2PLACEMENT2D(${step.ref(centre)},${step.ref(xDir)})`)
  const rect = step.add(
    `IFCRECTANGLEPROFILEDEF(.AREA.,$,${step.ref(profilePos)},${num(length)},${num(thickness)})`,
  )
  const solidOrigin = point3(step, 0, 0, 0)
  const solidAxis = direction(step, 0, 0, 1)
  const solidX = direction(step, 1, 0, 0)
  const solidPos = step.add(
    `IFCAXIS2PLACEMENT3D(${step.ref(solidOrigin)},${step.ref(solidAxis)},${step.ref(solidX)})`,
  )
  const extrude = direction(step, 0, 0, 1)
  const solid = step.add(
    `IFCEXTRUDEDAREASOLID(${step.ref(rect)},${step.ref(solidPos)},${step.ref(extrude)},${num(height)})`,
  )
  const bodyRep = step.add(
    `IFCSHAPEREPRESENTATION(${step.ref(bodyCtx)},'Body','SweptSolid',(${step.ref(solid)}))`,
  )
  return step.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${step.ref(axisRep)},${step.ref(bodyRep)}))`)
}

function spaceShape(step: Step, zone: ZoneNode, bodyCtx: number): number {
  const local = zone.polygon.map((point) => pascalPlanToIfc(point, 0))
  const ids = local.map((point) => point2(step, point[0], point[1]))
  const closed = [...ids, ids[0]!]
  const poly = step.add(`IFCPOLYLINE((${closed.map((id) => step.ref(id)).join(',')}))`)
  const profile = step.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${step.ref(poly)})`)
  const origin = point3(step, 0, 0, 0)
  const axis = direction(step, 0, 0, 1)
  const ref = direction(step, 1, 0, 0)
  const pos = step.add(
    `IFCAXIS2PLACEMENT3D(${step.ref(origin)},${step.ref(axis)},${step.ref(ref)})`,
  )
  const up = direction(step, 0, 0, 1)
  const solid = step.add(
    `IFCEXTRUDEDAREASOLID(${step.ref(profile)},${step.ref(pos)},${step.ref(up)},${num(zone.ceilingHeight)})`,
  )
  const body = step.add(
    `IFCSHAPEREPRESENTATION(${step.ref(bodyCtx)},'Body','SweptSolid',(${step.ref(solid)}))`,
  )
  return step.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${step.ref(body)}))`)
}

function openingPlacement(step: Step, wallPlacement: number, along: number, sill: number): number {
  return placement3(step, [along, 0, sill], [1, 0, 0], wallPlacement)
}

function levelElevation(level: LevelNode): number {
  const meta = level.metadata?.elevation
  if (typeof meta === 'number' && Number.isFinite(meta)) return meta
  return level.baseElevation
}

function openingAlong(opening: DoorNode | WindowNode): number {
  const position = opening.position
  if (typeof position === 'number') return position
  return position[0]
}

function windowSill(window: WindowNode): number {
  const meta = window.metadata?.sillHeight
  if (typeof meta === 'number' && Number.isFinite(meta)) return meta
  return window.position[1] - window.height / 2
}

function owningLevelId(
  node: { id: string; type: string; parentId: string | null },
  levelIds: ReadonlySet<string>,
  fallbackLevelId: string | null,
): string {
  if (node.parentId && levelIds.has(node.parentId)) return node.parentId
  if (fallbackLevelId) return fallbackLevelId
  throw new Error(`${node.type} ${node.id} is not parented to a level`)
}

/**
 * Write a bounded IFC4 STEP file from a Pascal scene graph.
 *
 * Only sites, buildings, levels, walls, doors, windows, and zones are
 * emitted. Other node kinds are skipped. Every level is one storey; a wall
 * or zone whose parent is not one of those levels is rejected, unless the
 * scene has no levels, in which case a single Level 0 is synthesized.
 * Curtain-wall configuration on a wall is a recorded loss — the wall is
 * written as IfcWallStandardCase.
 */
export function convertPascalToIfc(
  scene: PascalIfcExportScene,
  options: ConvertPascalToIfcOptions = {},
): ConvertPascalToIfcResult {
  const nodes = Object.values(scene.nodes)
  const walls = nodes.filter((node): node is WallNode => node.type === 'wall')
  assertExportable(walls)

  const doors = nodes.filter((node): node is DoorNode => node.type === 'door')
  const windows = nodes.filter((node): node is WindowNode => node.type === 'window')
  const zones = nodes.filter((node): node is ZoneNode => node.type === 'zone')
  const siteNode = nodes.find((node) => node.type === 'site')
  const buildingNode = nodes.find((node) => node.type === 'building')

  const realLevels = nodes.filter((node): node is LevelNode => node.type === 'level')
  const synthesized = realLevels.length === 0
  const levels: LevelNode[] = synthesized
    ? [
        {
          object: 'node',
          id: 'level_export',
          type: 'level',
          name: 'Level 0',
          parentId: null,
          visible: true,
          baseElevation: 0,
          level: 0,
          children: [],
          metadata: {},
        } satisfies LevelNode,
      ]
    : realLevels
  const levelIds = new Set(levels.map((level) => level.id))
  const fallbackLevelId = synthesized ? levels[0]!.id : null
  const levelIdByElement = new Map<string, string>()
  for (const node of [...walls, ...zones]) {
    levelIdByElement.set(node.id, owningLevelId(node, levelIds, fallbackLevelId))
  }

  const step = new Step()
  const assignments: IfcExportAssignment[] = []
  const losses: IfcExportLoss[] = []

  const person = step.add(`IFCPERSON($,'Pascal',$,$,$,$,$,$)`)
  const org = step.add(`IFCORGANIZATION($,'Pascal',$,$,$)`)
  const personOrg = step.add(`IFCPERSONANDORGANIZATION(${step.ref(person)},${step.ref(org)},$)`)
  const app = step.add(`IFCAPPLICATION(${step.ref(org)},'1','Pascal','pascal')`)
  const owner = step.add(
    `IFCOWNERHISTORY(${step.ref(personOrg)},${step.ref(app)},$,.ADDED.,$,$,$,0)`,
  )

  const metre = step.add(`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`)
  const area = step.add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`)
  const volume = step.add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`)
  const angle = step.add(`IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)`)
  const units = step.add(
    `IFCUNITASSIGNMENT((${step.ref(metre)},${step.ref(area)},${step.ref(volume)},${step.ref(angle)}))`,
  )

  const worldOrigin = point3(step, 0, 0, 0)
  const worldZ = direction(step, 0, 0, 1)
  const worldX = direction(step, 1, 0, 0)
  const worldAxis = step.add(
    `IFCAXIS2PLACEMENT3D(${step.ref(worldOrigin)},${step.ref(worldZ)},${step.ref(worldX)})`,
  )
  const modelCtx = step.add(
    `IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${step.ref(worldAxis)},${step.ref(worldX)})`,
  )
  const axisCtx = step.add(
    `IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,${step.ref(modelCtx)},$,.GRAPH_VIEW.,$)`,
  )
  const bodyCtx = step.add(
    `IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${step.ref(modelCtx)},$,.MODEL_VIEW.,$)`,
  )

  const projectGuid = ifcGuid('project')
  const project = step.add(
    `IFCPROJECT('${projectGuid}',${step.ref(owner)},'Pascal',$,$,$,$,(${step.ref(modelCtx)}),${step.ref(units)})`,
  )

  const sitePlace = placement3(step, [0, 0, 0], [1, 0, 0], null)
  const siteGuid = guidOf(siteNode?.id ?? 'site', siteNode?.metadata)
  const site = step.add(
    `IFCSITE('${siteGuid}',${step.ref(owner)},${stepString(siteNode?.name ?? 'Site')},$,$,${step.ref(sitePlace)},$,'Site',.ELEMENT.,$,$,$,$,$)`,
  )
  const buildingPlace = placement3(step, [0, 0, 0], [1, 0, 0], sitePlace)
  const buildingGuid = guidOf(buildingNode?.id ?? 'building', buildingNode?.metadata)
  const building = step.add(
    `IFCBUILDING('${buildingGuid}',${step.ref(owner)},${stepString(buildingNode?.name ?? 'Building')},$,$,${step.ref(buildingPlace)},$,'Building',.ELEMENT.,$,$,$)`,
  )
  type EmittedStorey = {
    levelId: string
    place: number
    express: number
    contained: number[]
  }
  const storeyByLevel = new Map<string, EmittedStorey>()
  const storeyExpressIds: number[] = []
  for (const level of levels) {
    const elevation = levelElevation(level)
    const place = placement3(step, [0, 0, elevation], [1, 0, 0], buildingPlace)
    const storeyGuid = guidOf(level.id, level.metadata)
    const storeyName = level.name ?? 'Level 0'
    const express = step.add(
      `IFCBUILDINGSTOREY('${storeyGuid}',${step.ref(owner)},${stepString(storeyName)},$,$,${step.ref(place)},$,${stepString(storeyName)},.ELEMENT.,${num(elevation)})`,
    )
    storeyExpressIds.push(express)
    storeyByLevel.set(level.id, { levelId: level.id, place, express, contained: [] })
    assignments.push({ pascalId: level.id, globalId: storeyGuid, kind: 'level' })
  }

  const rel = (name: string, relating: number, related: number[]) => {
    step.add(
      `IFCRELAGGREGATES('${ifcGuid(name)}',${step.ref(owner)},$,$,${step.ref(relating)},(${related.map((item) => step.ref(item)).join(',')}))`,
    )
  }
  rel('agg-site', project, [site])
  rel('agg-building', site, [building])
  rel('agg-storey', building, storeyExpressIds)

  const storeyFor = (elementId: string): EmittedStorey => {
    const levelId = levelIdByElement.get(elementId)
    const storey = levelId ? storeyByLevel.get(levelId) : undefined
    if (!storey) throw new Error(`missing storey for ${elementId}`)
    return storey
  }

  const wallIds = new Map<string, { express: number; placement: number; globalId: string }>()

  for (const wall of walls) {
    const storey = storeyFor(wall.id)
    const length = wallLength(wall)
    const globalId = guidOf(wall.id, wall.metadata)
    const thickness = wall.thickness ?? DEFAULT_WALL_THICKNESS
    const height = wall.height ?? DEFAULT_WALL_HEIGHT
    // Local to the storey. The storey placement already carries the elevation.
    const start = pascalPlanToIfc(wall.start, 0)
    const end = pascalPlanToIfc(wall.end, 0)
    const dx = end[0] - start[0]
    const dy = end[1] - start[1]
    const placement = placement3(step, start, [dx / length, dy / length, 0], storey.place)
    const shape = wallSolid(step, length, thickness, height, axisCtx, bodyCtx)
    const express = step.add(
      `IFCWALLSTANDARDCASE('${globalId}',${step.ref(owner)},${stepString(wall.name ?? wall.id)},$,$,${step.ref(placement)},${step.ref(shape)},$,.STANDARD.)`,
    )
    wallIds.set(wall.id, { express, placement, globalId })
    storey.contained.push(express)
    assignments.push({ pascalId: wall.id, globalId, kind: 'wall' })
    if (wall.wallType === 'curtain' || wall.curtainWall) {
      losses.push({
        pascalId: wall.id,
        globalId,
        field: 'curtainWall',
        note: 'Exported as IfcWallStandardCase. CurtainWallConfig (panel grid, mullions) is not written.',
      })
    }
  }

  for (const opening of [...doors, ...windows]) {
    const hostId = opening.parentId ?? opening.wallId
    const host = hostId ? wallIds.get(hostId) : undefined
    if (!host || !hostId) {
      throw new Error(`opening ${opening.id} has no wall ${hostId ?? '(missing)'}`)
    }
    const storey = storeyFor(hostId)
    const globalId = guidOf(opening.id, opening.metadata)
    const along = openingAlong(opening)
    const sill = opening.type === 'window' ? windowSill(opening) : 0
    const place = openingPlacement(step, host.placement, along, sill)
    const openingGuid = ifcGuid(`${opening.id}:opening`)
    const openingElement = step.add(
      `IFCOPENINGELEMENT('${openingGuid}',${step.ref(owner)},${stepString(`${opening.name ?? opening.id} opening`)},$,$,${step.ref(place)},$,$,.OPENING.)`,
    )
    step.add(
      `IFCRELVOIDSELEMENT('${ifcGuid(`${opening.id}:void`)}',${step.ref(owner)},$,$,${step.ref(host.express)},${step.ref(openingElement)})`,
    )
    const height = num(opening.height)
    const width = num(opening.width)
    const entity = opening.type === 'door' ? 'IFCDOOR' : 'IFCWINDOW'
    const tail = opening.type === 'door' ? `${height},${width},$,$` : `${height},${width},$,$,$`
    const fill = step.add(
      `${entity}('${globalId}',${step.ref(owner)},${stepString(opening.name ?? opening.id)},$,$,${step.ref(place)},$,$,${tail})`,
    )
    step.add(
      `IFCRELFILLSELEMENT('${ifcGuid(`${opening.id}:fill`)}',${step.ref(owner)},$,$,${step.ref(openingElement)},${step.ref(fill)})`,
    )
    storey.contained.push(fill)
    assignments.push({ pascalId: opening.id, globalId, kind: opening.type })
  }

  for (const zone of zones) {
    const storey = storeyFor(zone.id)
    const globalId = guidOf(zone.id, zone.metadata)
    const place = placement3(step, [0, 0, 0], [1, 0, 0], storey.place)
    const shape = spaceShape(step, zone, bodyCtx)
    const express = step.add(
      `IFCSPACE('${globalId}',${step.ref(owner)},${stepString(zone.name)},$,$,${step.ref(place)},${step.ref(shape)},${stepString(zone.name)},.ELEMENT.,.INTERNAL.,$)`,
    )
    storey.contained.push(express)
    assignments.push({ pascalId: zone.id, globalId, kind: 'zone' })
  }

  for (const storey of storeyByLevel.values()) {
    if (storey.contained.length === 0) continue
    step.add(
      `IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid(`contains:${storey.levelId}`)}',${step.ref(owner)},$,$,(${storey.contained.map((id) => step.ref(id)).join(',')}),${step.ref(storey.express)})`,
    )
  }

  return {
    ifc: step.serialize(options.fileName ?? 'pascal-export.ifc'),
    assignments,
    losses,
  }
}
