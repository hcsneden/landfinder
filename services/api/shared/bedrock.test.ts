import { describe, expect, it } from 'vitest';
import { parseListingStatusResponse } from './bedrock';

describe('parseListingStatusResponse', () => {
  it('extracts the JSON object from surrounding prose', () => {
    const result = parseListingStatusResponse(
      'Here you go: {"forSale": true, "confidence": "high", "price": 450000, "listingUrl": "https://x", "source": "Zillow", "summary": "Listed."}'
    );
    expect(result).toEqual({
      forSale: true, confidence: 'high', price: 450000, listingUrl: 'https://x', source: 'Zillow', summary: 'Listed.',
    });
  });

  it('coerces malformed fields to safe defaults', () => {
    const result = parseListingStatusResponse('{"forSale": "yes", "confidence": "certain", "price": "450k"}');
    expect(result).toEqual({ forSale: true, confidence: 'low', price: null, listingUrl: null, source: null, summary: '' });
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseListingStatusResponse('no json here')).toThrow();
  });
});
