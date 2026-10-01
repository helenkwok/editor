import { Suspense } from 'react'
import { RoundtripClient } from './roundtrip-client'

export default function IfcRoundtripPage() {
  return (
    <Suspense fallback={<p role="status">Loading IFC roundtrip…</p>}>
      <RoundtripClient />
    </Suspense>
  )
}
