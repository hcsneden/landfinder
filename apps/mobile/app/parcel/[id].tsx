import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Linking,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import MapView, { Marker, Polygon } from 'react-native-maps';
import { parcelApi, userApi, unwrap } from '../../services/api';
import {
  formatAcreage,
  formatDate,
  formatWaterType,
  formatFlowRate,
  formatVolume,
} from '@lastbestland/shared';
import type { WaterRight, ParcelInsight } from '@lastbestland/shared';

function InfoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value || 'N/A'}</Text>
    </View>
  );
}

function WaterRightCard({ waterRight }: { waterRight: WaterRight }) {
  return (
    <View style={styles.waterRightCard}>
      <View style={styles.waterRightHeader}>
        <Text style={styles.waterRightNumber}>
          {waterRight.waterRightNumber || 'Unknown'}
        </Text>
        <View
          style={[
            styles.statusBadge,
            waterRight.status === 'active' && styles.statusActive,
            waterRight.status === 'inactive' && styles.statusInactive,
          ]}
        >
          <Text style={styles.statusText}>{waterRight.status}</Text>
        </View>
      </View>

      <View style={styles.waterRightDetails}>
        <View style={styles.waterRightRow}>
          <Text style={styles.waterRightLabel}>Source</Text>
          <Text style={styles.waterRightValue}>
            {waterRight.waterSource || 'Unknown'}
          </Text>
        </View>
        <View style={styles.waterRightRow}>
          <Text style={styles.waterRightLabel}>Type</Text>
          <Text style={styles.waterRightValue}>
            {formatWaterType(waterRight.waterType)}
          </Text>
        </View>
        {waterRight.flowRateGpm !== null && (
          <View style={styles.waterRightRow}>
            <Text style={styles.waterRightLabel}>Flow Rate</Text>
            <Text style={styles.waterRightValue}>
              {formatFlowRate(waterRight.flowRateGpm)}
            </Text>
          </View>
        )}
        {waterRight.volumeAcreFeet !== null && (
          <View style={styles.waterRightRow}>
            <Text style={styles.waterRightLabel}>Volume</Text>
            <Text style={styles.waterRightValue}>
              {formatVolume(waterRight.volumeAcreFeet)}
            </Text>
          </View>
        )}
        {waterRight.priorityDate && (
          <View style={styles.waterRightRow}>
            <Text style={styles.waterRightLabel}>Priority Date</Text>
            <Text style={styles.waterRightValue}>
              {formatDate(waterRight.priorityDate)}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function InsightCard({ insight }: { insight: ParcelInsight }) {
  return (
    <View style={styles.insightCard}>
      <Text style={styles.insightContent}>{insight.content}</Text>
      <Text style={styles.insightMeta}>Generated {formatDate(insight.createdAt)}</Text>
    </View>
  );
}

export default function ParcelDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const parcelQuery = useQuery({
    queryKey: ['parcel', id],
    queryFn: async () => unwrap(await parcelApi.getParcel(id)),
  });

  const waterRightsQuery = useQuery({
    queryKey: ['waterRights', id],
    queryFn: async () => unwrap(await parcelApi.getWaterRights(id)),
  });

  const insightsQuery = useQuery({
    queryKey: ['insights', id],
    queryFn: async () => unwrap(await parcelApi.getInsights(id)),
  });

  const saveMutation = useMutation({
    mutationFn: async () => unwrap(await userApi.saveParcel(id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['savedParcels'] });
      Alert.alert('Saved!', 'This parcel has been added to your saved list.');
    },
    onError: (error) => {
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to save parcel');
    },
  });

  if (parcelQuery.isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#1a5f2a" />
        <Text style={styles.loadingText}>Loading parcel details...</Text>
      </View>
    );
  }

  if (parcelQuery.error || !parcelQuery.data) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>Failed to load parcel details</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => parcelQuery.refetch()}
        >
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const parcel = parcelQuery.data;
  const waterRights = waterRightsQuery.data || [];
  const insights = insightsQuery.data || [];

  return (
    <ScrollView style={styles.container}>
      {parcel.coordinates && (
        <View style={styles.mapContainer}>
          <MapView
            style={styles.map}
            initialRegion={{
              latitude: parcel.coordinates.latitude,
              longitude: parcel.coordinates.longitude,
              latitudeDelta: 0.02,
              longitudeDelta: 0.02,
            }}
          >
            <Marker
              coordinate={{
                latitude: parcel.coordinates.latitude,
                longitude: parcel.coordinates.longitude,
              }}
              title={parcel.address || 'Parcel Location'}
            />
            {parcel.boundary && (
              <Polygon
                coordinates={parcel.boundary.coordinates[0].map(([lng, lat]) => ({
                  latitude: lat,
                  longitude: lng,
                }))}
                fillColor="rgba(26, 95, 42, 0.2)"
                strokeColor="#1a5f2a"
                strokeWidth={2}
              />
            )}
          </MapView>
        </View>
      )}

      <View style={styles.header}>
        <Text style={styles.acreage}>{formatAcreage(parcel.acreage)}</Text>
        <Text style={styles.address}>
          {parcel.address || `${parcel.county || 'Unknown'} County, ${parcel.state}`}
        </Text>
      </View>

      <View style={styles.actionContainer}>
        <TouchableOpacity
          style={[styles.saveButton, saveMutation.isPending && styles.saveButtonDisabled]}
          onPress={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.saveButtonText}>Save parcel</Text>
          )}
        </TouchableOpacity>
      </View>

      <InfoSection title="Property details">
        <InfoRow label="Parcel Number" value={parcel.parcelNumber} />
        <InfoRow label="Geocode" value={parcel.geoId} />
        <InfoRow label="County" value={parcel.county} />
        <InfoRow label="State" value={parcel.state} />
        <InfoRow label="Acreage" value={formatAcreage(parcel.acreage)} />
      </InfoSection>

      <InfoSection title={`Water rights (${waterRights.length})`}>
        {waterRightsQuery.isLoading ? (
          <ActivityIndicator color="#1a5f2a" />
        ) : waterRights.length === 0 ? (
          <Text style={styles.noDataText}>No water rights found for this parcel</Text>
        ) : (
          waterRights.map((wr) => <WaterRightCard key={wr.id} waterRight={wr} />)
        )}
      </InfoSection>

      <InfoSection title="Buildability summary">
        {insightsQuery.isLoading ? (
          <ActivityIndicator color="#1a5f2a" />
        ) : insights.length === 0 ? (
          <Text style={styles.noDataText}>No AI insights available yet</Text>
        ) : (
          insights.map((insight) => (
            <InsightCard key={insight.id} insight={insight} />
          ))
        )}
      </InfoSection>

      <View style={styles.bottomSpacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#666',
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
    padding: 32,
  },
  errorText: {
    fontSize: 16,
    color: '#e74c3c',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#1a5f2a',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  mapContainer: {
    height: 250,
    backgroundColor: '#e0e0e0',
  },
  map: {
    flex: 1,
  },
  header: {
    backgroundColor: '#fff',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  acreage: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#1a5f2a',
    marginBottom: 4,
  },
  address: {
    fontSize: 16,
    color: '#333',
    marginBottom: 8,
  },
  actionContainer: {
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  saveButton: {
    backgroundColor: '#1a5f2a',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
  },
  saveButtonDisabled: {
    backgroundColor: '#88b892',
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  section: {
    backgroundColor: '#fff',
    marginTop: 12,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  infoLabel: {
    fontSize: 14,
    color: '#666',
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
    textAlign: 'right',
    flex: 1,
    marginLeft: 16,
  },
  noDataText: {
    fontSize: 14,
    color: '#999',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 16,
  },
  waterRightCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#2196f3',
  },
  waterRightHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  waterRightNumber: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    fontFamily: 'monospace',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: '#e0e0e0',
  },
  statusActive: {
    backgroundColor: '#c8e6c9',
  },
  statusInactive: {
    backgroundColor: '#ffcdd2',
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  waterRightDetails: {
    gap: 6,
  },
  waterRightRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  waterRightLabel: {
    fontSize: 12,
    color: '#666',
  },
  waterRightValue: {
    fontSize: 12,
    color: '#333',
    fontWeight: '500',
  },
  insightCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
  },
  insightContent: {
    fontSize: 14,
    color: '#444',
    lineHeight: 20,
    marginBottom: 8,
  },
  insightMeta: {
    fontSize: 11,
    color: '#999',
    fontStyle: 'italic',
  },
  bottomSpacer: {
    height: 32,
  },
});
