import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { convertIfcToPascal } from '@pascal-app/ifc-converter'
import { type NextRequest, NextResponse } from 'next/server'
import { apiGraphSchema } from '@/lib/graph-schema'
import { validateHydratedBaseline } from '@/lib/ifc-roundtrip/hydration'
import { exportEditedSource, type RoundtripGraph } from '@/lib/ifc-roundtrip/source-update'
import { guardSceneApiRequest, sceneApiJson, withSceneApiHeaders } from '@/lib/scene-api-security'
import { getSceneOperations } from '@/lib/scene-store-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Resolve at runtime so the bundler does not substitute a virtual module identifier.
const WASM_PATH = `${dirname(createRequire(join(process.cwd(), 'package.json')).resolve('web-ifc'))}${sep}`
const MAX_IFC_BYTES = 5 * 1024 * 1024

type Artifact = {
  manifestVersion: 1
  artifactId: string
  sceneId: string
  sourceName: string
  sourceHash: string
  sourceSchema: 'IFC4'
  createdAt: string
  importedGraph: RoundtripGraph
  baseline: RoundtripGraph | null
  editorDerivedNodeIds?: string[]
}

function artifactRoot(): string {
  const root = process.env.PASCAL_IFC_SPIKE_DIR
  if (!root) throw new Error('IFC roundtrip spike is disabled. Start the isolated spike server.')
  return root
}

function artifactDirectory(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new Error('Invalid IFC artifact reference')
  }
  return join(artifactRoot(), id)
}

function marker(graph: RoundtripGraph): { artifactId: string; sourceHash: string } {
  const matches = Object.values(graph.nodes).flatMap((node) => {
    const metadata = node.metadata as Record<string, unknown> | undefined
    const ref = metadata?.ifcRoundtrip as { artifactId?: string; sourceHash?: string } | undefined
    return ref?.artifactId && ref.sourceHash
      ? [{ artifactId: ref.artifactId, sourceHash: ref.sourceHash }]
      : []
  })
  if (matches.length !== 1)
    throw new Error('Scene must retain exactly one original IFC artifact reference')
  return matches[0]!
}

async function writeArtifact(artifact: Artifact): Promise<void> {
  const directory = artifactDirectory(artifact.artifactId)
  const temporary = join(directory, `manifest-${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(artifact), { mode: 0o600 })
  await rename(temporary, join(directory, 'manifest.json'))
}

async function readArtifact(
  graph: RoundtripGraph,
  sceneId: string,
): Promise<{ artifact: Artifact; source: Uint8Array }> {
  const ref = marker(graph)
  const directory = artifactDirectory(ref.artifactId)
  const artifact = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Artifact
  if (artifact.sceneId !== sceneId || artifact.sourceHash !== ref.sourceHash) {
    throw new Error('The original IFC artifact does not match this saved scene')
  }
  const source = new Uint8Array(await readFile(join(directory, 'source.ifc')))
  if (createHash('sha256').update(source).digest('hex') !== artifact.sourceHash) {
    throw new Error('The original IFC bytes no longer match the import hash')
  }
  return { artifact, source }
}

async function event(kind: string, details: Record<string, unknown>): Promise<void> {
  const root = artifactRoot()
  await mkdir(root, { recursive: true })
  await appendFile(
    join(root, 'events.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), kind, ...details })}\n`,
  )
}

async function loadScene(sceneId: string) {
  const operations = await getSceneOperations()
  const stored = await operations.loadStoredScene(sceneId)
  if (!stored) throw new Error('Saved scene was not found')
  return { operations, stored, graph: stored.graph as RoundtripGraph }
}

export async function GET(request: NextRequest) {
  const guard = guardSceneApiRequest(request)
  if (guard) return guard
  try {
    const sceneId = request.nextUrl.searchParams.get('scene')
    if (!sceneId) throw new Error('A scene ID is required')
    const { graph } = await loadScene(sceneId)
    const { artifact } = await readArtifact(graph, sceneId)
    return sceneApiJson(request, {
      artifactId: artifact.artifactId,
      baselineReady: artifact.baseline !== null,
      sourceName: artifact.sourceName,
      sourceHash: artifact.sourceHash,
      sourceSchema: artifact.sourceSchema,
      exportSupport: 'Names and straight wall heights',
    })
  } catch (error) {
    return sceneApiJson(
      request,
      { error: error instanceof Error ? error.message : 'IFC artifact could not be read' },
      { status: 422 },
    )
  }
}

