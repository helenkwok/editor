import { describe, expect, test } from 'bun:test'
import { validateHydratedBaseline } from './hydration'
import type { RoundtripGraph } from './source-update'

const ref = { artifactId: 'fixture', sourceHash: 'original-hash' }
const original: RoundtripGraph = {
  rootNodeIds: ['site'],
  nodes: {
    site: {
      id: 'site',
      type: 'site',
      name: 'Site',
      children: ['level'],
      metadata: { ifcRoundtrip: ref },
    },
    level: { id: 'level', type: 'level', name: 'Level', children: ['w1', 'w2', 'w3'] },
    w1: {
      id: 'w1',
      type: 'wall',
      name: 'Wall',
      parentId: 'level',
      height: 3,
      thickness: 0.2,
      start: [0, 0],
      end: [4, 0],
      frontSide: 'unknown',
      backSide: 'unknown',
      metadata: { material: 'Concrete' },
    },
    w2: { id: 'w2', type: 'wall', parentId: 'level' },
    w3: { id: 'w3', type: 'wall', parentId: 'level' },
  },
}
const copy = (): RoundtripGraph => structuredClone(original)

describe('post-hydration baseline guards', () => {
  test('unchanged graph is accepted', () =>
    expect(validateHydratedBaseline(original, copy(), ref)).toEqual([]))
  test('automatic room and wall side classification are accepted', () => {
    const graph = copy()
    graph.nodes.room = {
      id: 'room',
      type: 'zone',
      autoFromWalls: true,
      parentId: 'level',
      boundaryWallIds: ['w1', 'w2', 'w3'],
      metadata: {},
    }
    graph.nodes.level!.children = ['w1', 'w2', 'w3', 'room']
    graph.nodes.w1!.frontSide = 'exterior'
    graph.nodes.w1!.backSide = 'interior'
    expect(validateHydratedBaseline(original, graph, ref)).toEqual(['room'])
  })
  for (const [field, value] of [
    ['thickness', 0.4],
    ['start', [1, 0]],
    ['name', 'Changed'],
    ['height', 3.1],
    ['metadata', { material: 'Wood' }],
    ['newGeometry', { curve: true }],
  ] as const) {
    test(`pre-baseline ${field} edit rejects`, () => {
      const graph = copy()
      graph.nodes.w1![field] = value
      expect(() => validateHydratedBaseline(original, graph, ref)).toThrow(/before editing/)
    })
  }
  test('matching artifact ID with altered source hash rejects', () => {
    const graph = copy()
    ;(graph.nodes.site!.metadata as Record<string, unknown>).ifcRoundtrip = {
      ...ref,
      sourceHash: 'altered',
    }
    expect(() => validateHydratedBaseline(original, graph, ref)).toThrow(/source hash mismatch/)
  })
  test('source child deletion or reordering rejects', () => {
    const graph = copy()
    graph.nodes.level!.children = ['w2', 'w1', 'w3']
    expect(() => validateHydratedBaseline(original, graph, ref)).toThrow(/children/)
  })
  test('unlisted authored additions reject', () => {
    const graph = copy()
    graph.nodes.newwall = { id: 'newwall', type: 'wall', parentId: 'level' }
    expect(() => validateHydratedBaseline(original, graph, ref)).toThrow(/Unexpected node/)
  })
})
