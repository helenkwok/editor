import { beforeAll, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AnyNode,
  BuildingNode,
  DoorNode,
  LevelNode,
  SiteNode,
  WallNode,
  WindowNode,
  ZoneNode,
} from '@pascal-app/core'
import {
  convertIfcToPascal,
  convertPascalToIfc,
  ifcPlanToPascal,
  type PascalSceneGraph,
} from '../src'

type Door = Extract<AnyNode, { type: 'door' }>
type Wall = Extract<AnyNode, { type: 'wall' }>
type Window = Extract<AnyNode, { type: 'window' }>
type Zone = Extract<AnyNode, { type: 'zone' }>

// Pascal is Y-up and right-handed; IFC is Z-up and right-handed. Seen from
// above, IFC north (+Y) is Pascal -Z, so an IFC plan point (X, Y) is the
// Pascal plan point (x, z) = (X, -Y). Same helper as handedness.test.ts.
const plan = ifcPlanToPascal

const handednessFixture = fileURLToPath(new URL('./fixtures/handedness.ifc', import.meta.url))
const wasmPath = `${dirname(fileURLToPath(import.meta.resolve('web-ifc')))}/`

const OPEN_TOL = 0.01

function expectPoint(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length)
  for (let axis = 0; axis < expected.length; axis++) {
    expect(actual[axis]!).toBeCloseTo(expected[axis]!, 5)
  }
}

function near(actual: number, expected: number, tol: number) {
  return Math.abs(actual - expected) <= tol
}

function parseStep(ifc: string): Map<number, string> {
  const entities = new Map<number, string>()
  for (const raw of ifc.split('\n')) {
    const match = /^#(\d+)=([A-Z0-9]+\(.*\));$/.exec(raw.trim())
    if (!match) continue
    entities.set(Number(match[1]), match[2]!)
  }
  return entities
}

function stepEntity(model: Map<number, string>, id: number): string {
  const body = model.get(id)
  if (!body) throw new Error(`missing #${id}`)
  return body
}

function stepNumbers(text: string): number[] {
  return [...text.matchAll(/-?\d+\.\d+(?:E[+-]?\d+)?/gi)].map((match) => Number(match[0]))
}

function findProduct(
  model: Map<number, string>,
  type: string,
  name: string,
): { placement: number; shape: number } {
  const pattern = new RegExp(`^${type}\\('[^']*',#\\d+,'${name}',\\$,\\$,#(\\d+),#(\\d+),`)
  for (const body of model.values()) {
    const match = pattern.exec(body)
    if (match) return { placement: Number(match[1]), shape: Number(match[2]) }
  }
  throw new Error(`missing ${type} ${name}`)
}

function findStorey(
  model: Map<number, string>,
  name: string,
): { placement: number; elevation: number } {
  const pattern = new RegExp(
    `^IFCBUILDINGSTOREY\\('[^']*',#\\d+,'${name}',\\$,\\$,#(\\d+),\\$,'${name}',\\.ELEMENT\\.,(-?\\d+\\.\\d+)\\)$`,
  )
  for (const body of model.values()) {
    const match = pattern.exec(body)
    if (match) return { placement: Number(match[1]), elevation: Number(match[2]) }
  }
  throw new Error(`missing storey ${name}`)
}

