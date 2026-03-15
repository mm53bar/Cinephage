import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSubtitleSearchService } from '$lib/server/subtitles/services/SubtitleSearchService';
import { getSubtitleDownloadService } from '$lib/server/subtitles/services/SubtitleDownloadService';
import { LanguageProfileService } from '$lib/server/subtitles/services/LanguageProfileService';
import { db } from '$lib/server/db';
import { movies, episodes, series } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { logger } from '$lib/logging';

const autoSearchSchema = z
	.object({
		movieId: z.string().uuid().optional(),
		episodeId: z.string().uuid().optional(),
		languages: z.array(z.string()).optional()
	})
	.refine((data) => data.movieId || data.episodeId, {
		message: 'Either movieId or episodeId is required'
	});

/**
 * POST /api/subtitles/auto-search
 * Search for subtitles and automatically download the best match.
 */
export const POST: RequestHandler = async ({ request }) => {
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = autoSearchSchema.safeParse(data);

	if (!result.success) {
		return json(
			{
				error: 'Validation failed',
				details: result.error.flatten()
			},
			{ status: 400 }
		);
	}

	const validated = result.data;
	const searchService = getSubtitleSearchService();
	const downloadService = getSubtitleDownloadService();
	const profileService = LanguageProfileService.getInstance();

	try {
		// Auto-search for movie
		if (validated.movieId) {
			const movie = await db.query.movies.findFirst({
				where: eq(movies.id, validated.movieId)
			});

			if (!movie) {
				return json({ error: 'Movie not found' }, { status: 404 });
			}

			// Get language profile
			const profile = await profileService.getProfileForMovie(validated.movieId);
			let languages = validated.languages || [];

			if (languages.length === 0 && profile) {
				languages = profile.languages.map((l) => l.code);
			}
			if (languages.length === 0) {
				languages = ['en'];
			}

			// Get minimum score from profile
			const minScore = profile?.minimumScore ?? 60;

			// Search for subtitles
			const searchResults = await searchService.searchForMovie(validated.movieId, languages);

			if (!searchResults.results || searchResults.results.length === 0) {
				return json({
					success: false,
					message: 'No subtitles found',
					searched: true,
					downloaded: false
				});
			}

			// Find best result above minimum score
			const bestResult = searchResults.results
				.filter((r) => r.matchScore >= minScore)
				.sort((a, b) => b.matchScore - a.matchScore)[0];

			if (!bestResult) {
				return json({
					success: false,
					message: `No subtitles found with score >= ${minScore}`,
					searched: true,
					downloaded: false,
					bestScore: searchResults.results[0]?.matchScore
				});
			}

			// Download best match
			const downloadResult = await downloadService.downloadForMovie(validated.movieId, bestResult);

			logger.info(
				{
					movieId: validated.movieId,
					language: bestResult.language,
					score: bestResult.matchScore
				},
				'[AutoSearch] Downloaded subtitle for movie'
			);

			return json({
				success: true,
				searched: true,
				downloaded: true,
				subtitle: downloadResult,
				matchScore: bestResult.matchScore
			});
		}

		// Auto-search for episode
		if (validated.episodeId) {
			const episode = await db.query.episodes.findFirst({
				where: eq(episodes.id, validated.episodeId)
			});

			if (!episode) {
				return json({ error: 'Episode not found' }, { status: 404 });
			}

			const seriesData = await db.query.series.findFirst({
				where: eq(series.id, episode.seriesId)
			});

			if (!seriesData) {
				return json({ error: 'Series not found' }, { status: 404 });
			}

			// Get language profile
			const profile = await profileService.getProfileForSeries(seriesData.id);
			let languages = validated.languages || [];

			if (languages.length === 0 && profile) {
				languages = profile.languages.map((l) => l.code);
			}
			if (languages.length === 0) {
				languages = ['en'];
			}

			// Get minimum score from profile
			const minScore = profile?.minimumScore ?? 60;

			// Search for subtitles
			const searchResults = await searchService.searchForEpisode(validated.episodeId, languages);

			if (!searchResults.results || searchResults.results.length === 0) {
				return json({
					success: false,
					message: 'No subtitles found',
					searched: true,
					downloaded: false
				});
			}

			// Find best result above minimum score
			const bestResult = searchResults.results
				.filter((r) => r.matchScore >= minScore)
				.sort((a, b) => b.matchScore - a.matchScore)[0];

			if (!bestResult) {
				return json({
					success: false,
					message: `No subtitles found with score >= ${minScore}`,
					searched: true,
					downloaded: false,
					bestScore: searchResults.results[0]?.matchScore
				});
			}

			// Download best match
			const downloadResult = await downloadService.downloadForEpisode(
				validated.episodeId,
				bestResult
			);

			logger.info(
				{
					episodeId: validated.episodeId,
					language: bestResult.language,
					score: bestResult.matchScore
				},
				'[AutoSearch] Downloaded subtitle for episode'
			);

			return json({
				success: true,
				searched: true,
				downloaded: true,
				subtitle: downloadResult,
				matchScore: bestResult.matchScore
			});
		}

		return json({ error: 'Either movieId or episodeId is required' }, { status: 400 });
	} catch (error) {
		logger.error('[AutoSearch] Error', error instanceof Error ? error : undefined);
		const message = error instanceof Error ? error.message : 'Unknown error';
		return json({ error: message }, { status: 500 });
	}
};