export async function POST(request: NextRequest) {
  const guard = guardSceneApiRequest(request)
  if (guard) return guard
  try {
    artifactRoot()
    const action = request.nextUrl.searchParams.get('action')
    if (action === 'import') {
      const form = await request.formData()
      const file = form.get('file')
      if (!(file instanceof File) || file.size === 0 || file.size > MAX_IFC_BYTES) {
        throw new Error('Choose an IFC4 file smaller than 5 MB')
      }
      const source = new Uint8Array(await file.arrayBuffer())
      if (
        !/FILE_SCHEMA\s*\(\s*\(\s*'IFC4'\s*\)\s*\)/i.test(
          new TextDecoder().decode(source.slice(0, 8192)),
        )
      ) {
        throw new Error('This spike imports IFC4 models')
      }
      const sourceName =
        file.name.replace(/[^a-zA-Z0-9 ._-]/g, '_').slice(0, 150) || 'Imported IFC4.ifc'
      const sourceHash = createHash('sha256').update(source).digest('hex')
      const artifactId = randomUUID()
      const directory = artifactDirectory(artifactId)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'source.ifc'), source, { mode: 0o600, flag: 'wx' })
      const converted = await convertIfcToPascal(source, undefined, {
        simplify: false,
        wasmPath: WASM_PATH,
      })
      const graph = converted as unknown as RoundtripGraph
      const root = Object.values(graph.nodes).find((node) => node.type === 'site')
      if (!root) throw new Error('The imported model needs a site for its source reference')
      root.metadata = {
        ...(root.metadata as Record<string, unknown> | undefined),
        ifcRoundtrip: { artifactId, manifestVersion: 1, sourceHash },
      }
      const validated = apiGraphSchema.parse(graph)
      const operations = await getSceneOperations()
      const meta = await operations.saveScene({ name: sourceName, graph: validated as never })
      const artifact: Artifact = {
        manifestVersion: 1,
        artifactId,
        sceneId: meta.id,
        sourceName,
        sourceHash,
        sourceSchema: 'IFC4',
        createdAt: new Date().toISOString(),
        importedGraph: validated as unknown as RoundtripGraph,
        baseline: null,
      }
      await writeArtifact(artifact)
      await event('import', {
        sceneId: meta.id,
        artifactId,
        sourceHash,
        sourceBytes: source.length,
        nodeCount: Object.keys(graph.nodes).length,
      })
      return sceneApiJson(
        request,
        { meta, graph: validated, artifactId, baselineReady: false },
        { status: 201 },
      )
    }
    const body = (await request.json()) as {
      sceneId?: string
      graph?: unknown
      expectedVersion?: number
    }
    if (typeof body.sceneId !== 'string' || !body.sceneId) throw new Error('A scene ID is required')
    const { operations, stored, graph } = await loadScene(body.sceneId)
    const { artifact, source } = await readArtifact(graph, body.sceneId)
    if (action === 'baseline') {
      if (artifact.baseline)
        return sceneApiJson(request, { baselineReady: true, version: stored.version, graph })
      const baseline = apiGraphSchema.parse(body.graph) as unknown as RoundtripGraph
      const added = validateHydratedBaseline(artifact.importedGraph, baseline, {
        artifactId: artifact.artifactId,
        sourceHash: artifact.sourceHash,
      })
      const meta = await operations.saveScene({
        id: stored.id,
        name: stored.name,
        graph: baseline as never,
        expectedVersion: stored.version,
      })
      artifact.baseline = baseline
      artifact.editorDerivedNodeIds = added
      await writeArtifact(artifact)
      await event('baseline', {
        sceneId: stored.id,
        artifactId: artifact.artifactId,
        version: meta.version,
        nodeCount: Object.keys(baseline.nodes).length,
        editorDerivedNodeIds: added,
      })
      return sceneApiJson(request, { baselineReady: true, version: meta.version, graph: baseline })
    }
    if (action === 'export') {
      if (!Number.isInteger(body.expectedVersion) || body.expectedVersion !== stored.version) {
        return sceneApiJson(
          request,
          { error: 'Scene changed after saving. Save or reopen before exporting.' },
          { status: 409 },
        )
      }
      if (!artifact.baseline)
        throw new Error('The editor is still preparing the original IFC baseline')
      const result = await exportEditedSource({
        source,
        baseline: artifact.baseline,
        current: graph,
        wasmPath: WASM_PATH,
        editorDerivedNodeIds: artifact.editorDerivedNodeIds ?? [],
      })
      await event('export', {
        sceneId: stored.id,
        artifactId: artifact.artifactId,
        sceneVersion: stored.version,
        report: result.report,
      })
      const filename = `${artifact.sourceName.replace(/\.ifc$/i, '')}-edited.ifc`
      return withSceneApiHeaders(
        request,
        new NextResponse(Buffer.from(result.bytes), {
          headers: {
            'Content-Type': 'application/x-step',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'X-Ifc-Roundtrip-Report': JSON.stringify(result.report),
            'X-Ifc-Scene-Version': String(stored.version),
          },
        }),
      )
    }
    throw new Error('Choose import, baseline or export')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'IFC roundtrip operation failed'
    await event('error', { action: request.nextUrl.searchParams.get('action'), message }).catch(
      () => undefined,
    )
    return sceneApiJson(request, { error: message }, { status: 422 })
  }
}
