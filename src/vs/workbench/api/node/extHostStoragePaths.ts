/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'vs/base/common/path';
import { URI } from 'vs/base/common/uri';
import { IEnvironment, IStaticWorkspaceData, MainContext } from 'vs/workbench/api/common/extHost.protocol';
import { IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { IExtensionStoragePaths } from 'vs/workbench/api/common/extHostStoragePaths';
import { IExtHostInitDataService } from 'vs/workbench/api/common/extHostInitDataService';
import { withNullAsUndefined } from 'vs/base/common/types';
import { ILogService } from 'vs/platform/log/common/log';
import { IExtHostRpcService } from '../common/extHostRpcService';
import { VSBuffer } from 'vs/base/common/buffer';

export class ExtensionStoragePaths implements IExtensionStoragePaths {

	readonly _serviceBrand: undefined;

	private readonly _workspace?: IStaticWorkspaceData;
	private readonly _environment: IEnvironment;

	readonly whenReady: Promise<string | undefined>;
	private _value?: string;

	constructor(
		@IExtHostInitDataService initData: IExtHostInitDataService,
		@ILogService private readonly _logService: ILogService,
		@IExtHostRpcService private readonly _extHostRpc: IExtHostRpcService,
	) {
		this._workspace = withNullAsUndefined(initData.workspace);
		this._environment = initData.environment;
		this.whenReady = this._getOrCreateWorkspaceStoragePath().then(value => this._value = value);
	}

	workspaceValue(extension: IExtensionDescription): string | undefined {
		if (this._value) {
			return path.join(this._value, extension.identifier.value);
		}
		return undefined;
	}

	globalValue(extension: IExtensionDescription): string {
		return path.join(this._environment.globalStorageHome.fsPath, extension.identifier.value.toLowerCase());
	}

	private async _getOrCreateWorkspaceStoragePath(): Promise<string | undefined> {
		if (!this._workspace) {
			return Promise.resolve(undefined);
		}

		if (!this._environment.appSettingsHome) {
			return undefined;
		}
		const storageName = this._workspace.id;
		const storagePath = path.join(this._environment.appSettingsHome.fsPath, 'workspaceStorage', storageName);

		// NOTE@coder: Use the file system proxy so this will work in the browser.
		const fileSystem = this._extHostRpc.getProxy(MainContext.MainThreadFileSystem);
		try {
			await fileSystem.$stat(URI.file(storagePath));
			return storagePath;
		} catch (error) {
			// Doesn't exist.
		}

		try {
			// NOTE@coder: $writeFile performs a mkdirp.
			await fileSystem.$writeFile(
				URI.file(path.join(storagePath, 'meta.json')),
				VSBuffer.fromString(
					JSON.stringify({
						id: this._workspace.id,
						configuration: this._workspace.configuration && URI.revive(this._workspace.configuration).toString(),
						name: this._workspace.name
					}, undefined, 2)
				)
			);
			return storagePath;

		} catch (e) {
			this._logService.error(e);
			return undefined;
		}
	}
}
