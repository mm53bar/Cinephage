import type { HandleClientError } from '@sveltejs/kit';

import { logger } from '$lib/logging';

function createClientSupportId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID().split('-')[0] ?? crypto.randomUUID();
	}

	return Math.random().toString(36).slice(2, 10);
}

export const handleError: HandleClientError = ({ error, event, status }) => {
	const supportId = createClientSupportId();

	logger.error(
		{
			err: error,
			logDomain: 'client',
			component: 'hooks.client',
			supportId,
			status,
			path: event.url.pathname,
			routeId: event.route.id ?? null
		},
		'Unhandled client error'
	);

	return {
		message: 'An unexpected error occurred',
		code: 'CLIENT_ERROR',
		supportId
	};
};
