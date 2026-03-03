/**
 * Cloudflare-aware Streaming Utilities
 *
 * Provides streaming-specific Cloudflare bypass with cookie persistence.
 * Unlike the indexer cloudflare-fetch, this is optimized for HLS streaming:
 * - Caches Cloudflare sessions per domain
 * - Reuses cookies for playlist and segment requests
 * - Falls back to direct fetch if Cloudflare bypass fails
 */

import { logger } from '$lib/logging';
import { browserFetch, captchaSolverSettingsService } from '$lib/server/captcha';
import { fetchWithTimeout } from './http';
import type { FetchOptions } from './http';
import { DEFAULT_USER_AGENT } from '../constants';

const streamLog = { logCategory: 'streams' as const };

// ============================================================================
// Session Cache
// ============================================================================

interface CloudflareSession {
	cookies: string;
	userAgent: string;
	timestamp: number;
}

/** Cache of Cloudflare sessions per domain */
const sessionCache = new Map<string, CloudflareSession>();

/** Session TTL in milliseconds (10 minutes) */
const SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Get cached session for a domain if it exists and is not expired
 */
export function getCachedSession(domain: string): CloudflareSession | null {
	const session = sessionCache.get(domain);
	if (!session) return null;

	if (Date.now() - session.timestamp > SESSION_TTL_MS) {
		sessionCache.delete(domain);
		return null;
	}

	return session;
}

/**
 * Cache a Cloudflare session for a domain
 */
function cacheSession(domain: string, cookies: string, userAgent: string): void {
	sessionCache.set(domain, {
		cookies,
		userAgent,
		timestamp: Date.now()
	});

	logger.debug('[CloudflareStreaming] Cached session for domain', {
		domain,
		cookieLength: cookies.length,
		...streamLog
	});
}

// ============================================================================
// Cloudflare Detection
// ============================================================================

/**
 * Check if a response indicates Cloudflare protection
 */
function isCloudflareResponse(response: Response, body: string): boolean {
	// Check status codes
	if (response.status !== 403 && response.status !== 503) {
		return false;
	}

	// Check for Cloudflare headers
	const headers = response.headers;
	if (
		headers.get('cf-ray') ||
		headers.get('cf-mitigated') ||
		headers.get('server')?.includes('cloudflare')
	) {
		return true;
	}

	// Check body content
	const lowerBody = body.toLowerCase();
	if (
		lowerBody.includes('cloudflare') ||
		lowerBody.includes('cf-browser-verification') ||
		lowerBody.includes('checking your browser')
	) {
		return true;
	}

	return false;
}

// ============================================================================
// Cloudflare-aware Fetch
// ============================================================================

/**
 * Fetch with automatic Cloudflare bypass for streaming.
 *
 * This function:
 * 1. Tries a normal fetch first
 * 2. If Cloudflare is detected and Camoufox is available, uses browser fetch
 * 3. For streaming URLs, first visits the referer site to get clearance cookies
 * 4. Caches the Cloudflare session for reuse
 * 5. Returns the response with proper headers for subsequent requests
 *
 * @param url - URL to fetch
 * @param options - Fetch options including referer
 * @returns Response object
 */
