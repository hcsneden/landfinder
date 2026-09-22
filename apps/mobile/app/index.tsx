import { Redirect } from 'expo-router';
import { useAuthStore } from '../hooks/useAuthStore';
import { View, ActivityIndicator, StyleSheet } from 'react-native';

export default function Index() {
  const { tokens, isRestoring } = useAuthStore();

  if (isRestoring) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#1a5f2a" />
      </View>
    );
  }

  if (tokens) {
    return <Redirect href="/(tabs)/search" />;
  }

  return <Redirect href="/(auth)/login" />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
  },
});
