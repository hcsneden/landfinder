import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Button } from '@hcsneden/design-library'
import { useStore } from '../store'
import { parcelApi, userApi, unwrap } from '../services/api'
import { formatAcreage, formatDate } from '@lastbestland/shared'
import type { SavedParcel } from '@lastbestland/shared'

export function SavedPanel() {
  const navigate = useNavigate()
  const isSignedIn = useStore((state) => state.tokens !== null)

  const savedQuery = useQuery({
    queryKey: ['savedParcels'],
    queryFn: () => userApi.getSavedParcels().then(unwrap),
    // Anonymous visitors have nothing to load, and the request would 401.
    enabled: isSignedIn,
  })

  if (!isSignedIn) {
    return (
      <div className="saved-panel">
        <div className="saved-empty">
          <div className="saved-empty-title">Sign in to save properties</div>
          <div className="saved-empty-sub">
            Searching and parcel details are open to everyone. An account only keeps
            a list of the parcels you want to come back to.
          </div>
          <Button variant="primary" size="sm" onClick={() => navigate('/auth')}>
            Sign in
          </Button>
        </div>
      </div>
    )
  }

  if (savedQuery.isLoading) {
    return <div className="saved-panel"><div className="saved-empty">Loading saved properties…</div></div>
  }
  if (savedQuery.isError) {
    return <div className="saved-panel"><div className="panel-error">Could not load saved properties.</div></div>
  }

  const saved = savedQuery.data ?? []
  if (saved.length === 0) {
    return (
      <div className="saved-panel">
        <div className="saved-empty">
          <div className="saved-empty-title">No saved properties yet</div>
          <div className="saved-empty-sub">
            Look up a parcel and choose <strong>Save parcel</strong> to keep it here.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="saved-panel">
      <div className="saved-count">{saved.length} saved {saved.length === 1 ? 'property' : 'properties'}</div>
      <div className="saved-list">
        {saved.map((savedParcel) => (
          <SavedParcelRow key={savedParcel.parcelId} saved={savedParcel} />
        ))}
      </div>
    </div>
  )
}

function SavedParcelRow({ saved }: { saved: SavedParcel }) {
  const setSelectedParcel = useStore((state) => state.setSelectedParcel)
  const queryClient = useQueryClient()

  const parcelQuery = useQuery({
    queryKey: ['parcel', saved.parcelId],
    queryFn: () => parcelApi.getParcel(saved.parcelId).then(unwrap),
  })
  const removeSavedMutation = useMutation({
    mutationFn: () => userApi.removeSavedParcel(saved.parcelId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['savedParcels'] }),
  })

  const parcel = parcelQuery.data
  const location = parcel?.address ?? (parcel?.county ? `${parcel.county} County, MT` : null) ?? saved.parcelId

  return (
    <div className="saved-item">
      <button className="saved-item-main" onClick={() => setSelectedParcel(saved.parcelId)} type="button">
        <span className="saved-acres">{parcelQuery.isLoading ? '…' : formatAcreage(parcel?.acreage ?? null)}</span>
        <span className="saved-location">{location}</span>
        <span className="saved-meta">
          Saved {formatDate(saved.savedAt)}
          {saved.notes ? ` · ${saved.notes}` : ''}
        </span>
      </button>
      <button
        className="saved-remove"
        onClick={() => removeSavedMutation.mutate()}
        disabled={removeSavedMutation.isPending}
        title="Remove from saved"
        type="button"
      >
        {removeSavedMutation.isPending ? '…' : '✕'}
      </button>
    </div>
  )
}
