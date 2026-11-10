import type { Platform, MetricProvenance, SocialAccount } from '@/domain/model';
export type DiscoveredPost = {
  thumbnailUrl?: string | null;
  isAd?: boolean | null;
  platformPostId: string;
  url: string;
  caption: string;
  publishedAt: string;
  contentType?: MetricProvenance['contentType'];
};
export type MetricObservation = {
  thumbnailUrl?: string | null;
  isAd?: boolean | null;
  platformPostId: string;
  views: number;
  metric: 'public_views' | 'organic_views' | 'paid_views' | 'uncertain_views';
  provenance?: MetricProvenance;
  providerUpdatedAt: string | null;
  organicVerified: boolean;
};
export type MetricTarget = { platformPostId: string; publishedAt: string; deadline: string | null };
export type ThumbnailObservation = { platformPostId: string; thumbnailUrl?: string | null };
export interface TrackingProvider {
  fetchThumbnails?(
    accountId: string,
    targets: MetricTarget[]
  ): Promise<ThumbnailObservation[] | null>;
  diagnosticErrors?(): string[];
  accountPatch?(): Partial<SocialAccount['integration']>;
  readonly name: string;
  capabilities(): {
    discovery: boolean;
    publicViews: boolean;
    organicViews: boolean;
    platforms: Platform[];
  };
  discoverPosts(accountId: string, fromDate?: string): Promise<DiscoveredPost[]>;
  fetchMetrics(
    accountId: string,
    fromDate?: string,
    targets?: MetricTarget[]
  ): Promise<MetricObservation[]>;
}
