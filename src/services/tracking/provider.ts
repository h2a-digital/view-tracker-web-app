import type { Platform } from '@/domain/model';
export type DiscoveredPost = {
  platformPostId: string;
  url: string;
  caption: string;
  publishedAt: string;
};
export type MetricObservation = {
  platformPostId: string;
  views: number;
  metric: 'public_views' | 'organic_views';
  providerUpdatedAt: string | null;
  organicVerified: boolean;
};
export interface TrackingProvider {
  readonly name: string;
  capabilities(): {
    discovery: boolean;
    publicViews: boolean;
    organicViews: boolean;
    platforms: Platform[];
  };
  discoverPosts(accountId: string, fromDate?: string): Promise<DiscoveredPost[]>;
  fetchMetrics(accountId: string, fromDate?: string): Promise<MetricObservation[]>;
}
