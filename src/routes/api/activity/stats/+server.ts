import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { activityService } from '$lib/server/activity';
import { logger } from '$lib/logging';

/**
 * GET /api/activity/stats
 * Active download queue cards stats:
 * - Count values are based on unified activity scope (matches activity table behavior)
 * - Speed values are collated from app-tracked active queue rows
 */
export const GET: RequestHandler = async () => {
	try {
		const activeStats = await activityService.getActiveStats();

		return json({
			success: true,
			data: activeStats
		});
	} catch (error) {
		logger.error(
			'[ActivityStats] Failed to load activity stats',
			error instanceof Error ? error : undefined
		);
		return json({ success: false, error: 'Failed to load activity stats' }, { status: 500 });
	}
};
