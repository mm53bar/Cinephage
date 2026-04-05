/**
 * Streaming settings for the active Cinephage API resolver.
 */

import { db } from '$lib/server/db';
import { indexers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { CINEPHAGE_STREAM_DEFINITION_ID } from '../indexers/types';

export interface StreamingIndexerSettings {
	/** Whether to use HTTPS (new split URL format) */
	useHttps?: boolean | 'true' | 'false';

	/** External host:port (new split URL format) */
	externalHost?: string;

	/** Base URL for streaming endpoints (legacy, reconstructed from useHttps + externalHost) */
	baseUrl?: string;

	/** Upstream Cinephage API base URL */
	cinephageApiBaseUrl?: string;

	/** Build commit sent with upstream authentication headers */
	cinephageCommit?: string;

	/** Build version sent with upstream authentication headers */
	cinephageVersion?: string;
}

/**
 * Get the streaming indexer's settings from the database.
 * Returns undefined if indexer not found or has no settings.
 *
 * Priority for baseUrl:
 * 1. JSON settings field (user-configured in indexer settings form)
 * 2. indexer's base_url column (selected from links array)
 */
export async function getStreamingIndexerSettings(): Promise<StreamingIndexerSettings | undefined> {
	const rows = await db
		.select({
			settings: indexers.settings,
			baseUrl: indexers.baseUrl
		})
		.from(indexers)
		.where(eq(indexers.definitionId, CINEPHAGE_STREAM_DEFINITION_ID))
		.limit(1);

	if (rows.length === 0) {
		return undefined;
	}

	const settings = (rows[0].settings as StreamingIndexerSettings) ?? {};

	// Reconstruct baseUrl from new split fields (useHttps + externalHost)
	if (settings.externalHost) {
		const host = settings.externalHost.replace(/^https?:\/\//, ''); // Strip protocol if accidentally included
		const useHttps = settings.useHttps === true || settings.useHttps === 'true';
		const protocol = useHttps ? 'https' : 'http';
		settings.baseUrl = `${protocol}://${host}`;
	}
	// Fall back to legacy baseUrl in settings JSON
	else if (!settings.baseUrl && rows[0].baseUrl) {
		settings.baseUrl = rows[0].baseUrl;
	}

	return settings;
}

/**
 * Get the base URL for streaming, with fallback chain:
 * 1. Indexer settings (from DB)
 * 2. PUBLIC_BASE_URL environment variable
 * 3. Provided fallback (usually from request headers)
 *
 * @param fallback - Required fallback URL if no other source is configured
 */
export async function getStreamingBaseUrl(fallback: string): Promise<string> {
	const settings = await getStreamingIndexerSettings();

	if (settings?.baseUrl) {
		// Remove trailing slash for consistency
		return settings.baseUrl.replace(/\/$/, '');
	}

	const envUrl = process.env.PUBLIC_BASE_URL;
	if (envUrl) {
		return envUrl.replace(/\/$/, '');
	}

	return fallback;
}
