function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable must be set`);
  return value;
}

/**
 * Environment variables the API Lambdas read. Each getter throws on first use
 * when the variable is missing, so a function only needs the variables it uses.
 */
export const env = {
  get databaseClusterArn() { return required('DATABASE_CLUSTER_ARN'); },
  get databaseSecretArn() { return required('DATABASE_SECRET_ARN'); },
  get databaseName() { return process.env.DATABASE_NAME ?? 'landfinder'; },
  get userPoolId() { return required('USER_POOL_ID'); },
  get userPoolClientId() { return required('USER_POOL_CLIENT_ID'); },
  get searchesTable() { return required('SEARCHES_TABLE'); },
  get parcelCacheTable() { return required('PARCEL_CACHE_TABLE'); },
  get searchQueueUrl() { return required('SEARCH_QUEUE_URL'); },
  get serperSecretArn() { return required('SERPER_SECRET_ARN'); },
  get bedrockModelId() { return process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0'; },
  get geocoderContactEmail() { return process.env.GEOCODER_CONTACT_EMAIL ?? ''; },
};
