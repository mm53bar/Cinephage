import type { PageServerLoad } from './$types';
import type { UnifiedActivity, ActivityFilters, FilterOptions } from '$lib/types/activity';
import { db } from '$lib/server/db';
import { downloadClients, indexers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

type ActivityTab = 'active' | 'history';
const ACTIVE_TAB_STATUSES: NonNullable<ActivityFilters['status']>[] = [
	'all',
	'downloading',
	'seeding',
	'paused',
	'failed'
];
const HISTORY_TAB_STATUSES: NonNullable<ActivityFilters['status']>[] = [
	'all',
	'success',
	'failed',
	'removed',
	'rejected',
	'no_results'
];

function normalizeStatusForTab(
	status: string,
	tab: ActivityTab
): NonNullable<ActivityFilters['status']> {
	const allowedStatuses = tab === 'active' ? ACTIVE_TAB_STATUSES : HISTORY_TAB_STATUSES;
	return allowedStatuses.includes(status as NonNullable<ActivityFilters['status']>)
		? (status as NonNullable<ActivityFilters['status']>)
		: 'all';
}

export const load: PageServerLoad = async ({ fetch, url }) => {
	const tabParam = url.searchParams.get('tab');
	const explicitTab: ActivityTab | null =
		tabParam === 'active' || tabParam === 'history' ? tabParam : null;

	// Parse all filter parameters
	const rawStatus = url.searchParams.get('status') || 'all';
	const mediaType = url.searchParams.get('mediaType') || 'all';
	const search = url.searchParams.get('search') || '';
	const protocol = url.searchParams.get('protocol') || 'all';
	const indexer = url.searchParams.get('indexer') || '';
	const releaseGroup = url.searchParams.get('releaseGroup') || '';
	const resolution = url.searchParams.get('resolution') || '';
	const isUpgrade = url.searchParams.get('isUpgrade') === 'true';
	const includeNoResults = url.searchParams.get('includeNoResults') === 'true';
	const downloadClientId = url.searchParams.get('downloadClientId') || '';
	const startDate = url.searchParams.get('startDate') || '';
	const endDate = url.searchParams.get('endDate') || '';

	function buildFiltersForTab(tab: ActivityTab): ActivityFilters {
		return {
			status: normalizeStatusForTab(rawStatus, tab) as ActivityFilters['status'],
			mediaType: mediaType as ActivityFilters['mediaType'],
			search: search || undefined,
			protocol: protocol as ActivityFilters['protocol'],
			indexer: indexer || undefined,
			releaseGroup: releaseGroup || undefined,
			resolution: resolution || undefined,
			isUpgrade: isUpgrade || undefined,
			includeNoResults: tab === 'history' && includeNoResults ? true : undefined,
			downloadClientId: downloadClientId || undefined,
			startDate: startDate || undefined,
			endDate: endDate || undefined
		};
	}

	function appendFiltersToApiUrl(apiUrl: URL, filters: ActivityFilters): void {
		if (filters.status !== 'all') apiUrl.searchParams.set('status', filters.status!);
		if (filters.mediaType !== 'all') apiUrl.searchParams.set('mediaType', filters.mediaType!);
		if (filters.search) apiUrl.searchParams.set('search', filters.search);
		if (filters.protocol !== 'all') apiUrl.searchParams.set('protocol', filters.protocol!);
		if (filters.indexer) apiUrl.searchParams.set('indexer', filters.indexer);
		if (filters.releaseGroup) apiUrl.searchParams.set('releaseGroup', filters.releaseGroup);
		if (filters.resolution) apiUrl.searchParams.set('resolution', filters.resolution);
		if (filters.isUpgrade) apiUrl.searchParams.set('isUpgrade', 'true');
		if (filters.includeNoResults) apiUrl.searchParams.set('includeNoResults', 'true');
		if (filters.downloadClientId)
			apiUrl.searchParams.set('downloadClientId', filters.downloadClientId);
		if (filters.startDate) apiUrl.searchParams.set('startDate', filters.startDate);
		if (filters.endDate) apiUrl.searchParams.set('endDate', filters.endDate);
	}

	let tab: ActivityTab = explicitTab ?? 'history';
	if (!explicitTab) {
		try {
			const activeProbeUrl = new URL('/api/activity', url.origin);
			activeProbeUrl.searchParams.set('limit', '1');
			activeProbeUrl.searchParams.set('offset', '0');
			activeProbeUrl.searchParams.set('scope', 'active');
			appendFiltersToApiUrl(activeProbeUrl, buildFiltersForTab('active'));

			const probeResponse = await fetch(activeProbeUrl.toString());
			const probeData = await probeResponse.json().catch(() => ({}));
			const activeTotal =
				typeof probeData.total === 'number' && Number.isFinite(probeData.total)
					? probeData.total
					: 0;
			tab = activeTotal > 0 ? 'active' : 'history';
		} catch {
			tab = 'history';
		}
	}

	const filters = buildFiltersForTab(tab);

	// Build API URL with query params
	const apiUrl = new URL('/api/activity', url.origin);
	apiUrl.searchParams.set('limit', '50');
	apiUrl.searchParams.set('offset', '0');
	apiUrl.searchParams.set('scope', tab);
	appendFiltersToApiUrl(apiUrl, filters);

	// Fetch filter options (indexers, download clients)
	const [indexerRows, clientRows] = await Promise.all([
		db
			.select({ id: indexers.id, name: indexers.name })
			.from(indexers)
			.where(eq(indexers.enabled, true))
			.orderBy(indexers.name),
		db
			.select({ id: downloadClients.id, name: downloadClients.name })
			.from(downloadClients)
			.where(eq(downloadClients.enabled, true))
			.orderBy(downloadClients.name)
	]);

	const filterOptions: FilterOptions = {
		indexers: indexerRows,
		downloadClients: clientRows,
		releaseGroups: [],
		resolutions: ['4K', '2160p', '1080p', '720p', '480p', 'SD']
	};

	try {
		const response = await fetch(apiUrl.toString());
		const data = await response.json();

		return {
			activities: data.activities as UnifiedActivity[],
			total: data.total as number,
			hasMore: data.hasMore as boolean,
			tab,
			filters,
			filterOptions
		};
	} catch (error) {
		console.error('Failed to load activity:', error);
		return {
			activities: [] as UnifiedActivity[],
			total: 0,
			hasMore: false,
			tab,
			filters,
			filterOptions
		};
	}
};
