import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { Emitter } from 'vs/base/common/event';
import { Schemas } from 'vs/base/common/network';
import { URI } from 'vs/base/common/uri';
import { getMachineId } from 'vs/base/node/id';
import { ClientConnectionEvent, IPCServer, IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { createChannelReceiver } from 'vs/base/parts/ipc/node/ipc';
import { LogsDataCleaner } from 'vs/code/electron-browser/sharedProcess/contrib/logsDataCleaner';
import { main } from "vs/code/node/cliProcessMain";
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ConfigurationService } from 'vs/platform/configuration/common/configurationService';
import { ExtensionHostDebugBroadcastChannel } from 'vs/platform/debug/common/extensionHostDebugIpc';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ParsedArgs } from 'vs/platform/environment/node/argv';
import { EnvironmentService, INativeEnvironmentService } from 'vs/platform/environment/node/environmentService';
import { ExtensionGalleryService } from 'vs/platform/extensionManagement/common/extensionGalleryService';
import { IExtensionGalleryService, IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionManagementChannel } from 'vs/platform/extensionManagement/common/extensionManagementIpc';
import { ExtensionManagementService } from 'vs/platform/extensionManagement/node/extensionManagementService';
import { IFileService } from 'vs/platform/files/common/files';
import { FileService } from 'vs/platform/files/common/fileService';
import { DiskFileSystemProvider } from 'vs/platform/files/node/diskFileSystemProvider';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { ILocalizationsService } from 'vs/platform/localizations/common/localizations';
import { LocalizationsService } from 'vs/platform/localizations/node/localizations';
import { getLogLevel, ILogService } from 'vs/platform/log/common/log';
import { LoggerChannel } from 'vs/platform/log/common/logIpc';
import { SpdLogService } from 'vs/platform/log/node/spdlogService';
import product from 'vs/platform/product/common/product';
import { IProductService } from 'vs/platform/product/common/productService';
import { ConnectionType, ConnectionTypeRequest } from 'vs/platform/remote/common/remoteAgentConnection';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { IRequestService } from 'vs/platform/request/common/request';
import { RequestChannel } from 'vs/platform/request/common/requestIpc';
import { RequestService } from 'vs/platform/request/node/requestService';
import ErrorTelemetry from 'vs/platform/telemetry/browser/errorTelemetry';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ITelemetryServiceConfig, TelemetryService } from 'vs/platform/telemetry/common/telemetryService';
import { combinedAppender, LogAppender, NullTelemetryService } from 'vs/platform/telemetry/common/telemetryUtils';
import { AppInsightsAppender } from 'vs/platform/telemetry/node/appInsightsAppender';
import { resolveCommonProperties } from 'vs/platform/telemetry/node/commonProperties';
import { INodeProxyService, NodeProxyChannel } from 'vs/server/common/nodeProxy';
import { TelemetryChannel } from 'vs/server/common/telemetry';
import { Query, VscodeOptions, WorkbenchOptions } from 'vs/server/ipc';
import { ExtensionEnvironmentChannel, FileProviderChannel, NodeProxyService } from 'vs/server/node/channel';
import { Connection, ExtensionHostConnection, ManagementConnection } from 'vs/server/node/connection';
import { TelemetryClient } from 'vs/server/node/insights';
import { logger } from 'vs/server/node/logger';
import { getLocaleFromConfig, getNlsConfiguration } from 'vs/server/node/nls';
import { Protocol } from 'vs/server/node/protocol';
import { getUriTransformer } from 'vs/server/node/util';
import { REMOTE_FILE_SYSTEM_CHANNEL_NAME } from "vs/workbench/services/remote/common/remoteAgentFileSystemChannel";
import { RemoteExtensionLogFileName } from 'vs/workbench/services/remote/common/remoteAgentService';

export class Vscode {
	public readonly _onDidClientConnect = new Emitter<ClientConnectionEvent>();
	public readonly onDidClientConnect = this._onDidClientConnect.event;
	private readonly ipc = new IPCServer<RemoteAgentConnectionContext>(this.onDidClientConnect);

	private readonly maxExtraOfflineConnections = 0;
	private readonly connections = new Map<ConnectionType, Map<string, Connection>>();

	private readonly services = new ServiceCollection();
	private servicesPromise?: Promise<void>;

	public async cli(args: ParsedArgs): Promise<void> {
		return main(args);
	}

