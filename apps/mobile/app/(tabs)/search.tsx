import { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { searchApi, parcelApi } from '../../services/api';
import {
  MONTANA_COUNTIES,
  formatAcreage,
  formatPrice,
} from '@lastbestland/shared';
import type { SearchCriteria, SearchResult } from '@lastbestland/shared';

function SearchFilters({
  criteria,
  onUpdate,
}: {
  criteria: SearchCriteria;
  onUpdate: (updates: Partial<SearchCriteria>) => void;
}) {
  const [showCountyPicker, setShowCountyPicker] = useState(false);

  return (
    <View style={styles.filtersContainer}>
      <Text style={styles.filterTitle}>Search Montana Land</Text>

      <View style={styles.filterRow}>
        <View style={styles.filterField}>
          <Text style={styles.filterLabel}>Min Acreage</Text>
          <TextInput
            style={styles.filterInput}
            placeholder="e.g., 2"
            placeholderTextColor="#999"
            keyboardType="numeric"
            value={criteria.minAcreage?.toString() || ''}
            onChangeText={(text) =>
              onUpdate({ minAcreage: text ? parseFloat(text) : undefined })
            }
          />
        </View>
        <View style={styles.filterField}>
          <Text style={styles.filterLabel}>Max Acreage</Text>
          <TextInput
            style={styles.filterInput}
            placeholder="e.g., 100"
            placeholderTextColor="#999"
            keyboardType="numeric"
            value={criteria.maxAcreage?.toString() || ''}
            onChangeText={(text) =>
              onUpdate({ maxAcreage: text ? parseFloat(text) : undefined })
            }
          />
        </View>
      </View>

      <View style={styles.filterRow}>
        <View style={styles.filterField}>
          <Text style={styles.filterLabel}>Min Price</Text>
          <TextInput
            style={styles.filterInput}
            placeholder="$0"
            placeholderTextColor="#999"
            keyboardType="numeric"
            value={criteria.minPrice?.toString() || ''}
            onChangeText={(text) =>
              onUpdate({ minPrice: text ? parseFloat(text) : undefined })
            }
          />
        </View>
        <View style={styles.filterField}>
          <Text style={styles.filterLabel}>Max Price</Text>
          <TextInput
            style={styles.filterInput}
            placeholder="No max"
            placeholderTextColor="#999"
            keyboardType="numeric"
            value={criteria.maxPrice?.toString() || ''}
            onChangeText={(text) =>
              onUpdate({ maxPrice: text ? parseFloat(text) : undefined })
            }
          />
        </View>
      </View>

      <View style={styles.filterField}>
        <Text style={styles.filterLabel}>County (Optional)</Text>
        <TouchableOpacity
          style={styles.filterInput}
          onPress={() => setShowCountyPicker(!showCountyPicker)}
        >
          <Text style={criteria.county ? styles.filterInputText : styles.filterInputPlaceholder}>
            {criteria.county || 'Select County'}
          </Text>
        </TouchableOpacity>
        {showCountyPicker && (
          <ScrollView style={styles.countyPicker} nestedScrollEnabled>
            <TouchableOpacity
              style={styles.countyOption}
              onPress={() => {
                onUpdate({ county: undefined });
                setShowCountyPicker(false);
              }}
            >
              <Text style={styles.countyOptionText}>All Counties</Text>
            </TouchableOpacity>
            {MONTANA_COUNTIES.map((county) => (
              <TouchableOpacity
                key={county}
                style={[
                  styles.countyOption,
                  criteria.county === county && styles.countyOptionSelected,
                ]}
                onPress={() => {
                  onUpdate({ county });
                  setShowCountyPicker(false);
                }}
              >
                <Text
                  style={[
                    styles.countyOptionText,
                    criteria.county === county && styles.countyOptionTextSelected,
                  ]}
                >
                  {county}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>

      <TouchableOpacity
        style={[
          styles.waterRightsToggle,
          criteria.waterRightsRequired && styles.waterRightsToggleActive,
        ]}
        onPress={() =>
          onUpdate({ waterRightsRequired: !criteria.waterRightsRequired })
        }
      >
        <Text
          style={[
            styles.waterRightsText,
            criteria.waterRightsRequired && styles.waterRightsTextActive,
          ]}
        >
          💧 Water Rights Required
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function SearchResultCard({ result }: { result: SearchResult }) {
  const handlePress = () => {
    router.push(`/parcel/${result.parcel.id}`);
  };

  return (
    <TouchableOpacity style={styles.resultCard} onPress={handlePress}>
      <View style={styles.resultHeader}>
        <Text style={styles.resultAcreage}>
          {formatAcreage(result.parcel.acreage)}
        </Text>
        {result.hasWaterRights && (
          <Text style={styles.waterBadge}>💧 Water Rights</Text>
        )}
      </View>

      <Text style={styles.resultAddress} numberOfLines={2}>
        {result.parcel.address || `${result.parcel.county || 'Unknown'} County, MT`}
      </Text>

      {result.listing && (
        <Text style={styles.resultPrice}>{formatPrice(result.listing.price)}</Text>
      )}

      {result.previewInsight && (
        <Text style={styles.resultInsight} numberOfLines={2}>
          {result.previewInsight}
        </Text>
      )}

      <View style={styles.resultFooter}>
        <Text style={styles.resultParcelId}>
          Parcel: {result.parcel.parcelNumber || 'N/A'}
        </Text>
        <Text style={styles.viewDetails}>View Details →</Text>
      </View>
    </TouchableOpacity>
  );
}

function LookupBar() {
  const [query, setQuery] = useState('');
  const [isLooking, setIsLooking] = useState(false);

  const handleLookup = async () => {
    const q = query.trim();
    if (!q) return;
    setIsLooking(true);
    const res = await parcelApi.lookupParcel(q);
    setIsLooking(false);
    if (res.success && res.data) {
      router.push(`/parcel/${res.data.id}`);
    } else {
      Alert.alert(
        'Not Found',
        res.error?.code === '404'
          ? 'No parcel found. Try a street address, parcel number, or geocode.'
          : (res.error?.message ?? 'Lookup failed')
      );
    }
  };

  return (
    <View style={lookupStyles.container}>
      <Text style={lookupStyles.label}>Quick Lookup</Text>
      <View style={lookupStyles.row}>
        <TextInput
          style={lookupStyles.input}
          placeholder="Address, parcel number, or geocode…"
          placeholderTextColor="#999"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={handleLookup}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isLooking}
        />
        <TouchableOpacity
          style={[lookupStyles.btn, (!query.trim() || isLooking) && lookupStyles.btnDisabled]}
          onPress={handleLookup}
          disabled={!query.trim() || isLooking}
        >
          {isLooking
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={lookupStyles.btnText}>Go</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const lookupStyles = StyleSheet.create({
  container: {
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
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#f8f8f8',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  btn: {
    backgroundColor: '#1a5f2a',
    borderRadius: 8,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 52,
  },
  btnDisabled: {
    backgroundColor: '#88b892',
  },
  btnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
});

export default function SearchScreen() {
  const [criteria, setCriteria] = useState<SearchCriteria>({
    state: 'MT',
    waterRightsRequired: false,
  });
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);

  const updateCriteria = useCallback((updates: Partial<SearchCriteria>) => {
    setCriteria((prev) => ({ ...prev, ...updates }));
  }, []);

  const searchMutation = useMutation({
    mutationFn: async () => {
      const response = await searchApi.submitSearch(criteria);
      if (response.data) {
        setCurrentJobId(response.data.id);
        return response.data;
      }
      throw new Error(response.error?.message || 'Search failed');
    },
  });

  const resultsQuery = useQuery({
    queryKey: ['searchResults', currentJobId],
    queryFn: async () => {
      if (!currentJobId) return null;
      const response = await searchApi.getSearchResults(currentJobId);
      if (response.data) {
        return response.data;
      }
      throw new Error(response.error?.message || 'Failed to fetch results');
    },
    enabled: !!currentJobId,
    refetchInterval: (query) => {
      // Poll while search is in progress
      return query.state.data === null ? 2000 : false;
    },
  });

  const handleSearch = () => {
    searchMutation.mutate();
  };

  const isSearching = searchMutation.isPending || resultsQuery.isFetching;

  return (
    <View style={styles.container}>
      <FlatList
        data={resultsQuery.data?.items || []}
        keyExtractor={(item) => item.parcel.id}
        renderItem={({ item }) => <SearchResultCard result={item} />}
        ListHeaderComponent={
          <>
            <LookupBar />
            <SearchFilters criteria={criteria} onUpdate={updateCriteria} />
            <TouchableOpacity
              style={[styles.searchButton, isSearching && styles.searchButtonDisabled]}
              onPress={handleSearch}
              disabled={isSearching}
            >
              {isSearching ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.searchButtonText}>Search Land</Text>
              )}
            </TouchableOpacity>
          </>
        }
        ListEmptyComponent={
          currentJobId && !isSearching ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No results found</Text>
              <Text style={styles.emptySubtext}>
                Try adjusting your search criteria
              </Text>
            </View>
          ) : !currentJobId ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>Start Your Search</Text>
              <Text style={styles.emptySubtext}>
                Set your filters and tap "Search Land" to find properties
              </Text>
            </View>
          ) : null
        }
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={resultsQuery.isFetching}
            onRefresh={() => resultsQuery.refetch()}
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
  },
  filtersContainer: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  filterTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1a5f2a',
    marginBottom: 16,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  filterField: {
    flex: 1,
    marginBottom: 12,
  },
  filterLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
    marginBottom: 6,
  },
  filterInput: {
    backgroundColor: '#f8f8f8',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  filterInputText: {
    color: '#333',
  },
  filterInputPlaceholder: {
    color: '#999',
  },
  countyPicker: {
    maxHeight: 200,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    marginTop: 4,
  },
  countyOption: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  countyOptionSelected: {
    backgroundColor: '#e8f5e9',
  },
  countyOptionText: {
    fontSize: 14,
    color: '#333',
  },
  countyOptionTextSelected: {
    color: '#1a5f2a',
    fontWeight: '600',
  },
  waterRightsToggle: {
    padding: 14,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#e0e0e0',
    alignItems: 'center',
    marginTop: 4,
  },
  waterRightsToggleActive: {
    borderColor: '#1a5f2a',
    backgroundColor: '#e8f5e9',
  },
  waterRightsText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  waterRightsTextActive: {
    color: '#1a5f2a',
  },
  searchButton: {
    backgroundColor: '#1a5f2a',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginBottom: 24,
    shadowColor: '#1a5f2a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  searchButtonDisabled: {
    backgroundColor: '#88b892',
  },
  searchButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  resultCard: {
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
  resultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  resultAcreage: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1a5f2a',
  },
  waterBadge: {
    fontSize: 12,
    backgroundColor: '#e3f2fd',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    color: '#1565c0',
  },
  resultAddress: {
    fontSize: 14,
    color: '#333',
    marginBottom: 8,
  },
  resultPrice: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
  },
  resultInsight: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  resultFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 8,
  },
  resultParcelId: {
    fontSize: 11,
    color: '#999',
  },
  viewDetails: {
    fontSize: 12,
    color: '#1a5f2a',
    fontWeight: '600',
  },
  emptyContainer: {
    alignItems: 'center',
    padding: 32,
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
  },
});
