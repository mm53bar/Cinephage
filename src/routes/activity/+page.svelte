<script lang="ts">
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolvePath } from '$lib/utils/routing';
	import { createSSE } from '$lib/sse';
	import ActivityTable from '$lib/components/activity/ActivityTable.svelte';
	import ActivityDetailModal from '$lib/components/activity/ActivityDetailModal.svelte';
	import ActivityFilters from '$lib/components/activity/ActivityFilters.svelte';
	import ActiveFilters from '$lib/components/activity/ActiveFilters.svelte';
	import { ConfirmationModal } from '$lib/components/ui/modal';
	import type {
		UnifiedActivity,
		ActivityDetails,
		ActivityFilters as FiltersType,
		ActivityStatus
	} from '$lib/types/activity';
	import type { ActivityStreamEvents } from '$lib/types/sse/events/activity-events.js';
	import { Activity, Loader2, Wifi, WifiOff } from 'lucide-svelte';
	import { toasts } from '$lib/stores/toast.svelte';

	let { data } = $props();

	// Local state for activities (for SSE updates)
	let activities = $state<UnifiedActivity[]>([]);
	let total = $state(0);
	let selectionMode = $state(false);
	let selectedHistoryIds = $state<string[]>([]);
	let canManageHistory = $state(false);
	let retentionDays = $state(90);
	let settingsLoading = $state(true);
	let saveRetentionLoading = $state(false);
	let purgeOlderLoading = $state(false);
	let purgeAllLoading = $state(false);
	let deleteSelectedLoading = $state(false);
	type HistoryConfirmAction = 'purge_older_than_retention' | 'purge_all' | 'delete_selected';
	let historyConfirmOpen = $state(false);
	let historyConfirmAction = $state<HistoryConfirmAction | null>(null);

	// Filter state - initialize from URL/data
	let filters = $state<FiltersType>({
		status: 'all',
		mediaType: 'all',
		protocol: 'all'
	});

	// Sort state
	let sortField = $state('time');
	let sortDirection = $state<'asc' | 'desc'>('desc');

	// Loading states
	let isLoading = $state(false);
	let isLoadingMore = $state(false);

	let hasInitialized = $state(false);
	let refreshInFlight = $state(false);

	function isHistoryActivity(activity: UnifiedActivity): boolean {
		const isHistoryRow =
			activity.id.startsWith('history-') || activity.id.startsWith('monitoring-');
		if (!isHistoryRow) return false;

		// Keep failed activities retryable via queue actions; don't allow bulk-delete selection.
		if (activity.status === 'failed' && activity.queueItemId) return false;

		return true;
	}

	function toggleSelectionMode(): void {
		selectionMode = !selectionMode;
		if (!selectionMode) {
			selectedHistoryIds = [];
		}
	}

	function handleToggleSelection(activityId: string, selected: boolean): void {
		if (selected) {
			if (!selectedHistoryIds.includes(activityId)) {
				selectedHistoryIds = [...selectedHistoryIds, activityId];
			}
		} else {
			selectedHistoryIds = selectedHistoryIds.filter((id) => id !== activityId);
		}
	}

	function handleToggleSelectionAll(activityIds: string[], selected: boolean): void {
		if (selected) {
			const merged = [...selectedHistoryIds];
			for (const id of activityIds) {
				if (!merged.includes(id)) {
					merged.push(id);
				}
			}
			selectedHistoryIds = merged;
			return;
		}

		selectedHistoryIds = selectedHistoryIds.filter((id) => !activityIds.includes(id));
	}

	function reconcileSelectedHistoryIds(sourceActivities: UnifiedActivity[]): void {
		const next = selectedHistoryIds.filter((id) =>
			sourceActivities.some((activity) => activity.id === id && isHistoryActivity(activity))
		);
		if (
			next.length === selectedHistoryIds.length &&
			next.every((id, i) => id === selectedHistoryIds[i])
		) {
			return;
		}
		selectedHistoryIds = next;
	}

	function normalizeActivityStatus(status: unknown): ActivityStatus {
		switch (status) {
			case 'imported':
			case 'streaming':
			case 'downloading':
			case 'paused':
			case 'failed':
			case 'rejected':
			case 'removed':
			case 'no_results':
			case 'searching':
				return status;
			default:
				return 'downloading';
		}
	}

	function normalizeActivity(activity: Partial<UnifiedActivity>): UnifiedActivity | null {
		if (!activity.id) return null;

		return {
			id: activity.id,
			mediaType: activity.mediaType === 'episode' ? 'episode' : 'movie',
			mediaId: activity.mediaId ?? '',
			mediaTitle: activity.mediaTitle ?? 'Unknown',
			mediaYear: activity.mediaYear ?? null,
			seriesId: activity.seriesId,
			seriesTitle: activity.seriesTitle,
			seasonNumber: activity.seasonNumber,
			episodeNumber: activity.episodeNumber,
			episodeIds: activity.episodeIds,
			releaseTitle: activity.releaseTitle ?? null,
			quality: activity.quality ?? null,
			releaseGroup: activity.releaseGroup ?? null,
			size: activity.size ?? null,
			indexerId: activity.indexerId ?? null,
			indexerName: activity.indexerName ?? null,
			protocol: activity.protocol ?? null,
			downloadClientId: activity.downloadClientId ?? null,
			downloadClientName: activity.downloadClientName ?? null,
			status: normalizeActivityStatus(activity.status),
			statusReason: activity.statusReason,
			downloadProgress: activity.downloadProgress,
			isUpgrade: activity.isUpgrade ?? false,
			oldScore: activity.oldScore,
			newScore: activity.newScore,
			timeline: Array.isArray(activity.timeline) ? activity.timeline : [],
			startedAt: activity.startedAt ?? new Date().toISOString(),
			completedAt: activity.completedAt ?? null,
			queueItemId: activity.queueItemId,
			downloadHistoryId: activity.downloadHistoryId,
			monitoringHistoryId: activity.monitoringHistoryId,
			importedPath: activity.importedPath
		};
	}

	function compareActivityPriority(a: UnifiedActivity, b: UnifiedActivity): number {
		const aPriority = a.status === 'downloading' ? 0 : 1;
		const bPriority = b.status === 'downloading' ? 0 : 1;
		return aPriority - bPriority;
	}

	function getSortValue(activity: UnifiedActivity, field: string): string | number {
		switch (field) {
			case 'time':
				return activity.startedAt;
			case 'media':
				return activity.mediaTitle.toLowerCase();
			case 'size':
				return activity.size || 0;
			case 'status':
				return activity.status;
			case 'release':
				return activity.releaseTitle?.toLowerCase() || '';
			default:
				return activity.startedAt;
		}
	}

	function sortActivitiesList(
		list: UnifiedActivity[],
		field: string = sortField,
		direction: 'asc' | 'desc' = sortDirection
	): UnifiedActivity[] {
		return [...list].sort((a, b) => {
			const priorityComparison = compareActivityPriority(a, b);
			if (priorityComparison !== 0) {
				return priorityComparison;
			}

			const aVal = getSortValue(a, field);
			const bVal = getSortValue(b, field);

			let comparison = 0;
			if (aVal < bVal) comparison = -1;
			if (aVal > bVal) comparison = 1;

			if (comparison === 0) {
				const aTime = new Date(a.startedAt).getTime();
				const bTime = new Date(b.startedAt).getTime();
				comparison = aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
			}

			return direction === 'asc' ? comparison : -comparison;
		});
	}

	function matchesLiveFilters(activity: UnifiedActivity): boolean {
		// Status
		if (filters.status && filters.status !== 'all') {
			if (filters.status === 'success') {
				if (activity.status !== 'imported' && activity.status !== 'streaming') return false;
			} else if (activity.status !== filters.status) {
				return false;
			}
		}

		// Media type
		if (filters.mediaType === 'movie' && activity.mediaType !== 'movie') return false;
		if (filters.mediaType === 'tv' && activity.mediaType !== 'episode') return false;

		// Search
		if (filters.search) {
			const needle = filters.search.toLowerCase();
			const matches =
				activity.mediaTitle.toLowerCase().includes(needle) ||
				activity.releaseTitle?.toLowerCase().includes(needle) ||
				activity.seriesTitle?.toLowerCase().includes(needle) ||
				activity.releaseGroup?.toLowerCase().includes(needle) ||
				activity.indexerName?.toLowerCase().includes(needle);
			if (!matches) return false;
		}

		// Protocol
		if (filters.protocol && filters.protocol !== 'all' && activity.protocol !== filters.protocol) {
			return false;
		}

		// Download client
		if (filters.downloadClientId && activity.downloadClientId !== filters.downloadClientId) {
			return false;
		}

		// Indexer
		if (filters.indexer && activity.indexerName?.toLowerCase() !== filters.indexer.toLowerCase()) {
			return false;
		}

		// Release group
		if (
			filters.releaseGroup &&
			!activity.releaseGroup?.toLowerCase().includes(filters.releaseGroup.toLowerCase())
		) {
			return false;
		}

		// Resolution
		if (
			filters.resolution &&
			activity.quality?.resolution?.toLowerCase() !== filters.resolution.toLowerCase()
		) {
			return false;
		}

		// Upgrade flag
		if (filters.isUpgrade !== undefined && activity.isUpgrade !== filters.isUpgrade) return false;

		// Date range
		if (filters.startDate) {
			const startTime = new Date(filters.startDate).getTime();
			if (new Date(activity.startedAt).getTime() < startTime) return false;
		}
		if (filters.endDate) {
			const endTime = new Date(filters.endDate).getTime() + 86_399_999;
			if (new Date(activity.startedAt).getTime() > endTime) return false;
		}

		return true;
	}

	function upsertActivity(activity: Partial<UnifiedActivity>): void {
		const normalized = normalizeActivity(activity);
		if (!normalized) return;

		const existingIndex = activities.findIndex((a) => a.id === normalized.id);
		const matchesFilters = matchesLiveFilters(normalized);

		if (!matchesFilters) {
			if (existingIndex >= 0) {
				activities = activities.filter((a) => a.id !== normalized.id);
				total = Math.max(0, total - 1);
				if (selectedActivity?.id === normalized.id) {
					selectedActivity = null;
					activityDetails = null;
					isModalOpen = false;
				}
			}
			return;
		}

		if (existingIndex >= 0) {
			const existing = activities[existingIndex];
			Object.assign(existing, normalized);
			if (selectedActivity?.id === existing.id && selectedActivity !== existing) {
				selectedActivity = existing;
			}
			activities = sortActivitiesList(activities);
			return;
		}

		activities = sortActivitiesList([normalized, ...activities]);
		total += 1;
	}

	// Detail modal state
	let selectedActivity = $state<UnifiedActivity | null>(null);
	let activityDetails = $state<ActivityDetails | null>(null);
	let detailsLoading = $state(false);
	let isModalOpen = $state(false);

	// Update activities when data changes (navigation)
	$effect(() => {
		activities = data.activities;
		total = data.total;
		reconcileSelectedHistoryIds(data.activities);
		if (!hasInitialized && data.filters) {
			filters = { ...data.filters };
			hasInitialized = true;
		}
	});

	$effect(() => {
		reconcileSelectedHistoryIds(activities);
	});

	// SSE Connection - internally handles browser/SSR
	const sse = createSSE<ActivityStreamEvents>(resolvePath('/api/activity/stream'), {
		'activity:new': (newActivity) => {
			upsertActivity(newActivity);
		},
		'activity:updated': (updated) => {
			upsertActivity(updated);
		},
		'activity:progress': (data) => {
			let removed = false;
			activities = activities.flatMap((a) => {
				if (a.id !== data.id) return [a];

				a.downloadProgress = data.progress;
				a.status = data.status ? normalizeActivityStatus(data.status) : a.status;

				if (!matchesLiveFilters(a)) {
					removed = true;
					return [];
				}

				return [a];
			});

			activities = sortActivitiesList(activities);

			if (removed) {
				total = Math.max(0, total - 1);
			}
		},
		'activity:refresh': () => {
			void refreshActivityData();
		}
	});

	async function refreshActivityData(): Promise<void> {
		if (refreshInFlight) return;
		refreshInFlight = true;
		try {
			await invalidateAll();
		} finally {
			refreshInFlight = false;
		}
	}

	async function loadHistorySettings(): Promise<void> {
		settingsLoading = true;
		try {
			const response = await fetch('/api/activity/settings');
			if (response.status === 401 || response.status === 403) {
				canManageHistory = false;
				return;
			}
			if (!response.ok) {
				throw new Error('Failed to load history settings');
			}

			const payload = await response.json();
			if (payload.success && typeof payload.retentionDays === 'number') {
				retentionDays = payload.retentionDays;
			}
			canManageHistory = true;
		} catch (error) {
			console.error('Failed to load history settings:', error);
			canManageHistory = false;
		} finally {
			settingsLoading = false;
		}
	}

	onMount(() => {
		// Ensure we don't show stale client-side snapshot state after route back/forward.
		void refreshActivityData();
		void loadHistorySettings();

		const handleFocus = () => {
			void refreshActivityData();
		};

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				void refreshActivityData();
			}
		};

		const handlePageShow = () => {
			void refreshActivityData();
		};

		window.addEventListener('focus', handleFocus);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.addEventListener('pageshow', handlePageShow);

		return () => {
			window.removeEventListener('focus', handleFocus);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.removeEventListener('pageshow', handlePageShow);
		};
	});

	async function saveRetention(): Promise<void> {
		if (!canManageHistory || saveRetentionLoading) return;

		saveRetentionLoading = true;
		try {
			const response = await fetch('/api/activity/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ retentionDays })
			});
			if (response.status === 401 || response.status === 403) {
				canManageHistory = false;
				throw new Error('Admin access is required');
			}

			const payload = await response.json().catch(() => ({}));
			if (!response.ok || !payload.success) {
				throw new Error(
					typeof payload.error === 'string' ? payload.error : 'Failed to save retention setting'
				);
			}

			retentionDays = payload.retentionDays ?? retentionDays;
			toasts.success(`Retention updated to ${retentionDays} day${retentionDays === 1 ? '' : 's'}`);
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Failed to save retention setting');
		} finally {
			saveRetentionLoading = false;
		}
	}

	const historyConfirmTitle = $derived.by((): string => {
		switch (historyConfirmAction) {
			case 'purge_all':
				return 'Purge All Activity History';
			case 'purge_older_than_retention':
				return 'Purge Older Activity History';
			case 'delete_selected':
				return 'Delete Selected History';
			default:
				return 'Confirm Action';
		}
	});

	const historyConfirmMessage = $derived.by((): string => {
		switch (historyConfirmAction) {
			case 'purge_all':
				return 'Permanently delete all activity history? This cannot be undone.';
			case 'purge_older_than_retention':
				return `Delete activity history older than ${retentionDays} days? This cannot be undone.`;
			case 'delete_selected':
				return `Delete ${selectedHistoryIds.length} selected history row${selectedHistoryIds.length === 1 ? '' : 's'}? This cannot be undone.`;
			default:
				return '';
		}
	});

	const historyConfirmLabel = $derived.by((): string => {
		switch (historyConfirmAction) {
			case 'purge_all':
				return 'Purge All';
			case 'purge_older_than_retention':
				return 'Purge Older';
			case 'delete_selected':
				return 'Delete Selected';
			default:
				return 'Confirm';
		}
	});

	const historyConfirmLoading = $derived.by((): boolean => {
		switch (historyConfirmAction) {
			case 'purge_all':
				return purgeAllLoading;
			case 'purge_older_than_retention':
				return purgeOlderLoading;
			case 'delete_selected':
				return deleteSelectedLoading;
			default:
				return false;
		}
	});

	function openHistoryConfirm(action: HistoryConfirmAction): void {
		if (!canManageHistory) return;
		if (action === 'purge_all' && (settingsLoading || purgeAllLoading)) return;
		if (action === 'purge_older_than_retention' && (settingsLoading || purgeOlderLoading)) return;
		if (action === 'delete_selected' && (deleteSelectedLoading || selectedHistoryIds.length === 0))
			return;

		historyConfirmAction = action;
		historyConfirmOpen = true;
	}

	function closeHistoryConfirm(): void {
		if (historyConfirmLoading) return;
		historyConfirmOpen = false;
		historyConfirmAction = null;
	}

	async function handleHistoryConfirm(): Promise<void> {
		if (!historyConfirmAction || historyConfirmLoading) return;

		if (historyConfirmAction === 'purge_all') {
			await purgeHistory('all');
		} else if (historyConfirmAction === 'purge_older_than_retention') {
			await purgeHistory('older_than_retention');
		} else {
			await deleteSelectedHistory();
		}

		historyConfirmOpen = false;
		historyConfirmAction = null;
	}

	async function purgeHistory(action: 'older_than_retention' | 'all'): Promise<void> {
		if (!canManageHistory) return;
		if (action === 'older_than_retention' && purgeOlderLoading) return;
		if (action === 'all' && purgeAllLoading) return;

		if (action === 'all') {
			purgeAllLoading = true;
		} else {
			purgeOlderLoading = true;
		}

		try {
			const response = await fetch('/api/activity/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action })
			});
			if (response.status === 401 || response.status === 403) {
				canManageHistory = false;
				throw new Error('Admin access is required');
			}

			const payload = await response.json().catch(() => ({}));
			if (!response.ok || !payload.success) {
				throw new Error(
					typeof payload.error === 'string' ? payload.error : 'Failed to purge activity entries'
				);
			}

			const totalDeleted =
				typeof payload.totalDeleted === 'number'
					? payload.totalDeleted
					: (payload.deletedDownloadHistory ?? 0) + (payload.deletedMonitoringHistory ?? 0);
			toasts.success(
				`Deleted ${totalDeleted} activity ${totalDeleted === 1 ? 'entry' : 'entries'}`
			);
			selectedHistoryIds = [];
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Failed to purge activity entries');
			return;
		}

		try {
			await refreshActivityData();
		} catch (error) {
			console.error('Activity refresh failed after purge:', error);
			toasts.info('Purge completed. Activity list will refresh shortly.');
		} finally {
			purgeOlderLoading = false;
			purgeAllLoading = false;
		}
	}

	async function deleteSelectedHistory(): Promise<void> {
		if (!canManageHistory || deleteSelectedLoading || selectedHistoryIds.length === 0) return;

		deleteSelectedLoading = true;
		try {
			const response = await fetch('/api/activity', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ activityIds: selectedHistoryIds })
			});
			if (response.status === 401 || response.status === 403) {
				canManageHistory = false;
				throw new Error('Admin access is required');
			}

			const payload = await response.json().catch(() => ({}));
			if (!response.ok || !payload.success) {
				throw new Error(
					typeof payload.error === 'string'
						? payload.error
						: 'Failed to delete selected activity entries'
				);
			}

			const totalDeleted =
				typeof payload.totalDeleted === 'number'
					? payload.totalDeleted
					: (payload.deletedDownloadHistory ?? 0) + (payload.deletedMonitoringHistory ?? 0);
			const skippedQueue = typeof payload.skippedQueue === 'number' ? payload.skippedQueue : 0;
			const skippedRetryableFailed =
				typeof payload.skippedRetryableFailed === 'number' ? payload.skippedRetryableFailed : 0;

			toasts.success(
				`Deleted ${totalDeleted} activity ${totalDeleted === 1 ? 'entry' : 'entries'}`
			);
			if (skippedQueue > 0) {
				toasts.info(
					`${skippedQueue} active download ${skippedQueue === 1 ? 'item was' : 'items were'} skipped (use queue actions to remove them)`
				);
			}
			if (skippedRetryableFailed > 0) {
				toasts.info(
					`${skippedRetryableFailed} failed activity ${skippedRetryableFailed === 1 ? 'entry was' : 'entries were'} kept because retry is still available`
				);
			}

			selectedHistoryIds = [];
		} catch (error) {
			toasts.error(
				error instanceof Error ? error.message : 'Failed to delete selected activity entries'
			);
			return;
		}

		try {
			await refreshActivityData();
		} catch (error) {
			console.error('Activity refresh failed after delete selected:', error);
			toasts.info('Delete completed. Activity list will refresh shortly.');
		} finally {
			deleteSelectedLoading = false;
		}
	}

	// Apply filters via URL navigation
	async function applyFilters(newFilters: FiltersType) {
		filters = newFilters;
		isLoading = true;

		const params = new SvelteURLSearchParams();
		if (filters.status !== 'all') params.set('status', filters.status!);
		if (filters.mediaType !== 'all') params.set('mediaType', filters.mediaType!);
		if (filters.search) params.set('search', filters.search);
		if (filters.protocol !== 'all') params.set('protocol', filters.protocol!);
		if (filters.indexer) params.set('indexer', filters.indexer);
		if (filters.releaseGroup) params.set('releaseGroup', filters.releaseGroup);
		if (filters.resolution) params.set('resolution', filters.resolution);
		if (filters.isUpgrade) params.set('isUpgrade', 'true');
		if (filters.includeNoResults) params.set('includeNoResults', 'true');
		if (filters.downloadClientId) params.set('downloadClientId', filters.downloadClientId);
		if (filters.startDate) params.set('startDate', filters.startDate);
		if (filters.endDate) params.set('endDate', filters.endDate);

		const queryString = params.toString();
		await goto(resolvePath(`/activity${queryString ? `?${queryString}` : ''}`), {
			keepFocus: true
		});
		isLoading = false;
	}

	// Remove a specific filter
	async function removeFilter(key: keyof FiltersType) {
		const newFilters = { ...filters };
		if (key === 'status' || key === 'mediaType' || key === 'protocol') {
			newFilters[key] = 'all';
		} else {
			delete newFilters[key];
		}
		await applyFilters(newFilters);
	}

	// Clear all filters
	async function clearAllFilters() {
		await applyFilters({
			status: 'all',
			mediaType: 'all',
			protocol: 'all'
		});
	}

	// Handle sort
	function handleSort(field: string) {
		if (sortField === field) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortField = field;
			sortDirection = 'desc';
		}

		activities = sortActivitiesList(activities, field, sortDirection);
	}

	// Load more
	async function loadMore() {
		if (isLoadingMore || !data.hasMore) return;
		isLoadingMore = true;

		try {
			const apiUrl = new URL('/api/activity', window.location.origin);
			apiUrl.searchParams.set('limit', '50');
			apiUrl.searchParams.set('offset', String(activities.length));
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

			const response = await fetch(apiUrl.toString());
			const result = await response.json();

			if (result.success && result.activities) {
				activities = sortActivitiesList([...activities, ...result.activities]);
			}
		} catch (error) {
			console.error('Failed to load more:', error);
		} finally {
			isLoadingMore = false;
		}
	}

	// Open detail modal
	async function openDetailModal(activity: UnifiedActivity) {
		selectedActivity = activity;
		isModalOpen = true;
		detailsLoading = true;
		activityDetails = null;

		// Fetch activity details
		try {
			const response = await fetch(`/api/activity/${activity.id}/details`);
			if (response.ok) {
				const data = await response.json();
				activityDetails = data.details;
			}
		} catch (error) {
			console.error('Failed to fetch activity details:', error);
		}

		detailsLoading = false;
	}

	function closeModal() {
		isModalOpen = false;
		selectedActivity = null;
		activityDetails = null;
	}

	function applyQueueStatusLocally(id: string, status: ActivityStatus) {
		for (const activity of activities) {
			if (activity.queueItemId === id) {
				activity.status = status;
			}
		}
		if (selectedActivity?.queueItemId === id) {
			selectedActivity.status = status;
		}
	}

	async function runQueueAction(id: string, action: 'pause' | 'resume') {
		const response = await fetch(`/api/queue/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action })
		});
		if (!response.ok) {
			let message = `Failed to ${action}`;
			try {
				const payload = await response.json();
				if (payload?.message && typeof payload.message === 'string') {
					message = payload.message;
				}
			} catch {
				// Ignore JSON parse errors and fall back to default message.
			}
			throw new Error(message);
		}
		applyQueueStatusLocally(id, action === 'pause' ? 'paused' : 'downloading');
	}

	// Queue actions
	async function handlePause(id: string) {
		await runQueueAction(id, 'pause');
	}

	async function handleResume(id: string) {
		await runQueueAction(id, 'resume');
	}

	async function handleRemove(id: string) {
		const response = await fetch(`/api/queue/${id}`, { method: 'DELETE' });
		if (!response.ok) {
			let message = 'Failed to remove';
			try {
				const payload = await response.json();
				if (payload?.message && typeof payload.message === 'string') {
					message = payload.message;
				} else if (payload?.error && typeof payload.error === 'string') {
					message = payload.error;
				}
			} catch {
				// Ignore JSON parse errors and fall back to default message.
			}
			throw new Error(message);
		}
		await invalidateAll();
		closeModal();
	}

	async function handleRetry(id: string) {
		const response = await fetch(`/api/queue/${id}/retry`, { method: 'POST' });
		if (!response.ok) throw new Error('Failed to retry');
		await invalidateAll();
	}
</script>

<svelte:head>
	<title>Activity - Cinephage</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="flex items-center gap-2 text-2xl font-bold">
				<Activity class="h-8 w-8" />
				Activity
			</h1>
			<p class="text-base-content/70">Download and search history</p>
		</div>
		<!-- Connection Status -->
		<div class="hidden lg:block">
			{#if sse.isConnected}
				<span class="badge gap-1 badge-success">
					<Wifi class="h-3 w-3" />
					Live
				</span>
			{:else if sse.status === 'connecting' || sse.status === 'error'}
				<span class="badge gap-1 {sse.status === 'error' ? 'badge-error' : 'badge-warning'}">
					<Loader2 class="h-3 w-3 animate-spin" />
					{sse.status === 'error' ? 'Reconnecting...' : 'Connecting...'}
				</span>
			{:else}
				<span class="badge gap-1 badge-ghost">
					<WifiOff class="h-3 w-3" />
					Disconnected
				</span>
			{/if}
		</div>
	</div>

	<!-- Unified Toolbar -->
	<ActivityFilters
		{filters}
		filterOptions={data.filterOptions}
		onFiltersChange={applyFilters}
		onClearFilters={clearAllFilters}
		showActiveFilters={true}
		showHistoryControls={canManageHistory}
	>
		{#snippet activeFiltersContent()}
			<ActiveFilters
				{filters}
				downloadClients={data.filterOptions.downloadClients}
				onFilterRemove={removeFilter}
				onClearAll={clearAllFilters}
			/>
		{/snippet}

		{#snippet historyControlsContent()}
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-sm font-bold tracking-wide text-base-content/70">History Management</span>
				<div class="divider m-0 divider-horizontal h-6"></div>
				<label class="flex items-center gap-2 text-sm">
					<span class="text-base-content/70">Retention:</span>
					<select
						class="select-bordered select select-xs"
						bind:value={retentionDays}
						disabled={settingsLoading}
					>
						<option value={7}>7 days</option>
						<option value={14}>14 days</option>
						<option value={30}>30 days</option>
						<option value={60}>60 days</option>
						<option value={90}>90 days</option>
					</select>
				</label>
				<div class="divider m-0 divider-horizontal h-6"></div>
				<button
					class="btn btn-xs"
					onclick={saveRetention}
					disabled={settingsLoading || saveRetentionLoading}
				>
					{#if saveRetentionLoading}
						<Loader2 class="h-3 w-3 animate-spin" />
					{/if}
					Save
				</button>
				<button
					class="btn btn-xs"
					onclick={() => openHistoryConfirm('purge_older_than_retention')}
					disabled={settingsLoading || purgeOlderLoading}
				>
					{#if purgeOlderLoading}
						<Loader2 class="h-3 w-3 animate-spin" />
					{/if}
					Purge Older
				</button>
				<button class="btn btn-ghost btn-xs" onclick={toggleSelectionMode}>
					{selectionMode ? 'Exit Selection' : 'Select Rows'}
				</button>
				{#if selectionMode}
					<button
						class="btn btn-xs btn-error"
						onclick={() => openHistoryConfirm('delete_selected')}
						disabled={deleteSelectedLoading || selectedHistoryIds.length === 0}
					>
						{#if deleteSelectedLoading}
							<Loader2 class="h-3 w-3 animate-spin" />
						{/if}
						Delete Selected ({selectedHistoryIds.length})
					</button>
				{/if}
				<div class="ml-auto"></div>
				<button
					class="btn btn-xs btn-error"
					onclick={() => openHistoryConfirm('purge_all')}
					disabled={settingsLoading || purgeAllLoading}
				>
					{#if purgeAllLoading}
						<Loader2 class="h-3 w-3 animate-spin" />
					{/if}
					Purge All
				</button>
			</div>
			<p class="mt-2 text-xs text-base-content/60">
				Bulk delete applies to history rows (`history-*` and `monitoring-*`). Active queue items and
				retryable failed activities are managed through queue actions.
			</p>
		{/snippet}
	</ActivityFilters>

	<!-- Activity Stats -->
	<div class="flex items-center gap-4 text-sm text-base-content/70">
		<span>{total} activities</span>
		{#if activities.some((a) => a.status === 'downloading')}
			<span class="badge gap-1 badge-info">
				<Loader2 class="h-3 w-3 animate-spin" />
				{activities.filter((a) => a.status === 'downloading').length} downloading
			</span>
		{/if}
	</div>

	<!-- Activity Table -->
	{#if isLoading && activities.length === 0}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-8 w-8 animate-spin" />
		</div>
	{:else}
		<ActivityTable
			{activities}
			{sortField}
			{sortDirection}
			{selectionMode}
			selectedIds={selectedHistoryIds}
			isSelectable={isHistoryActivity}
			onSort={handleSort}
			onRowClick={openDetailModal}
			onPause={handlePause}
			onResume={handleResume}
			onRemove={handleRemove}
			onRetry={handleRetry}
			onToggleSelection={handleToggleSelection}
			onToggleSelectionAll={handleToggleSelectionAll}
		/>

		<!-- Load More -->
		{#if data.hasMore}
			<div class="flex justify-center py-4">
				<button class="btn btn-ghost" onclick={loadMore} disabled={isLoadingMore}>
					{#if isLoadingMore}
						<Loader2 class="h-4 w-4 animate-spin" />
					{/if}
					Load More
				</button>
			</div>
		{/if}
	{/if}
</div>

<ConfirmationModal
	open={historyConfirmOpen}
	title={historyConfirmTitle}
	message={historyConfirmMessage}
	confirmLabel={historyConfirmLabel}
	confirmVariant="error"
	loading={historyConfirmLoading}
	onConfirm={handleHistoryConfirm}
	onCancel={closeHistoryConfirm}
/>

<!-- Detail Modal -->
{#if isModalOpen && selectedActivity}
	<ActivityDetailModal
		activity={selectedActivity}
		details={activityDetails}
		loading={detailsLoading}
		onClose={closeModal}
		onPause={handlePause}
		onResume={handleResume}
		onRemove={handleRemove}
		onRetry={handleRetry}
	/>
{/if}
