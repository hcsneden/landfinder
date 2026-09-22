import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

/** Writes a JSON summary of a scraper run to `<scraper>/runs/<date>.json` in the scraping bucket. */
export async function writeRunSummary(scraper: string, summary: Record<string, unknown>): Promise<void> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET environment variable must be set');
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${scraper}/runs/${new Date().toISOString().slice(0, 10)}.json`,
      Body: JSON.stringify({ timestamp: new Date().toISOString(), ...summary }, null, 2),
      ContentType: 'application/json',
    })
  );
  console.log(`${scraper} run complete`, summary);
}

/** Runs a scraper entry point, closing resources and setting the exit code. */
export async function runScraper(name: string, run: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`${name} failed:`, err);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}
