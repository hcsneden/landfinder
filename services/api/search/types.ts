import type { SearchCriteria, SearchJobStatus, SearchResult } from '@lastbestland/shared';

/** Shape of a row in the search jobs DynamoDB table. */
export interface SearchJobItem {
  searchId: string;
  /**
   * Absent for anonymous searches. Search is public, so a job without an owner is
   * readable by anyone holding its id, which is a random UUID handed only to the
   * client that created it. A job with an owner is readable only by that owner,
   * which keeps a signed-in user's search history private.
   */
  userId?: string;
  criteria: SearchCriteria;
  status: SearchJobStatus;
  createdAt: string;
  ttl: number;
  resultCount?: number;
  completedAt?: string;
  results?: SearchResult[];
}

export interface SearchJobMessage {
  searchId: string;
  criteria: SearchCriteria;
}