function placementFrame(model: Map<number, string>, placementId: number) {
  const place = /^IFCLOCALPLACEMENT\((?:#(\d+)|\$),#(\d+)\)$/.exec(stepEntity(model, placementId))
  if (!place) throw new Error(`not a placement #${placementId}`)
  const axis = /^IFCAXIS2PLACEMENT3D\(#(\d+),#(\d+),#(\d+)\)$/.exec(
    stepEntity(model, Number(place[2])),
  )
  if (!axis) throw new Error(`not an axis placement #${place[2]}`)
  const origin = stepNumbers(stepEntity(model, Number(axis[1])))
  const ref = stepNumbers(stepEntity(model, Number(axis[3])))
  return {
    parent: place[1] ? Number(place[1]) : null,
    origin: [origin[0]!, origin[1]!, origin[2] ?? 0] as [number, number, number],
    ref: [ref[0]!, ref[1]!, ref[2] ?? 0] as [number, number, number],
  }
}

/** Compose a point in a placement's local frame out to world coordinates. */
function worldOf(
  model: Map<number, string>,
  placementId: number,
  local: [number, number, number],
): [number, number, number] {
  const frame = placementFrame(model, placementId)
  const x = frame.ref
  const z: [number, number, number] = [0, 0, 1]
  const y: [number, number, number] = [
    z[1] * x[2] - z[2] * x[1],
    z[2] * x[0] - z[0] * x[2],
    z[0] * x[1] - z[1] * x[0],
  ]
  const inParent: [number, number, number] = [
    frame.origin[0] + x[0] * local[0] + y[0] * local[1] + z[0] * local[2],
    frame.origin[1] + x[1] * local[0] + y[1] * local[1] + z[1] * local[2],
    frame.origin[2] + x[2] * local[0] + y[2] * local[1] + z[2] * local[2],
  ]
  return frame.parent == null ? inParent : worldOf(model, frame.parent, inParent)
}

function axisLength(model: Map<number, string>, shapeId: number): number {
  const reps = [...stepEntity(model, shapeId).matchAll(/#(\d+)/g)].map((match) => Number(match[1]))
  for (const repId of reps) {
    const axis = /^IFCSHAPEREPRESENTATION\(#\d+,'Axis','Curve2D',\(#(\d+)\)\)$/.exec(
      stepEntity(model, repId),
    )
    if (!axis) continue
    const points = [...stepEntity(model, Number(axis[1])).matchAll(/#(\d+)/g)].map((match) =>
      stepNumbers(stepEntity(model, Number(match[1]))),
    )
    const start = points[0]
    const end = points[1]
    if (!start || !end) throw new Error('axis polyline is short')
    return Math.hypot(end[0]! - start[0]!, (end[1] ?? 0) - (start[1] ?? 0))
  }
  throw new Error(`no axis on #${shapeId}`)
}

function storeysScene(
  specs: Array<{
    id: string
    name: string
    elevation: number
    walls: Array<{
      id: string
      name: string
      start: [number, number]
      end: [number, number]
    }>
    zone?: {
      id: string
      name: string
      polygon: [number, number][]
      ceilingHeight: number
    }
  }>,
): PascalSceneGraph {
  const site = SiteNode.parse({
    id: 'site_levels',
    type: 'site',
    name: 'Site',
    children: ['building_levels'],
  })
  const building = BuildingNode.parse({
    id: 'building_levels',
    type: 'building',
    name: 'Building',
    parentId: site.id,
    children: specs.map((spec) => spec.id),
  })
  const nodes: PascalSceneGraph['nodes'] = {
    [site.id]: site,
    [building.id]: building,
  }
  for (const spec of specs) {
    const level = LevelNode.parse({
      id: spec.id,
      type: 'level',
      name: spec.name,
      parentId: building.id,
      level: 0,
      baseElevation: spec.elevation,
      children: [...spec.walls.map((wall) => wall.id), ...(spec.zone ? [spec.zone.id] : [])],
      metadata: { elevation: spec.elevation },
    })
    nodes[level.id] = level
    for (const wallSpec of spec.walls) {
      nodes[wallSpec.id] = WallNode.parse({
        id: wallSpec.id,
        type: 'wall',
        name: wallSpec.name,
        parentId: level.id,
        start: wallSpec.start,
        end: wallSpec.end,
        thickness: 0.2,
        height: 2.8,
      })
    }
    if (spec.zone) {
      nodes[spec.zone.id] = ZoneNode.parse({
        id: spec.zone.id,
        type: 'zone',
        name: spec.zone.name,
        parentId: level.id,
        polygon: spec.zone.polygon,
        ceilingHeight: spec.zone.ceilingHeight,
        spaceRole: 'room',
      })
    }
  }
  return { nodes, rootNodeIds: [site.id] }
}

function syntheticRoom(): PascalSceneGraph {
  const site = SiteNode.parse({
    id: 'site_room',
    type: 'site',
    name: 'Site',
    children: ['building_room'],
  })
  const building = BuildingNode.parse({
    id: 'building_room',
    type: 'building',
    name: 'Building',
    parentId: site.id,
    children: ['level_0'],
  })
  const level = LevelNode.parse({
    id: 'level_0',
    type: 'level',
    name: 'Level 0',
    parentId: building.id,
    level: 0,
    baseElevation: 0,
    children: ['wall_south', 'wall_east', 'wall_north', 'wall_west', 'wall_curtain', 'zone_room'],
    metadata: { elevation: 0 },
  })

  const wall = (
    id: string,
    name: string,
    start: [number, number],
    end: [number, number],
    thickness: number,
    height: number,
    children: string[] = [],
    extras: Partial<Wall> = {},
  ) =>
    WallNode.parse({
      id,
      type: 'wall',
      name,
      parentId: level.id,
      start,
      end,
      thickness,
      height,
      children,
      ...extras,
    })

  const south = wall('wall_south', 'South', [0, 0], [6, 0], 0.2, 2.8, ['door_south'])
  const east = wall('wall_east', 'East', [6, 0], [6, 4], 0.2, 2.8, ['window_east'])
  const north = wall('wall_north', 'North', [6, 4], [0, 4], 0.2, 2.8)
  const west = wall('wall_west', 'West', [0, 4], [0, 0], 0.2, 2.8)
  const curtain = wall('wall_curtain', 'Screen', [0, -1.5], [3, -1.5], 0.15, 3, [], {
    wallType: 'curtain',
    curtainWall: { mullionWidth: 0.05 },
  })

  const door = DoorNode.parse({
    id: 'door_south',
    type: 'door',
    name: 'Entry',
    parentId: south.id,
    width: 0.9,
    height: 2.1,
    position: [2, 1.05, 0],
  })
  const window = WindowNode.parse({
    id: 'window_east',
    type: 'window',
    name: 'East window',
    parentId: east.id,
    width: 1.2,
    height: 1.1,
    position: [1.5, 0.9 + 1.1 / 2, 0],
    metadata: { sillHeight: 0.9 },
  })
  const zone = ZoneNode.parse({
    id: 'zone_room',
    type: 'zone',
    name: 'Living',
    parentId: level.id,
    polygon: [
      [0.1, 0.1],
      [5.9, 0.1],
      [5.9, 3.9],
      [0.1, 3.9],
    ],
    ceilingHeight: 2.8,
    spaceRole: 'room',
  })

  return {
    nodes: {
      [site.id]: site,
      [building.id]: building,
      [level.id]: level,
      [south.id]: south,
      [east.id]: east,
      [north.id]: north,
      [west.id]: west,
      [curtain.id]: curtain,
      [door.id]: door,
      [window.id]: window,
      [zone.id]: zone,
    },
    rootNodeIds: [site.id],
  }
}

function byGlobalId(scene: PascalSceneGraph) {
  const map = new Map<string, (typeof scene.nodes)[string]>()
  for (const node of Object.values(scene.nodes)) {
    const id = node.metadata?.globalId
    if (typeof id === 'string') map.set(id, node)
  }
  return map
}

describe('convertPascalToIfc', () => {
  let authored: PascalSceneGraph
  let exported: ReturnType<typeof convertPascalToIfc>
  let roundTrip: PascalSceneGraph
  let handedness: PascalSceneGraph

  beforeAll(async () => {
    authored = syntheticRoom()
    exported = convertPascalToIfc(authored, { fileName: 'synthetic-room.ifc' })
    roundTrip = await convertIfcToPascal(Buffer.from(exported.ifc), undefined, {
      simplify: false,
      wasmPath,
    })
    handedness = await convertIfcToPascal(await readFile(handednessFixture), undefined, {
      simplify: false,
      wasmPath,
    })
  })

  test('rejects a zero-length wall', () => {
    const broken = structuredClone(authored)
    const wall = broken.nodes.wall_south as Wall
    broken.nodes.wall_south = { ...wall, end: [...wall.start] as [number, number] }
    expect(() => convertPascalToIfc(broken)).toThrow(/zero-length/)
  })

  test('round-trips wall centrelines, thickness and height', () => {
    const found = byGlobalId(roundTrip)
    for (const id of [
      'wall_south',
      'wall_east',
      'wall_north',
      'wall_west',
      'wall_curtain',
    ] as const) {
      const want = authored.nodes[id] as Wall
      const assignment = exported.assignments.find((item) => item.pascalId === id)
      expect(assignment).toBeDefined()
      const got = found.get(assignment!.globalId) as Wall | undefined
      expect(got?.type).toBe('wall')
      expectPoint(got!.start, want.start)
      expectPoint(got!.end, want.end)
      expect(got!.thickness).toBeCloseTo(want.thickness!, 5)
      expect(got!.height).toBeCloseTo(want.height!, 5)
    }
  })

  test('round-trips door and window size, along-wall position and sill', () => {
    const found = byGlobalId(roundTrip)

    const doorAssignment = exported.assignments.find((item) => item.pascalId === 'door_south')
    const door = found.get(doorAssignment!.globalId) as Door | undefined
    expect(door?.type).toBe('door')
    expect(door!.width).toBeCloseTo(0.9, 2)
    expect(door!.height).toBeCloseTo(2.1, 2)
    expect(door!.position[0]).toBeCloseTo(2, 2)

    const windowAssignment = exported.assignments.find((item) => item.pascalId === 'window_east')
    const window = found.get(windowAssignment!.globalId) as Window | undefined
    expect(window?.type).toBe('window')
    expect(window!.width).toBeCloseTo(1.2, 2)
    expect(window!.height).toBeCloseTo(1.1, 2)
    expect(window!.position[0]).toBeCloseTo(1.5, 2)
    const sill = window!.position[1] - window!.height / 2
    expect(sill).toBeCloseTo(0.9, 2)
  })

  test('round-trips the space polygon and ceiling height', () => {
    const found = byGlobalId(roundTrip)
    const assignment = exported.assignments.find((item) => item.pascalId === 'zone_room')
    const zone = found.get(assignment!.globalId) as Zone | undefined
    const want = authored.nodes.zone_room as Zone
    expect(zone?.type).toBe('zone')
    expect(zone!.name).toBe('Living')
    expect(zone!.ceilingHeight).toBeCloseTo(2.8, 2)
    expect(zone!.polygon).toHaveLength(want.polygon.length)
    for (let i = 0; i < want.polygon.length; i++) {
      expectPoint(zone!.polygon[i]!, want.polygon[i]!)
    }
  })

  test('records curtain-wall configuration as a loss', () => {
    const loss = exported.losses.find((item) => item.field === 'curtainWall')
    expect(loss?.pascalId).toBe('wall_curtain')
    const found = byGlobalId(roundTrip)
    const curtain = found.get(loss!.globalId) as Wall | undefined
    expect(curtain?.type).toBe('wall')
    expect(curtain?.wallType).not.toBe('curtain')
    expect(curtain?.curtainWall).toBeUndefined()
  })

  test('writer plan mapping matches handedness.ifc import', () => {
    // Import side: Wall A east runs IFC (0,0)→(4,0); Wall B north runs IFC (0,0)→(0,2).
    const east = Object.values(handedness.nodes).find(
      (node) => node.type === 'wall' && node.name === 'Wall A east',
    ) as Wall
    const north = Object.values(handedness.nodes).find(
      (node) => node.type === 'wall' && node.name === 'Wall B north',
    ) as Wall
    expectPoint(east.start, plan(0, 0))
    expectPoint(east.end, plan(4, 0))
    expectPoint(north.start, plan(0, 0))
    expectPoint(north.end, plan(0, 2))

    // Writer side: read the east wall out of the STEP. Pascal (6, 0)→(6, 4)
    // is a 4 m local axis from IFC (6, 0, 0) along direction (0, −1, 0).
    const model = parseStep(exported.ifc)
    const written = findProduct(model, 'IFCWALLSTANDARDCASE', 'East')
    const local = placementFrame(model, written.placement)
    expectPoint(local.origin, [6, 0, 0])
    expectPoint(local.ref, [0, -1, 0])
    const length = axisLength(model, written.shape)
    expect(length).toBeCloseTo(4, 5)
    const end = worldOf(model, written.placement, [length, 0, 0])
    expectPoint(end, [6, -4, 0])
    expectPoint(plan(end[0], end[1]), (authored.nodes.wall_east as Wall).end)

    // Opening distance on the handedness fixture stays 1 m from wall start.
    const door = Object.values(handedness.nodes).find(
      (node) => node.type === 'door' && node.name === 'Door',
    ) as Door
    expect(door.position[0]).toBeCloseTo(1, 5)
    expect(near(door.position[0], 1, OPEN_TOL)).toBe(true)
  })

  test('writes the storey elevation once', () => {
    const scene = storeysScene([
      {
        id: 'level_mid',
        name: 'Level 3',
        elevation: 3,
        walls: [{ id: 'wall_east', name: 'East', start: [6, 0], end: [6, 4] }],
        zone: {
          id: 'zone_mid',
          name: 'Room',
          polygon: [
            [0.1, 0.1],
            [5.9, 0.1],
            [5.9, 3.9],
            [0.1, 3.9],
          ],
          ceilingHeight: 2.8,
        },
      },
    ])
    const model = parseStep(convertPascalToIfc(scene).ifc)
    const storey = findStorey(model, 'Level 3')
    expect(storey.elevation).toBeCloseTo(3, 5)
    expectPoint(worldOf(model, storey.placement, [0, 0, 0]), [0, 0, 3])

    const wall = findProduct(model, 'IFCWALLSTANDARDCASE', 'East')
    const local = placementFrame(model, wall.placement)
    expect(local.parent).toBe(storey.placement)
    expectPoint(local.origin, [6, 0, 0])
    expectPoint(local.ref, [0, -1, 0])
    const length = axisLength(model, wall.shape)
    expectPoint(worldOf(model, wall.placement, [0, 0, 0]), [6, 0, 3])
    expectPoint(worldOf(model, wall.placement, [length, 0, 0]), [6, -4, 3])

    const space = findProduct(model, 'IFCSPACE', 'Room')
    const spaceLocal = placementFrame(model, space.placement)
    expect(spaceLocal.parent).toBe(storey.placement)
    expectPoint(spaceLocal.origin, [0, 0, 0])
    expectPoint(worldOf(model, space.placement, [0, 0, 0]), [0, 0, 3])
  })

  test('writes one storey per level and round-trips each wall onto its own storey', async () => {
    const scene = storeysScene([
      {
        id: 'level_low',
        name: 'Level 3',
        elevation: 3,
        walls: [{ id: 'wall_low', name: 'Low', start: [6, 0], end: [6, 4] }],
      },
      {
        id: 'level_high',
        name: 'Level 6',
        elevation: 6,
        walls: [{ id: 'wall_high', name: 'High', start: [0, 0], end: [2, 0] }],
        zone: {
          id: 'zone_high',
          name: 'Upper',
          polygon: [
            [0.1, 0.1],
            [1.9, 0.1],
            [1.9, 1.9],
            [0.1, 1.9],
          ],
          ceilingHeight: 2.8,
        },
      },
    ])
    const exported = convertPascalToIfc(scene)
    expect(exported.ifc.match(/IFCBUILDINGSTOREY\(/g)).toHaveLength(2)
    const model = parseStep(exported.ifc)
    const low = findStorey(model, 'Level 3')
    const high = findStorey(model, 'Level 6')
    expect(
      placementFrame(model, findProduct(model, 'IFCWALLSTANDARDCASE', 'Low').placement).parent,
    ).toBe(low.placement)
    expect(
      placementFrame(model, findProduct(model, 'IFCWALLSTANDARDCASE', 'High').placement).parent,
    ).toBe(high.placement)
    expect(placementFrame(model, findProduct(model, 'IFCSPACE', 'Upper').placement).parent).toBe(
      high.placement,
    )
    expectPoint(
      placementFrame(model, findProduct(model, 'IFCWALLSTANDARDCASE', 'Low').placement).origin,
      [6, 0, 0],
    )
    expectPoint(
      placementFrame(model, findProduct(model, 'IFCWALLSTANDARDCASE', 'High').placement).origin,
      [0, 0, 0],
    )

    const imported = await convertIfcToPascal(Buffer.from(exported.ifc), undefined, {
      simplify: false,
      wasmPath,
    })
    const found = byGlobalId(imported)
    const levels = Object.values(imported.nodes).filter((node) => node.type === 'level')
    expect(levels).toHaveLength(2)

    const levelNode = (pascalId: string) => {
      const assignment = exported.assignments.find((item) => item.pascalId === pascalId)
      const node = found.get(assignment!.globalId)
      expect(node?.type).toBe('level')
      return node!
    }
    const lowLevel = levelNode('level_low')
    const highLevel = levelNode('level_high')
    expect(lowLevel.metadata?.elevation).toBeCloseTo(3, 5)
    expect(highLevel.metadata?.elevation).toBeCloseTo(6, 5)

    const wallNode = (pascalId: string) => {
      const assignment = exported.assignments.find((item) => item.pascalId === pascalId)
      const node = found.get(assignment!.globalId) as Wall
      expect(node?.type).toBe('wall')
      return node
    }
    const lowWall = wallNode('wall_low')
    const highWall = wallNode('wall_high')
    expect(lowWall.parentId).toBe(lowLevel.id)
    expect(highWall.parentId).toBe(highLevel.id)
    expectPoint(lowWall.start, [6, 0])
    expectPoint(lowWall.end, [6, 4])
    expectPoint(highWall.start, [0, 0])
    expectPoint(highWall.end, [2, 0])

    const zoneAssignment = exported.assignments.find((item) => item.pascalId === 'zone_high')
    const zone = found.get(zoneAssignment!.globalId) as Zone
    expect(zone?.type).toBe('zone')
    expect(zone.parentId).toBe(highLevel.id)
    expectPoint(zone.polygon[0]!, [0.1, 0.1])
    expectPoint(zone.polygon[2]!, [1.9, 1.9])
  })

  test('rejects a wall that is not parented to a level', () => {
    const scene = storeysScene([
      {
        id: 'level_mid',
        name: 'Level 3',
        elevation: 3,
        walls: [{ id: 'wall_loose', name: 'Loose', start: [0, 0], end: [2, 0] }],
      },
    ])
    const wall = scene.nodes.wall_loose as Wall
    scene.nodes.wall_loose = { ...wall, parentId: null }
    expect(() => convertPascalToIfc(scene)).toThrow(/wall_loose is not parented to a level/)
  })

  test('synthesizes one storey when the scene has no level', () => {
    const wall = WallNode.parse({
      id: 'wall_only',
      type: 'wall',
      name: 'Only',
      start: [0, 0],
      end: [4, 0],
      thickness: 0.2,
      height: 2.8,
    })
    const exported = convertPascalToIfc({ nodes: { [wall.id]: wall } })
    expect(exported.ifc.match(/IFCBUILDINGSTOREY\(/g)).toHaveLength(1)
    const model = parseStep(exported.ifc)
    const storey = findStorey(model, 'Level 0')
    expect(storey.elevation).toBeCloseTo(0, 5)
    const written = findProduct(model, 'IFCWALLSTANDARDCASE', 'Only')
    expect(placementFrame(model, written.placement).parent).toBe(storey.placement)
    expectPoint(placementFrame(model, written.placement).origin, [0, 0, 0])
    expectPoint(worldOf(model, written.placement, [0, 0, 0]), [0, 0, 0])
  })
})
