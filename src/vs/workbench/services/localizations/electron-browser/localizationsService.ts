/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createChannelSender } from 'vs/base/parts/ipc/node/ipc';
import { ILocalizationsService } from 'vs/platform/localizations/common/localizations';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';

export class LocalizationsService {

	_serviceBrand: undefined;

	constructor(
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
	) {
		return createChannelSender<ILocalizationsService>(remoteAgentService.getConnection()!.getChannel('localizations'));
	}
}

registerSingleton(ILocalizationsService, LocalizationsService, true);
