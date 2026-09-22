import { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import { router } from 'expo-router';
import { lookupParcelOrAlert } from '../../services/lookup';
import { formatAcreage } from '@lastbestland/shared';
import type { Parcel } from '@lastbestland/shared';

const MONTANA_REGION: Region = {
  latitude: 46.9,
  longitude: -109.5,
  latitudeDelta: 8,
  longitudeDelta: 10,
};

export default function MapScreen() {
  const [query, setQuery] = useState('');
  const [isLooking, setIsLooking] = useState(false);
  const [lookedUpParcel, setLookedUpParcel] = useState<Parcel | null>(null);
  const mapRef = useRef<MapView>(null);

  const handleLookup = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setIsLooking(true);
    const parcel = await lookupParcelOrAlert(q);
    setIsLooking(false);
    if (!parcel) return;
    setLookedUpParcel(parcel);

    if (parcel.coordinates) {
      mapRef.current?.animateToRegion(
        {
          latitude: parcel.coordinates.latitude,
          longitude: parcel.coordinates.longitude,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        },
        600
      );
    }
  }, [query]);

  const handleViewDetails = useCallback(() => {
    if (lookedUpParcel) {
      router.push(`/parcel/${lookedUpParcel.id}`);
    }
  }, [lookedUpParcel]);

  const handleClear = useCallback(() => {
    setLookedUpParcel(null);
    setQuery('');
    mapRef.current?.animateToRegion(MONTANA_REGION, 600);
  }, []);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={MONTANA_REGION}
        showsUserLocation
        showsMyLocationButton={false}
      >
        {lookedUpParcel?.coordinates && (
          <Marker
            coordinate={{
              latitude: lookedUpParcel.coordinates.latitude,
              longitude: lookedUpParcel.coordinates.longitude,
            }}
            onPress={handleViewDetails}
          >
            <View style={styles.markerContainer}>
              <View style={styles.markerPin}>
                <Text style={styles.markerText}>
                  {formatAcreage(lookedUpParcel.acreage)}
                </Text>
              </View>
              <View style={styles.markerStem} />
            </View>
          </Marker>
        )}
      </MapView>

      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
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
        {isLooking ? (
          <ActivityIndicator color="#1a5f2a" style={styles.searchAction} />
        ) : (
          <TouchableOpacity
            style={[styles.searchBtn, !query.trim() && styles.searchBtnDisabled]}
            onPress={handleLookup}
            disabled={!query.trim()}
          >
            <Text style={styles.searchBtnText}>Search</Text>
          </TouchableOpacity>
        )}
      </View>

      {lookedUpParcel && (
        <View style={styles.resultCard}>
          <View style={styles.resultCardContent}>
            <View style={styles.resultCardInfo}>
              <Text style={styles.resultAcreage}>
                {formatAcreage(lookedUpParcel.acreage)}
              </Text>
              <Text style={styles.resultLocation} numberOfLines={1}>
                {lookedUpParcel.address ??
                  `${lookedUpParcel.county ?? 'Unknown'} County, MT`}
              </Text>
              {lookedUpParcel.parcelNumber && (
                <Text style={styles.resultParcelNumber}>
                  #{lookedUpParcel.parcelNumber}
                </Text>
              )}
            </View>
            <View style={styles.resultCardActions}>
              <TouchableOpacity style={styles.detailsBtn} onPress={handleViewDetails}>
                <Text style={styles.detailsBtnText}>Details</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.clearBtn} onPress={handleClear}>
                <Text style={styles.clearBtnText}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  searchBar: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 5,
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#333',
    paddingVertical: 10,
  },
  searchAction: {
    paddingHorizontal: 8,
  },
  searchBtn: {
    backgroundColor: '#1a5f2a',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  searchBtnDisabled: {
    backgroundColor: '#88b892',
  },
  searchBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  markerContainer: {
    alignItems: 'center',
  },
  markerPin: {
    backgroundColor: '#1a5f2a',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 3,
  },
  markerText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  markerStem: {
    width: 2,
    height: 8,
    backgroundColor: '#1a5f2a',
  },
  resultCard: {
    position: 'absolute',
    bottom: 24,
    left: 12,
    right: 12,
    backgroundColor: '#fff',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
  resultCardContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  resultCardInfo: {
    flex: 1,
  },
  resultAcreage: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1a5f2a',
    marginBottom: 2,
  },
  resultLocation: {
    fontSize: 13,
    color: '#555',
    marginBottom: 2,
  },
  resultParcelNumber: {
    fontSize: 11,
    color: '#999',
    fontFamily: 'monospace',
  },
  resultCardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  detailsBtn: {
    backgroundColor: '#1a5f2a',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  detailsBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  clearBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearBtnText: {
    fontSize: 14,
    color: '#666',
  },
});
