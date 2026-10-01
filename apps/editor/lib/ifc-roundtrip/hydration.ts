import type { RoundtripGraph } from './source-update'

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

export function validateHydratedBaseline(
  imported: RoundtripGraph,
  hydrated: RoundtripGraph,
  expected: { artifactId: string; sourceHash: string },
): string[] {
  const originalIds = Object.keys(imported.nodes)
  const added = Object.keys(hydrated.nodes).filter((id) => !(id in imported.nodes))
  if (originalIds.some((id) => !(id in hydrated.nodes)))
    throw new Error('Wait for every imported node to finish loading')
  if (stable(imported.rootNodeIds) !== stable(hydrated.rootNodeIds))
    throw new Error('Source roots changed before baseline capture')
  const refs = Object.values(hydrated.nodes).flatMap((node) => {
    const metadata = node.metadata as Record<string, unknown> | undefined
    const ref = metadata?.ifcRoundtrip as { artifactId?: string; sourceHash?: string } | undefined
    return ref ? [ref] : []
  })
  if (
    refs.length !== 1 ||
    refs[0]?.artifactId !== expected.artifactId ||
    refs[0]?.sourceHash !== expected.sourceHash
  ) {
    throw new Error('Hydrated scene artifact or source hash mismatch')
  }
  for (const id of added) {
    const node = hydrated.nodes[id]!
    const metadata = node.metadata as Record<string, unknown> | undefined
    const level = imported.nodes[String(node.parentId)]
    const boundaries = node.boundaryWallIds
    if (
      node.type !== 'zone' ||
      node.autoFromWalls !== true ||
      metadata?.globalId ||
      metadata?.expressID ||
      level?.type !== 'level' ||
      !Array.isArray(boundaries) ||
      boundaries.length < 3 ||
      new Set(boundaries).size !== boundaries.length ||
      !boundaries.every(
        (wallId) =>
          imported.nodes[String(wallId)]?.type === 'wall' &&
          imported.nodes[String(wallId)]?.parentId === node.parentId,
      )
    ) {
      throw new Error(`Unexpected node appeared during editor hydration: ${id}`)
    }
  }
  for (const id of originalIds) {
    const original = imported.nodes[id]!
    const current = hydrated.nodes[id]!
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) {
      if (stable(original[key]) === stable(current[key])) continue
      if (key === 'children' && original.type === 'level' && Array.isArray(current.children)) {
        const originalChildren = current.children.filter((child) => !added.includes(String(child)))
        const newChildren = current.children.filter((child) => added.includes(String(child)))
        if (
          stable(originalChildren) === stable(original.children) &&
          newChildren.every((child) => hydrated.nodes[String(child)]?.parentId === id)
        )
          continue
      }
      if (
        original.type === 'wall' &&
        (key === 'frontSide' || key === 'backSide') &&
        (original[key] === 'unknown' || original[key] === undefined) &&
        (current[key] === 'interior' || current[key] === 'exterior')
      )
        continue
      throw new Error(`Capture the baseline before editing ${String(original.name ?? id)}: ${key}`)
    }
  }
  return added
}
