'use client'

import {
  type AnyNodeId,
  acquireSceneReadOnlyLease,
  resolveBuildingForLevel,
  resolveLevelId,
  useScene,
} from '@pascal-app/core'
import { type SceneGraph, useEditor } from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SceneLoader, type SceneMeta } from '@/components/scene-loader'
import { sceneGraphSignature } from '@/lib/scene-signature'

interface ArtifactInfo {
  artifactId: string
  baselineReady: boolean
  sourceName: string
  sourceHash: string
  exportSupport?: string
}

interface StoredScene extends SceneMeta {
  graph: SceneGraph
}

interface LoadedScene {
  scene: StoredScene
  artifact: ArtifactInfo
}

type Operation = 'import' | 'save' | 'reopen' | 'export'

const buttonClass =
  'rounded-md border border-border bg-background px-3 py-1.5 font-medium text-xs hover:bg-accent disabled:cursor-wait disabled:opacity-50'

function serializeSceneGraph(state: ReturnType<typeof useScene.getState>): SceneGraph {
  const { nodes, rootNodeIds, collections, materials, installedPlugins } = state
  return JSON.parse(
    JSON.stringify({ nodes, rootNodeIds, collections, materials, installedPlugins }),
  )
}

function hasHydratedGraph(graph: SceneGraph, artifactId: string): boolean {
  const state = useScene.getState()
  if (!Object.keys(graph.nodes).every((id) => id in state.nodes)) return false
  if (!graph.rootNodeIds.every((id) => state.rootNodeIds.includes(id as AnyNodeId))) return false
  return Object.values(state.nodes).some(
    (node) =>
      node.type === 'site' &&
      (node.metadata?.ifcRoundtrip as { artifactId?: string } | undefined)?.artifactId ===
        artifactId,
  )
}

async function responseError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: string
    message?: string
    details?: unknown
  } | null
  const detail = typeof body?.details === 'string' ? body.details : body?.message
  return new Error(detail ?? body?.error ?? `Request failed (${response.status})`)
}

