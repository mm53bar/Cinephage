/**
 * NZBMountClient - SABnzbd-compatible client for NZBDav/Altmount mounts.
 * Uses the SABnzbd API for queue operations, with a tailored test routine.
 */

import { createChildLogger } from '$lib/logging';

const logger = createChildLogger({ logDomain: 'imports' as const });
import type {
	IDownloadClient,
	DownloadClientConfig,
	AddDownloadOptions,
	DownloadInfo,
	ConnectionTestResult,
	NntpServerConfig
} from '../core/interfaces';
import { SABnzbdClient, type SABnzbdConfig } from '../sabnzbd';
import { SABnzbdProxy, SabnzbdApiError } from '../sabnzbd/SABnzbdProxy';
import type { SabnzbdSettings, SabnzbdFullStatus, SabnzbdWarning } from '../sabnzbd/types';

export type NzbMountMode = 'nzbdav' | 'altmount';

export interface NZBMountConfig extends DownloadClientConfig {
	apiKey?: string | null;
	urlBase?: string | null;
	mountMode?: NzbMountMode | null;
}

export class NZBMountClient implements IDownloadClient {
	readonly implementation = 'nzb-mount';

	private config: NZBMountConfig;
	private proxy: SABnzbdProxy;
	private sabClient: SABnzbdClient;

	constructor(config: NZBMountConfig) {
		this.config = config;
		this.proxy = new SABnzbdProxy(this.buildSettings());
		this.sabClient = new SABnzbdClient({
			...(config as SABnzbdConfig),
			normalizeCategoryDir: true
		});
	}

	private buildSettings(): SabnzbdSettings {
		return {
			host: this.config.host,
			port: this.config.port,
			useSsl: this.config.useSsl,
			apiKey: this.config.apiKey || '',
			urlBase: this.config.urlBase ?? undefined,
			username: this.config.username || undefined,
			password: this.config.password || undefined
		};
	}

	private get mountMode(): NzbMountMode {
		return this.config.mountMode ?? 'nzbdav';
	}

	async test(): Promise<ConnectionTestResult> {
		try {
			logger.debug(
				{
					host: this.config.host,
					port: this.config.port,
					urlBase: this.config.urlBase ?? '',
					mountMode: this.mountMode
				},
				'[NZB-Mount] Testing connection'
			);

			const version = await this.proxy.getVersion();
			const sabConfig = await this.proxy.getConfig();
			const categories = sabConfig.categories.map((c) => c.name);

			let diskInfo: SabnzbdFullStatus | null = null;
			try {
				diskInfo = await this.proxy.getFullStatus();
			} catch (statusError) {
				const statusMessage =
					statusError instanceof SabnzbdApiError ? statusError.message : String(statusError);
				if (!statusMessage.toLowerCase().includes('unknown mode')) {
					throw statusError;
				}
				logger.warn(
					{
						error: statusMessage
					},
					'[NZB-Mount] fullstatus not supported, skipping disk info'
				);
			}

			let warnings: SabnzbdWarning[] = [];
			try {
				warnings = await this.proxy.getWarnings();
			} catch (warningError) {
				const warningMessage =
					warningError instanceof SabnzbdApiError ? warningError.message : String(warningError);
				logger.warn({ warningMessage }, '[NZB-Mount] warnings not supported, skipping');
			}

			return {
				success: true,
				warnings: warnings.length > 0 ? warnings.map((w) => `[${w.type}] ${w.text}`) : undefined,
				details: {
					version,
					savePath: sabConfig.misc.complete_dir,
					categories,
					diskSpace1: diskInfo?.diskspace1,
					diskSpace2: diskInfo?.diskspace2,
					diskSpaceTotal1: diskInfo?.diskspacetotal1,
					diskSpaceTotal2: diskInfo?.diskspacetotal2
				}
			};
		} catch (error) {
			const message =
				error instanceof SabnzbdApiError
					? error.message
					: `Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`;

			logger.error({ err: error }, '[NZB-Mount] Connection test failed');

			return {
				success: false,
				error: message
			};
		}
	}

	addDownload(options: AddDownloadOptions): Promise<string> {
		return this.sabClient.addDownload(options);
	}

	getDownloads(category?: string): Promise<DownloadInfo[]> {
		return this.sabClient.getDownloads(category);
	}

	getDownload(id: string): Promise<DownloadInfo | null> {
		return this.sabClient.getDownload(id);
	}

	removeDownload(id: string, deleteFiles?: boolean): Promise<void> {
		return this.sabClient.removeDownload(id, deleteFiles);
	}

	pauseDownload(id: string): Promise<void> {
		return this.sabClient.pauseDownload(id);
	}

	resumeDownload(id: string): Promise<void> {
		return this.sabClient.resumeDownload(id);
	}

	getDefaultSavePath(): Promise<string> {
		return this.sabClient.getDefaultSavePath();
	}

	getCategories(): Promise<string[]> {
		return this.sabClient.getCategories();
	}

	ensureCategory(name: string, savePath?: string): Promise<void> {
		return this.sabClient.ensureCategory(name, savePath);
	}

	retryDownload(id: string): Promise<string | undefined> {
		return this.sabClient.retryDownload(id);
	}

	getNntpServers(): Promise<NntpServerConfig[]> {
		return this.sabClient.getNntpServers();
	}

	getBasePath(): Promise<string | undefined> {
		return this.sabClient.getBasePath();
	}
}