	public async initialize(options: VscodeOptions): Promise<WorkbenchOptions> {
		const transformer = getUriTransformer(options.remoteAuthority);
		if (!this.servicesPromise) {
			this.servicesPromise = this.initializeServices(options.args);
		}
		await this.servicesPromise;
		const environment = this.services.get(IEnvironmentService) as INativeEnvironmentService;
		const startPath = options.startPath;
		const parseUrl = (url: string): URI => {
			// This might be a fully-specified URL or just a path.
			try {
				return URI.parse(url, true);
			} catch (error) {
				return URI.from({
					scheme: Schemas.vscodeRemote,
					authority: options.remoteAuthority,
					path: url,
				});
			}
		};
		return {
			workbenchWebConfiguration: {
				workspaceUri: startPath && startPath.workspace ? parseUrl(startPath.url) : undefined,
				folderUri: startPath && !startPath.workspace ? parseUrl(startPath.url) : undefined,
				remoteAuthority: options.remoteAuthority,
				logLevel: getLogLevel(environment),
				workspaceProvider: {
					payload: [["userDataPath", environment.userDataPath]],
				},
			},
			remoteUserDataUri: transformer.transformOutgoing(URI.file(environment.userDataPath)),
			productConfiguration: product,
			nlsConfiguration: await getNlsConfiguration(environment.args.locale || await getLocaleFromConfig(environment.userDataPath), environment.userDataPath),
			commit: product.commit || 'development',
		};
	}

	public async handleWebSocket(socket: net.Socket, query: Query): Promise<true> {
		if (!query.reconnectionToken) {
			throw new Error('Reconnection token is missing from query parameters');
		}
		const protocol = new Protocol(socket, {
			reconnectionToken: <string>query.reconnectionToken,
			reconnection: query.reconnection === 'true',
			skipWebSocketFrames: query.skipWebSocketFrames === 'true',
		});
		try {
			await this.connect(await protocol.handshake(), protocol);
		} catch (error) {
			protocol.sendMessage({ type: 'error', reason: error.message });
			protocol.dispose();
			protocol.getSocket().dispose();
		}
		return true;
	}

	private async connect(message: ConnectionTypeRequest, protocol: Protocol): Promise<void> {
		if (product.commit && message.commit !== product.commit) {
			logger.warn(`Version mismatch (${message.commit} instead of ${product.commit})`);
		}

		switch (message.desiredConnectionType) {
			case ConnectionType.ExtensionHost:
			case ConnectionType.Management:
				if (!this.connections.has(message.desiredConnectionType)) {
					this.connections.set(message.desiredConnectionType, new Map());
				}
				const connections = this.connections.get(message.desiredConnectionType)!;

				const ok = async () => {
					return message.desiredConnectionType === ConnectionType.ExtensionHost
						? { debugPort: await this.getDebugPort() }
						: { type: 'ok' };
				};

				const token = protocol.options.reconnectionToken;
				if (protocol.options.reconnection && connections.has(token)) {
					protocol.sendMessage(await ok());
					const buffer = protocol.readEntireBuffer();
					protocol.dispose();
					return connections.get(token)!.reconnect(protocol.getSocket(), buffer);
				} else if (protocol.options.reconnection || connections.has(token)) {
					throw new Error(protocol.options.reconnection
						? 'Unrecognized reconnection token'
						: 'Duplicate reconnection token'
					);
				}

				protocol.sendMessage(await ok());

				let connection: Connection;
				if (message.desiredConnectionType === ConnectionType.Management) {
					connection = new ManagementConnection(protocol, token);
					this._onDidClientConnect.fire({
						protocol, onDidClientDisconnect: connection.onClose,
					});
					// TODO: Need a way to match clients with a connection. For now
					// dispose everything which only works because no extensions currently
					// utilize long-running proxies.
					(this.services.get(INodeProxyService) as NodeProxyService)._onUp.fire();
					connection.onClose(() => (this.services.get(INodeProxyService) as NodeProxyService)._onDown.fire());
				} else {
					const buffer = protocol.readEntireBuffer();
					connection = new ExtensionHostConnection(
						message.args ? message.args.language : 'en',
						protocol, buffer, token,
						this.services.get(ILogService) as ILogService,
						this.services.get(IEnvironmentService) as INativeEnvironmentService,
					);
				}
				connections.set(token, connection);
				connection.onClose(() => connections.delete(token));
				this.disposeOldOfflineConnections(connections);
				break;
			case ConnectionType.Tunnel: return protocol.tunnel();
			default: throw new Error('Unrecognized connection type');
		}
	}