async function loadSavedScene(sceneId: string): Promise<StoredScene> {
  const response = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}`, {
    cache: 'no-store',
  })
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<StoredScene>
}

async function flushScene(
  sceneId: string,
  graph: SceneGraph,
  verifiedVersion: () => number,
): Promise<StoredScene> {
  const signature = sceneGraphSignature(graph)
  // Let the editor's one-second autosave debounce drain before starting a host PUT.
  // Otherwise two writers in this same tab race with the same scene version.
  const nativeSaveDeadline = Date.now() + 1500
  while (Date.now() < nativeSaveDeadline) {
    const current = await loadSavedScene(sceneId)
    if (sceneGraphSignature(current.graph) === signature) return current
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  // Accept a completed autosave only when its graph is exactly this snapshot.
  // A newer, different graph belongs to an unverified writer and must not be replaced.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await loadSavedScene(sceneId)
    if (sceneGraphSignature(current.graph) === signature) return current
    const expectedVersion = verifiedVersion()
    if (current.version !== expectedVersion)
      throw new Error(
        'The saved scene changed. Reopen it before continuing so other edits are preserved.',
      )
    const response = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': String(expectedVersion),
      },
      body: JSON.stringify({ name: current.name, graph }),
    })
    if (response.status === 409) {
      const error = await responseError(response)
      if (error.message !== 'version_conflict') throw error
      const concurrent = await loadSavedScene(sceneId)
      if (sceneGraphSignature(concurrent.graph) === signature) return concurrent
      throw new Error('Another save changed this scene. Reopen it before continuing.')
    }
    if (!response.ok) throw await responseError(response)
    const saved = await loadSavedScene(sceneId)
    if (sceneGraphSignature(saved.graph) === signature) return saved
  }
  throw new Error('The scene kept changing during save. Try saving again before exporting.')
}

function sceneUrl(sceneId: string): string {
  return `/ifc-roundtrip?scene=${encodeURIComponent(sceneId)}&disable=postFx`
}

export function RoundtripClient() {
  const sceneId = useSearchParams().get('scene')
  const [loaded, setLoaded] = useState<LoadedScene | null>(null)
  const [ready, setReady] = useState(false)
  const [operation, setOperation] = useState<Operation | null>(null)
  const [status, setStatus] = useState('Import an IFC4 file to begin.')
  const [error, setError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [preparationAttempt, setPreparationAttempt] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const verifiedSave = useRef({ sceneId: '', version: 0 })
  const onLocalSave = useCallback((meta: SceneMeta) => {
    if (verifiedSave.current.sceneId === meta.id)
      verifiedSave.current.version = Math.max(verifiedSave.current.version, meta.version)
  }, [])
  const nodes = useScene((state) => state.nodes)
  const selectedId = useViewer((state) => state.selection.selectedIds[0] ?? '')
  const walls = useMemo(() => Object.values(nodes).filter((node) => node.type === 'wall'), [nodes])

  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter intentionally restarts a failed load.
  useEffect(() => {
    if (!sceneId) return
    let cancelled = false
    setLoaded(null)
    setReady(false)
    setError(null)
    setStatus('Loading saved scene…')
    const load = async () => {
      const [scene, artifactResponse] = await Promise.all([
        loadSavedScene(sceneId),
        fetch(`/api/ifc-roundtrip?scene=${encodeURIComponent(sceneId)}`, { cache: 'no-store' }),
      ])
      if (!artifactResponse.ok) throw await responseError(artifactResponse)
      const artifact = (await artifactResponse.json()) as ArtifactInfo
      if (!cancelled) {
        verifiedSave.current = { sceneId: scene.id, version: scene.version }
        setLoaded({ scene, artifact })
      }
    }
    load().catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Scene load failed')
    })
    return () => {
      cancelled = true
    }
  }, [sceneId, loadAttempt])

  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter intentionally restarts failed preparation.
  useEffect(() => {
    if (!loaded) return
    let cancelled = false
    let preparing = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let releaseReadOnly: (() => void) | undefined
    setReady(false)
    setError(null)
    setStatus('Preparing the imported model…')
    const timeout = setTimeout(() => {
      if (!cancelled && !preparing)
        setError('The imported scene has not finished loading. Retry preparation.')
    }, 30_000)

    const prepare = async () => {
      if (cancelled || preparing) return
      if (!hasHydratedGraph(loaded.scene.graph, loaded.artifact.artifactId)) return
      preparing = true
      clearTimeout(timeout)
      releaseReadOnly = acquireSceneReadOnlyLease()
      try {
        if (!loaded.artifact.baselineReady) {
          const response = await fetch('/api/ifc-roundtrip?action=baseline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sceneId: loaded.scene.id,
              graph: serializeSceneGraph(useScene.getState()),
            }),
          })
          if (!response.ok) throw await responseError(response)
          const result = (await response.json()) as {
            baselineReady: boolean
            version: number
            graph: SceneGraph
          }
          if (!result.baselineReady)
            throw new Error('The IFC export baseline could not be prepared.')
          if (!cancelled) {
            verifiedSave.current = { sceneId: loaded.scene.id, version: result.version }
            setLoaded({
              artifact: { ...loaded.artifact, baselineReady: true },
              scene: {
                ...loaded.scene,
                version: result.version,
                graph: result.graph,
                nodeCount: Object.keys(result.graph.nodes).length,
              },
            })
          }
          return
        }
        if (!cancelled) {
          setReady(true)
          setStatus('Ready. Rename a wall in the Scene tree or change its height in the inspector.')
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Preparation failed')
      } finally {
        releaseReadOnly?.()
        releaseReadOnly = undefined
      }
    }
    const check = () => {
      if (preparing || !hasHydratedGraph(loaded.scene.graph, loaded.artifact.artifactId)) return
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => void prepare(), 250)
    }
    const unsubscribe = useScene.subscribe(check)
    check()
    return () => {
      cancelled = true
      clearTimeout(timeout)
      if (settleTimer) clearTimeout(settleTimer)
      releaseReadOnly?.()
      unsubscribe()
    }
  }, [loaded, preparationAttempt])

  const importFile = useCallback(async (file: File) => {
    setOperation('import')
    setError(null)
    setStatus(`Importing ${file.name}…`)
    try {
      const form = new FormData()
      form.set('file', file)
      const response = await fetch('/api/ifc-roundtrip?action=import', {
        method: 'POST',
        body: form,
      })
      if (!response.ok) throw await responseError(response)
      const result = (await response.json()) as { meta: SceneMeta }
      window.location.assign(sceneUrl(result.meta.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Import failed')
      setOperation(null)
    }
  }, [])

  const runOperation = useCallback(
    async (action: Exclude<Operation, 'import'>) => {
      if (!loaded || !ready || operation) return
      setOperation(action)
      setError(null)
      setStatus(action === 'export' ? 'Saving the current scene before export…' : 'Saving scene…')
      const releaseReadOnly = acquireSceneReadOnlyLease()
      try {
        const graph = serializeSceneGraph(useScene.getState())
        const saved = await flushScene(loaded.scene.id, graph, () => verifiedSave.current.version)
        verifiedSave.current.version = saved.version
        if (action === 'reopen') {
          window.location.assign(sceneUrl(saved.id))
          return
        }
        if (action === 'save') {
          setStatus(`Saved scene (version ${saved.version}).`)
          return
        }
        const response = await fetch('/api/ifc-roundtrip?action=export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneId: saved.id, expectedVersion: saved.version }),
        })
        if (!response.ok) throw await responseError(response)
        const blob = await response.blob()
        const disposition = response.headers.get('Content-Disposition')
        const filename =
          disposition?.match(/filename="([^"]+)"/)?.[1] ??
          loaded.artifact.sourceName.replace(/\.ifc$/i, '-roundtrip.ifc')
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.append(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setStatus(`Exported ${filename} from saved scene version ${saved.version}.`)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Operation failed')
      } finally {
        releaseReadOnly()
        setOperation(null)
      }
    },
    [loaded, ready, operation],
  )

  const selectWall = (id: string) => {
    const wall = useScene.getState().nodes[id as AnyNodeId]
    if (wall?.type !== 'wall') return
    const currentNodes = useScene.getState().nodes
    const levelId = resolveLevelId(wall, currentNodes)
    const level = currentNodes[levelId as AnyNodeId]
    if (level?.type !== 'level') return
    const buildingId = resolveBuildingForLevel(level.id, currentNodes)
    const building = buildingId ? currentNodes[buildingId] : null
    if (building?.type !== 'building') return
    useEditor.getState().setPhase('structure')
    useEditor.getState().armToolMode({ mode: 'select' })
    useViewer
      .getState()
      .setSelection({ buildingId: building.id, levelId: level.id, selectedIds: [wall.id] })
  }

  return (
    <main className="relative min-h-screen bg-background text-foreground">
      {loaded && (
        <SceneLoader
          initialScene={loaded.scene.graph}
          key={`${loaded.scene.id}:${loaded.scene.version}`}
          meta={loaded.scene}
          onLocalSave={onLocalSave}
        />
      )}
      {loaded && !ready && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm">
          <div className="max-w-md rounded-xl border border-border bg-background p-5 text-center shadow-lg">
            <p role="status">{status}</p>
            {error && (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
            {error && (
              <button
                className={`${buttonClass} mt-4`}
                onClick={() => setPreparationAttempt((value) => value + 1)}
                type="button"
              >
                Retry preparation
              </button>
            )}
          </div>
        </div>
      )}
      <section
        aria-label="IFC roundtrip controls"
        className={
          loaded
            ? 'fixed bottom-24 left-1/2 z-40 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-border bg-background/95 p-3 shadow-lg backdrop-blur-sm'
            : 'mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6'
        }
      >
        <h1 className="font-semibold text-sm">IFC4 roundtrip · editor workflow spike</h1>
        <p className="mt-1 text-muted-foreground text-xs">
          {loaded?.artifact.sourceName ??
            'Import a model, edit it in Pascal, save, reopen, and export IFC.'}
        </p>
        <p className="mt-1 text-muted-foreground text-xs">
          Supported export edits: names and straight wall heights. Other changes block export.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            accept=".ifc"
            aria-label="IFC file"
            className="hidden"
            disabled={operation !== null}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void importFile(file)
            }}
            ref={fileInput}
            type="file"
          />
          <button
            className={buttonClass}
            disabled={operation !== null}
            onClick={() => fileInput.current?.click()}
            type="button"
          >
            {operation === 'import' ? 'Importing…' : 'Import IFC'}
          </button>
          {loaded && (
            <>
              <button
                className={buttonClass}
                disabled={!ready || operation !== null}
                onClick={() => void runOperation('save')}
                type="button"
              >
                Save scene
              </button>
              <button
                className={buttonClass}
                disabled={!ready || operation !== null}
                onClick={() => void runOperation('reopen')}
                type="button"
              >
                Reopen saved scene
              </button>
              <button
                className={buttonClass}
                disabled={!ready || operation !== null}
                onClick={() => void runOperation('export')}
                type="button"
              >
                Export IFC
              </button>
            </>
          )}
          {!loaded && sceneId && error && (
            <button
              className={buttonClass}
              onClick={() => setLoadAttempt((value) => value + 1)}
              type="button"
            >
              Retry load
            </button>
          )}
        </div>
        {loaded && ready && walls.length > 0 && (
          <label className="mt-3 flex items-center gap-2 text-xs">
            Select wall
            <select
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1"
              disabled={operation !== null}
              onChange={(event) => selectWall(event.target.value)}
              value={walls.some((wall) => wall.id === selectedId) ? selectedId : ''}
            >
              <option value="">Choose a wall for the native inspector</option>
              {walls.map((wall) => (
                <option key={wall.id} value={wall.id}>
                  {wall.name || wall.id}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="mt-2 text-muted-foreground text-xs" role="status">
          {status}
        </p>
        {error && (
          <p className="mt-2 text-destructive text-xs" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  )
}
