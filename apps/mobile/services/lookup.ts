import { Alert } from 'react-native';
import type { Parcel } from '@lastbestland/shared';
import { parcelApi } from './api';

/**
 * Looks up a parcel and returns it, or shows an alert and returns null when
 * nothing matched or several parcels share the road. The mobile app does not
 * yet offer a candidate picker, so the alert asks for a more specific query.
 */
export async function lookupParcelOrAlert(query: string): Promise<Parcel | null> {
  const response = await parcelApi.lookupParcel(query.trim());
  if (!response.success) {
    Alert.alert('Lookup failed', response.error?.message ?? 'Please try again.');
    return null;
  }
  if (!response.data) {
    Alert.alert('Not found', 'No parcel found. Try a street address, parcel number, or geocode.');
    return null;
  }
  if ('candidates' in response.data) {
    Alert.alert(
      'Several parcels match',
      `${response.data.candidates.length} parcels are on ${response.data.roadName}. Add a house number or use the parcel number.`
    );
    return null;
  }
  return response.data;
}
