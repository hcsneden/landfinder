import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { userApi, parcelApi } from '../../services/api';
import { formatAcreage, formatDate } from '@landfinder/shared';
import type { SavedParcel, Parcel } from '@landfinder/shared';

interface SavedParcelWithDetails extends SavedParcel {
  parcelDetails?: Parcel;
}

function SavedParcelCard({ item }: { item: SavedParcelWithDetails }) {
  const handlePress = () => {
    router.push(`/parcel/${item.parcelId}`);
  };

  return (
    <TouchableOpacity style={styles.card} onPress={handlePress}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardAcreage}>
          {item.parcelDetails ? formatAcreage(item.parcelDetails.acreage) : 'Loading...'}
        </Text>
        <Text style={styles.savedDate}>Saved {formatDate(item.savedAt)}</Text>
      </View>

      <Text style={styles.cardAddress} numberOfLines={2}>
        {item.parcelDetails?.address ||
         (item.parcelDetails?.county ? `${item.parcelDetails.county} County, MT` : 'Montana')}
      </Text>

      {item.notes && (
        <View style={styles.notesContainer}>
          <Text style={styles.notesLabel}>Notes:</Text>
          <Text style={styles.notesText} numberOfLines={2}>
            {item.notes}
          </Text>
        </View>
      )}

      <View style={styles.cardFooter}>
        <Text style={styles.parcelId}>
          {item.parcelDetails?.parcelNumber || item.parcelId.slice(0, 8)}
        </Text>
        <Text style={styles.viewDetails}>View Details →</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function SavedScreen() {
  const savedQuery = useQuery({
    queryKey: ['savedParcels'],
    queryFn: async () => {
      const response = await userApi.getSavedParcels();
      if (response.data) {
        // Fetch parcel details for each saved parcel
        const withDetails = await Promise.all(
          response.data.map(async (saved) => {
            try {
              const parcelResponse = await parcelApi.getParcel(saved.parcelId);
              return {
                ...saved,
                parcelDetails: parcelResponse.data,
              };
            } catch {
              return saved;
            }
          })
        );
        return withDetails;
      }
      throw new Error(response.error?.message || 'Failed to fetch saved parcels');
    },
  });

  return (
    <View style={styles.container}>
      <FlatList
        data={savedQuery.data || []}
        keyExtractor={(item) => `${item.userId}-${item.parcelId}`}
        renderItem={({ item }) => <SavedParcelCard item={item} />}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyEmoji}>❤️</Text>
            <Text style={styles.emptyText}>No Saved Parcels</Text>
            <Text style={styles.emptySubtext}>
              Save parcels while searching to keep track of properties you're interested in
            </Text>
          </View>
        }
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={savedQuery.isFetching}
            onRefresh={() => savedQuery.refetch()}
            tintColor="#1a5f2a"
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  listContent: {
    padding: 16,
    paddingBottom: 32,
    flexGrow: 1,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  cardAcreage: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1a5f2a',
  },
  savedDate: {
    fontSize: 11,
    color: '#999',
  },
  cardAddress: {
    fontSize: 14,
    color: '#333',
    marginBottom: 8,
  },
  notesContainer: {
    backgroundColor: '#fef9e7',
    padding: 10,
    borderRadius: 6,
    marginBottom: 8,
  },
  notesLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#b7950b',
    marginBottom: 2,
  },
  notesText: {
    fontSize: 12,
    color: '#7d6608',
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 8,
  },
  parcelId: {
    fontSize: 11,
    color: '#999',
    fontFamily: 'monospace',
  },
  viewDetails: {
    fontSize: 12,
    color: '#1a5f2a',
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyEmoji: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    lineHeight: 20,
  },
});
