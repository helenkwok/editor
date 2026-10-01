import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnyNode, ImportedMeshNode } from '@pascal-app/core'
import { type ConversionOptions, convertIfcToPascal, type PascalSceneGraph } from '../src'

const fixture = new URL(
  '../../../apps/ifc-converter/public/test-ifc-files/04-ifc-open-house.ifc',
  import.meta.url,
)
const wasmPath = `${dirname(fileURLToPath(import.meta.resolve('web-ifc')))}/`
const fillIds = [2441, 2511, 2594, 2667, 2740, 2813]

function sourceNode(scene: PascalSceneGraph, expressID: number): AnyNode {
  const matches = Object.values(scene.nodes).filter(
    (node) => node.metadata?.expressID === expressID,
  )
  expect(matches).toHaveLength(1)
  return matches[0]!
}

function expectReachable(scene: PascalSceneGraph) {
  const reachable = new Set<string>()
  const visit = (id: string) => {
    if (reachable.has(id)) return
    reachable.add(id)
    const node = scene.nodes[id]
    if (node && 'children' in node) for (const child of node.children) visit(child)
  }
  for (const id of scene.rootNodeIds) visit(id)
  expect(reachable.size).toBe(Object.keys(scene.nodes).length)
}

function expectGableSilhouette(node: AnyNode, swapYZ: boolean) {
  expect(node.type).toBe('imported-mesh')
  if (node.type !== 'imported-mesh') return
  const wall: ImportedMeshNode = node
  const vertices = wall.primitives.flatMap((primitive) =>
    Array.from({ length: primitive.positions.length / 3 }, (_, index) => {
      const position = primitive.positions.slice(index * 3, index * 3 + 3)
      return {
        plan: swapYZ ? -position[2]! : position[1]!,
        height: position[swapYZ ? 1 : 2]!,
      }
    }),
  )
  expect(vertices.length).toBeGreaterThan(0)
  for (const { plan, height } of vertices) {
    expect(plan).toBeGreaterThanOrEqual(-0.0001)
    expect(plan).toBeLessThanOrEqual(5.0001)
    expect(height).toBeLessThanOrEqual(3 + Math.min(plan, 5 - plan) + 0.0002)
  }
  for (const [plan, height] of [
    [0, 3],
    [2.5, 5.5],
    [5, 3],
  ]) {
    expect(
      vertices.some(
        (vertex) =>
          Math.abs(vertex.plan - plan!) < 0.0002 && Math.abs(vertex.height - height!) < 0.0002,
      ),
    ).toBe(true)
  }
}

describe('roof-clipped IFC walls', () => {
  for (const options of [
    { simplify: false, swapYZ: true },
    { swapYZ: true },
    { simplify: false, swapYZ: false },
  ] satisfies ConversionOptions[]) {
    test(`preserves both gable tops and their fills (${JSON.stringify(options)})`, async () => {
      const scene = await convertIfcToPascal(await readFile(fixture), undefined, {
        wasmPath,
        ...options,
      })
      const east = sourceNode(scene, 268)
      const west = sourceNode(scene, 281)
      for (const wall of [east, west]) {
        expectGableSilhouette(wall, options.swapYZ)
        expect(wall.metadata?.globalId).toBeTruthy()
        expect(wall.parentId ? scene.nodes[wall.parentId]?.type : undefined).toBe('level')
      }
      for (const expressID of [40, 221]) {
        const wall = sourceNode(scene, expressID)
        expect(wall.type).toBe('wall')
        if (wall.type === 'wall') expect(wall.height).toBeCloseTo(3, 4)
      }
      const door = sourceNode(scene, 2441)
      expect(door.type).toBe('imported-mesh')
      expect(door.metadata?.hostWallExpressID).toBe(268)
      expect(door.metadata?.openingExpressID).toBe(2380)
      expect(door.parentId).toBe(east.parentId)
      if (options.simplify === false) {
        for (const expressID of fillIds.slice(1)) {
          expect(sourceNode(scene, expressID).type).toBe('window')
        }
      } else {
        expect(Object.values(scene.nodes).filter((node) => node.type === 'window')).toHaveLength(4)
      }
      expectReachable(scene)
    })
  }

  for (const [name, transform] of [
    [
      'direct clipping bodies',
      (source: string) =>
        source
          .replace(
            '#262=IFCPRODUCTDEFINITIONSHAPE($,$,(#261,#283));',
            '#262=IFCPRODUCTDEFINITIONSHAPE($,$,(#225,#283));',
          )
          .replace(
            '#275=IFCPRODUCTDEFINITIONSHAPE($,$,(#274,#287));',
            '#275=IFCPRODUCTDEFINITIONSHAPE($,$,(#225,#287));',
          ),
    ],
    [
      'BooleanResult bodies',
      (source: string) => source.replaceAll('IFCBOOLEANCLIPPINGRESULT(', 'IFCBOOLEANRESULT('),
    ],
    [
      'an exact window on a mesh host',
      (source: string) =>
        source.replace(
          /#2441=IFCDOOR\(([^\n]+)\.DOOR\.,\.SINGLE_SWING_LEFT\./,
          '#2441=IFCWINDOW($1.WINDOW.,.SINGLE_PANEL.',
        ),
    ],
    [
      'an explicit mesh-host fill beside a native wall',
      (source: string) =>
        source
          .replace(
            '#2377=IFCCARTESIANPOINT((4820.,1600.,0.));',
            '#2377=IFCCARTESIANPOINT((4820.,400.,0.));',
          )
          .replace(
            '#2384=IFCCARTESIANPOINT((4800.,1600.,0.));',
            '#2384=IFCCARTESIANPOINT((4800.,400.,0.));',
          ),
    ],
  ] as const) {
    test(`preserves ${name}`, async () => {
      const source = transform(await readFile(fixture, 'utf8'))
      const scene = await convertIfcToPascal(new TextEncoder().encode(source), undefined, {
        wasmPath,
        simplify: false,
      })
      for (const expressID of [268, 281]) expectGableSilhouette(sourceNode(scene, expressID), true)
      const fill = sourceNode(scene, 2441)
      expect(fill.type).toBe('imported-mesh')
      expect(fill.metadata?.hostWallExpressID).toBe(268)
      expect(fill.parentId).toBe(sourceNode(scene, 268).parentId)
      expect(fill.metadata?.ifcType).toBe(
        name === 'an exact window on a mesh host' ? 'IFCWINDOW' : 'IFCDOOR',
      )
      expectReachable(scene)
    })
  }

  test('keeps an ordinary mapped extrusion native', async () => {
    const source = (await readFile(fixture, 'utf8')).replace(
      "#225=IFCSHAPEREPRESENTATION(#11,'Body','Clipping',(#252));",
      "#225=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#238));",
    )
    const scene = await convertIfcToPascal(new TextEncoder().encode(source), undefined, {
      wasmPath,
      simplify: false,
    })
    for (const expressID of [268, 281]) {
      const wall = sourceNode(scene, expressID)
      expect(wall.type).toBe('wall')
      if (wall.type === 'wall') expect(wall.height).toBeCloseTo(6, 4)
    }
    expect(sourceNode(scene, 2441).type).toBe('door')
  })
})