	private disposeOldOfflineConnections(connections: Map<string, Connection>): void {
		const offline = Array.from(connections.values())
			.filter((connection) => typeof connection.offline !== 'undefined');
		for (let i = 0, max = offline.length - this.maxExtraOfflineConnections; i < max; ++i) {
			offline[i].dispose();
		}
	}

	private async initializeServices(args: ParsedArgs): Promise<void> {
		const environmentService = new EnvironmentService(args, process.execPath);
    // https://github.com/cdr/code-server/issues/1693
    fs.mkdirSync(environmentService.globalStorageHome, { recursive: true });

		const logService = new SpdLogService(RemoteExtensionLogFileName, environmentService.logsPath, getLogLevel(environmentService));
		const fileService = new FileService(logService);
		fileService.registerProvider(Schemas.file, new DiskFileSystemProvider(logService));

		const piiPaths = [
			path.join(environmentService.userDataPath, 'clp'), // Language packs.
			environmentService.extensionsPath,
			environmentService.builtinExtensionsPath,
			...environmentService.extraExtensionPaths,
			...environmentService.extraBuiltinExtensionPaths,
		];

		this.ipc.registerChannel('logger', new LoggerChannel(logService));
		this.ipc.registerChannel(ExtensionHostDebugBroadcastChannel.ChannelName, new ExtensionHostDebugBroadcastChannel());

		this.services.set(ILogService, logService);
		this.services.set(IEnvironmentService, environmentService);
		this.services.set(IConfigurationService, new SyncDescriptor(ConfigurationService, [environmentService.machineSettingsResource, fileService]));
		this.services.set(IRequestService, new SyncDescriptor(RequestService));
		this.services.set(IFileService, fileService);
		this.services.set(IProductService, { _serviceBrand: undefined, ...product });
		this.services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService));
		this.services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService));

		if (!environmentService.args['disable-telemetry']) {
			this.services.set(ITelemetryService, new SyncDescriptor(TelemetryService, [{
				appender: combinedAppender(
					new AppInsightsAppender('code-server', null, () => new TelemetryClient() as any, logService),
					new LogAppender(logService),
				),
				commonProperties: resolveCommonProperties(
					product.commit, product.version, await getMachineId(),
					[], environmentService.installSourcePath, 'code-server',
				),
				piiPaths,
			} as ITelemetryServiceConfig]));
		} else {
			this.services.set(ITelemetryService, NullTelemetryService);
		}

		await new Promise((resolve) => {
			const instantiationService = new InstantiationService(this.services);
			this.services.set(ILocalizationsService, instantiationService.createInstance(LocalizationsService));
			this.services.set(INodeProxyService, instantiationService.createInstance(NodeProxyService));

			instantiationService.invokeFunction(() => {
				instantiationService.createInstance(LogsDataCleaner);
				const telemetryService = this.services.get(ITelemetryService) as ITelemetryService;
				this.ipc.registerChannel('extensions', new ExtensionManagementChannel(
					this.services.get(IExtensionManagementService) as IExtensionManagementService,
					(context) => getUriTransformer(context.remoteAuthority),
				));
				this.ipc.registerChannel('remoteextensionsenvironment', new ExtensionEnvironmentChannel(
					environmentService, logService, telemetryService, '',
				));
				this.ipc.registerChannel('request', new RequestChannel(this.services.get(IRequestService) as IRequestService));
				this.ipc.registerChannel('telemetry', new TelemetryChannel(telemetryService));
				this.ipc.registerChannel('nodeProxy', new NodeProxyChannel(this.services.get(INodeProxyService) as INodeProxyService));
				this.ipc.registerChannel('localizations', <IServerChannel<any>>createChannelReceiver(this.services.get(ILocalizationsService) as ILocalizationsService));
				this.ipc.registerChannel(REMOTE_FILE_SYSTEM_CHANNEL_NAME, new FileProviderChannel(environmentService, logService));
				resolve(new ErrorTelemetry(telemetryService));
			});
		});
	}

	/**
	 * TODO: implement.
	 */
	private async getDebugPort(): Promise<number | undefined> {
		return undefined;
	}
}
