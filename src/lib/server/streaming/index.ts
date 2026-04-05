/**
 * Streaming Module
 *
 * Provides streaming functionality for Cinephage including:
 * - Cinephage API-backed stream resolution
 * - HLS playlist parsing and best quality selection
 * - Stream validation for playability verification
 * - Caching for stream URLs
 * - STRM file generation and management
 * - Shared HTTP utilities for providers
 */

// Core types
export * from './types';

// Configuration constants
export * from './constants';

// Caching
export * from './cache';

// HLS parsing
export * from './hls';

// Stream validation
export { getStreamValidator, createStreamValidator, quickValidateStream } from './validation';

// STRM file service
export * from './StrmService';

// URL utilities
export * from './url';

// Settings helper
export * from './settings';

// Shared HTTP utilities (also available via ./utils)
export {
	fetchWithTimeout,
	fetchPlaylist,
	fetchAndRewritePlaylist,
	rewritePlaylistUrls,
	ensureVodPlaylist,
	checkStreamAvailability,
	checkHlsAvailability
} from './utils';

// Stream resolution service
export { resolveStream } from './StreamResolveService';
export type { ResolveParams } from './StreamResolveService';
