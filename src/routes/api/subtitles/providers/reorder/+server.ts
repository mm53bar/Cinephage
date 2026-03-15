import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getSubtitleProviderManager } from '$lib/server/subtitles/services/SubtitleProviderManager';
import { logger } from '$lib/logging';

/**
 * Schema for reordering providers
 */
const reorderSchema = z.object({
	/** Array of provider IDs in the new priority order (first = highest priority) */
	providerIds: z.array(z.string().uuid()).min(1, 'At least one provider ID is required')
});

/**
 * POST /api/subtitles/providers/reorder
 * Reorder subtitle providers by setting their priority values.
 * The first provider in the array gets priority 1, second gets 2, etc.
 */
export const POST: RequestHandler = async ({ request }) => {
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = reorderSchema.safeParse(data);

	if (!result.success) {
		return json(
			{
				error: 'Validation failed',
				details: result.error.flatten()
			},
			{ status: 400 }
		);
	}

	const { providerIds } = result.data;
	const providerManager = getSubtitleProviderManager();

	try {
		// Verify all providers exist
		const existingProviders = await providerManager.getProviders();
		const existingIds = new Set(existingProviders.map((p) => p.id));

		for (const id of providerIds) {
			if (!existingIds.has(id)) {
				return json({ error: `Provider not found: ${id}` }, { status: 404 });
			}
		}

		// Update priorities
		const updates: Array<{ id: string; priority: number }> = [];
		for (let i = 0; i < providerIds.length; i++) {
			updates.push({ id: providerIds[i], priority: i + 1 });
		}

		// Apply updates
		for (const update of updates) {
			await providerManager.updateProvider(update.id, { priority: update.priority });
		}

		logger.info(
			{
				count: updates.length,
				order: providerIds
			},
			'[ProviderReorder] Reordered provider priorities'
		);

		return json({
			success: true,
			updated: updates.length
		});
	} catch (error) {
		logger.error(
			{
				error: error instanceof Error ? error.message : String(error)
			},
			'[ProviderReorder] Failed to reorder providers'
		);

		return json(
			{
				error: 'Failed to reorder providers',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
