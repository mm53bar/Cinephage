import { randomUUID } from 'node:crypto';

import type { CapturedLogEntry, CapturedLogFilters } from '$lib/logging/log-capture';

const MAX_ENTRIES = 1000;

type Subscriber = (entry: CapturedLogEntry) => void;

function matchesSearch(entry: CapturedLogEntry, query: string): boolean {
	const haystack = [
		entry.msg,
		entry.level,
		entry.logDomain,
		entry.component,
		entry.module,
		entry.service,
		entry.requestId,
		entry.supportId,
		entry.path,
		entry.method,
		entry.data ? JSON.stringify(entry.data) : '',
		entry.err ? JSON.stringify(entry.err) : ''
	]
		.filter((value): value is string => typeof value === 'string' && value.length > 0)
		.join(' ')
		.toLowerCase();

	return haystack.includes(query);
}

function matchesFilters(entry: CapturedLogEntry, filters: CapturedLogFilters): boolean {
	// Multi-level filter takes precedence over single level
	if (filters.levels && filters.levels.length > 0) {
		if (!filters.levels.includes(entry.level)) {
			return false;
		}
	} else if (filters.level && entry.level !== filters.level) {
		return false;
	}

	if (filters.logDomain && entry.logDomain !== filters.logDomain) {
		return false;
	}

	const search = filters.search?.trim().toLowerCase();
	if (search && !matchesSearch(entry, search)) {
		return false;
	}

	return true;
}

class LogCaptureStore {
	private entries: CapturedLogEntry[] = [];

	private subscribers = new Set<Subscriber>();

	append(entry: Omit<CapturedLogEntry, 'id'>): CapturedLogEntry {
		const captured: CapturedLogEntry = {
			id: randomUUID(),
			...entry
		};

		this.entries.push(captured);
		if (this.entries.length > MAX_ENTRIES) {
			this.entries = this.entries.slice(-MAX_ENTRIES);
		}

		for (const subscriber of this.subscribers) {
			subscriber(captured);
		}

		return captured;
	}

	getSnapshot(filters: CapturedLogFilters = {}): CapturedLogEntry[] {
		const limit = Math.min(Math.max(filters.limit ?? 200, 1), MAX_ENTRIES);
		return this.entries.filter((entry) => matchesFilters(entry, filters)).slice(-limit);
	}

	matches(entry: CapturedLogEntry, filters: CapturedLogFilters = {}): boolean {
		return matchesFilters(entry, filters);
	}

	subscribe(subscriber: Subscriber): () => void {
		this.subscribers.add(subscriber);
		return () => {
			this.subscribers.delete(subscriber);
		};
	}
}

export const logCaptureStore = new LogCaptureStore();