export async function fetchWithCloudflareBypass(
	url: string,
	options: FetchOptions = {}
): Promise<Response> {
	const domain = new URL(url).hostname;
	const referer = options.referer;

	// Check if we have a cached session for this domain
	const cachedSession = getCachedSession(domain);
	if (cachedSession) {
		logger.debug('[CloudflareStreaming] Using cached session', { domain, ...streamLog });

		// Try with cached cookies first
		const response = await fetchWithTimeout(url, {
			...options,
			headers: {
				...options.headers,
				Cookie: cachedSession.cookies,
				'User-Agent': cachedSession.userAgent
			}
		});

		if (response.ok) {
			logger.debug('[CloudflareStreaming] Cached session worked', { domain, ...streamLog });
			return response;
		}

		// Cached session expired, clear it
		logger.debug('[CloudflareStreaming] Cached session expired, clearing', {
			domain,
			status: response.status,
			...streamLog
		});
		sessionCache.delete(domain);
	}

	// Try normal fetch first
	logger.debug('[CloudflareStreaming] Attempting normal fetch', { domain, ...streamLog });
	const response = await fetchWithTimeout(url, options);

	// If successful or not Cloudflare, return as-is
	if (response.ok) {
		return response;
	}

	// Read body to check for Cloudflare
	const body = await response.text();

	if (!isCloudflareResponse(response, body)) {
		// Not Cloudflare, return the response (re-create it since we read the body)
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	}

	// Cloudflare detected - check if solver is enabled
	const config = captchaSolverSettingsService.getConfig();
	if (!config.enabled) {
		logger.warn('[CloudflareStreaming] Cloudflare detected but solver disabled', {
			domain,
			...streamLog
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	}

	// Use browser fetch to bypass Cloudflare
	logger.info('[CloudflareStreaming] Cloudflare detected, using browser fetch', {
		domain,
		...streamLog
	});

	try {
		// For streaming URLs with referer, we need to visit the referer first
		// to get Cloudflare clearance, then access the stream URL
		if (referer) {
			logger.debug('[CloudflareStreaming] Two-step fetch: referer first, then stream URL', {
				referer,
				domain,
				...streamLog
			});

			// Step 1: Visit referer site to get clearance
			const refererResult = await browserFetch(
				{
					url: referer,
					method: 'GET'
				},
				{
					headless: config.headless,
					timeoutSeconds: Math.min(config.timeoutSeconds, 60)
				}
			);

			if (!refererResult.success || !refererResult.cookies || refererResult.cookies.length === 0) {
				logger.warn('[CloudflareStreaming] Failed to get cookies from referer', {
					referer,
					success: refererResult.success,
					cookieCount: refererResult.cookies?.length || 0,
					...streamLog
				});
			} else {
				logger.info('[CloudflareStreaming] Got cookies from referer', {
					referer,
					cookieCount: refererResult.cookies.length,
					...streamLog
				});

				// Cache the session immediately
				if (refererResult.userAgent) {
					const cookieString = refererResult.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
					cacheSession(domain, cookieString, refererResult.userAgent);
				}

				// Step 2: Try fetching the stream URL with the cookies
				logger.debug('[CloudflareStreaming] Fetching stream URL with referer cookies', {
					domain,
					...streamLog
				});

				const cookieHeader = refererResult.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
				const streamResponse = await fetchWithTimeout(url, {
					...options,
					timeout: 30000,
					headers: {
						...options.headers,
						Cookie: cookieHeader,
						'User-Agent':
							refererResult.userAgent || options.headers?.['User-Agent'] || DEFAULT_USER_AGENT,
						Referer: referer
					}
				});

				if (streamResponse.ok) {
					const streamBody = await streamResponse.text();
					if (streamBody.includes('#EXTM3U')) {
						logger.info(
							'[CloudflareStreaming] Stream URL fetched successfully with referer cookies',
							{
								domain,
								...streamLog
							}
						);
						return new Response(streamBody, {
							status: 200,
							statusText: 'OK',
							headers: {
								'Content-Type': 'application/vnd.apple.mpegurl'
							}
						});
					}
				}

				logger.debug(
					'[CloudflareStreaming] Stream URL still blocked, trying direct browser fetch',
					{
						domain,
						...streamLog
					}
				);
			}
		}

		// Fallback: Direct browser fetch of the stream URL
		const browserResult = await browserFetch(
			{
				url,
				method: 'GET'
			},
			{
				headless: config.headless,
				timeoutSeconds: Math.min(config.timeoutSeconds, 60)
			}
		);

		if (!browserResult.success) {
			logger.error('[CloudflareStreaming] Browser fetch failed', {
				domain,
				error: browserResult.error,
				...streamLog
			});
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			});
		}

		// Cache the session for future requests
		if (browserResult.cookies && browserResult.cookies.length > 0 && browserResult.userAgent) {
			const cookieString = browserResult.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
			cacheSession(domain, cookieString, browserResult.userAgent);
		}

		logger.info('[CloudflareStreaming] Browser fetch succeeded', {
			domain,
			bodyLength: browserResult.body.length,
			timeMs: browserResult.timeMs,
			...streamLog
		});

		// Return response with browser content
		return new Response(browserResult.body, {
			status: browserResult.status,
			statusText: 'OK',
			headers: {
				'Content-Type': 'application/vnd.apple.mpegurl'
			}
		});
	} catch (error) {
		logger.error('[CloudflareStreaming] Browser fetch error', {
			domain,
			error: error instanceof Error ? error.message : String(error),
			...streamLog
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	}
}

/**
 * Clear all cached Cloudflare sessions
 */
export function clearCloudflareSessions(): void {
	sessionCache.clear();
	logger.info('[CloudflareStreaming] Cleared all cached sessions', streamLog);
}

/**
 * Get statistics about cached sessions
 */
export function getCloudflareSessionStats(): {
	cachedDomains: number;
	sessions: Array<{ domain: string; ageMs: number }>;
} {
	const now = Date.now();
	const sessions: Array<{ domain: string; ageMs: number }> = [];

	for (const [domain, session] of sessionCache.entries()) {
		sessions.push({
			domain,
			ageMs: now - session.timestamp
		});
	}

	return {
		cachedDomains: sessionCache.size,
		sessions
	};
}
