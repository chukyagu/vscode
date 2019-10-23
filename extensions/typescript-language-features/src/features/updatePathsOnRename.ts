/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import * as Proto from '../protocol';
import { ITypeScriptServiceClient } from '../typescriptService';
import API from '../utils/api';
import { nulToken } from '../utils/cancellation';
import { VersionDependentRegistration } from '../utils/dependentRegistration';
import { Disposable } from '../utils/dispose';
import * as fileSchemes from '../utils/fileSchemes';
import { isTypeScriptDocument } from '../utils/languageModeIds';
import * as typeConverters from '../utils/typeConverters';
import FileConfigurationManager from './fileConfigurationManager';

const localize = nls.loadMessageBundle();

const updateImportsOnFileMoveName = 'updateImportsOnFileMove.enabled';

async function isDirectory(resource: vscode.Uri): Promise<boolean> {
	try {
		return (await vscode.workspace.fs.stat(resource)).type === vscode.FileType.Directory;
	} catch {
		return false;
	}
}

const enum UpdateImportsOnFileMoveSetting {
	Prompt = 'prompt',
	Always = 'always',
	Never = 'never',
}

class UpdateImportsOnFileRenameHandler extends Disposable {
	public static readonly minVersion = API.v300;

	public constructor(
		private readonly client: ITypeScriptServiceClient,
		private readonly fileConfigurationManager: FileConfigurationManager,
		private readonly _handles: (uri: vscode.Uri) => Promise<boolean>,
	) {
		super();

		this._register(vscode.workspace.onDidRenameFile(e => {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Window,
				title: localize('renameProgress.title', "Checking for update of JS/TS imports")
			}, () => {
				return this.doRename(e.oldUri, e.newUri);
			});
		}));
	}

	private async doRename(
		oldResource: vscode.Uri,
		newResource: vscode.Uri,
	): Promise<void> {
		// Try to get a js/ts file that is being moved
		// For directory moves, this returns a js/ts file under the directory.
		const jsTsFileThatIsBeingMoved = await this.getJsTsFileBeingMoved(newResource);
		if (!jsTsFileThatIsBeingMoved || !this.client.toPath(jsTsFileThatIsBeingMoved)) {
			return;
		}

		const newFilePath = this.client.toPath(newResource);
		if (!newFilePath) {
			return;
		}

		const oldFilePath = this.client.toPath(oldResource);
		if (!oldFilePath) {
			return;
		}

		const document = await vscode.workspace.openTextDocument(jsTsFileThatIsBeingMoved);

		const config = this.getConfiguration(document);
		const setting = config.get<UpdateImportsOnFileMoveSetting>(updateImportsOnFileMoveName);
		if (setting === UpdateImportsOnFileMoveSetting.Never) {
			return;
		}

		// Make sure TS knows about file
		this.client.bufferSyncSupport.closeResource(oldResource);
		this.client.bufferSyncSupport.openTextDocument(document);

		const edits = await this.getEditsForFileRename(document, oldFilePath, newFilePath);
		if (!edits || !edits.size) {
			return;
		}

		if (await this.confirmActionWithUser(newResource, document)) {
			await vscode.workspace.applyEdit(edits);
		}
	}

	private async confirmActionWithUser(
		newResource: vscode.Uri,
		newDocument: vscode.TextDocument
	): Promise<boolean> {
		const config = this.getConfiguration(newDocument);
		const setting = config.get<UpdateImportsOnFileMoveSetting>(updateImportsOnFileMoveName);
		switch (setting) {
			case UpdateImportsOnFileMoveSetting.Always:
				return true;
			case UpdateImportsOnFileMoveSetting.Never:
				return false;
			case UpdateImportsOnFileMoveSetting.Prompt:
			default:
				return this.promptUser(newResource, newDocument);
		}
	}

	private getConfiguration(newDocument: vscode.TextDocument) {
		return vscode.workspace.getConfiguration(isTypeScriptDocument(newDocument) ? 'typescript' : 'javascript', newDocument.uri);
	}

	private async promptUser(
		newResource: vscode.Uri,
		newDocument: vscode.TextDocument
	): Promise<boolean> {
		const enum Choice {
			None = 0,
			Accept = 1,
			Reject = 2,
			Always = 3,
			Never = 4,
		}

		interface Item extends vscode.MessageItem {
			choice: Choice;
		}

		const response = await vscode.window.showInformationMessage<Item>(
			localize('prompt', "Update imports for moved file: '{0}'?", path.basename(newResource.fsPath)), {
			modal: true,
		}, {
			title: localize('reject.title', "No"),
			choice: Choice.Reject,
			isCloseAffordance: true,
		}, {
			title: localize('accept.title', "Yes"),
			choice: Choice.Accept,
		}, {
			title: localize('always.title', "Always automatically update imports"),
			choice: Choice.Always,
		}, {
			title: localize('never.title', "Never automatically update imports"),
			choice: Choice.Never,
		});

		if (!response) {
			return false;
		}

		switch (response.choice) {
			case Choice.Accept:
				{
					return true;
				}
			case Choice.Reject:
				{
					return false;
				}
			case Choice.Always:
				{
					const config = this.getConfiguration(newDocument);
					config.update(
						updateImportsOnFileMoveName,
						UpdateImportsOnFileMoveSetting.Always,
						vscode.ConfigurationTarget.Global);
					return true;
				}
			case Choice.Never:
				{
					const config = this.getConfiguration(newDocument);
					config.update(
						updateImportsOnFileMoveName,
						UpdateImportsOnFileMoveSetting.Never,
						vscode.ConfigurationTarget.Global);
					return false;
				}
		}

		return false;
	}

	private async getJsTsFileBeingMoved(resource: vscode.Uri): Promise<vscode.Uri | undefined> {
		if (resource.scheme !== fileSchemes.file) {
			return undefined;
		}

		if (await isDirectory(resource)) {
			const files = await vscode.workspace.findFiles({
				base: resource.fsPath,
				pattern: '**/*.{ts,tsx,js,jsx}',
			}, '**/node_modules/**', 1);
			return files[0];
		}

		return (await this._handles(resource)) ? resource : undefined;
	}

	private async getEditsForFileRename(
		document: vscode.TextDocument,
		oldFilePath: string,
		newFilePath: string,
	): Promise<vscode.WorkspaceEdit | undefined> {
		const response = await this.client.interruptGetErr(() => {
			this.fileConfigurationManager.setGlobalConfigurationFromDocument(document, nulToken);
			const args: Proto.GetEditsForFileRenameRequestArgs = {
				oldFilePath,
				newFilePath,
			};
			return this.client.execute('getEditsForFileRename', args, nulToken);
		});
		if (response.type !== 'response') {
			return;
		}

		return typeConverters.WorkspaceEdit.fromFileCodeEdits(this.client, response.body);
	}
}

export function register(
	client: ITypeScriptServiceClient,
	fileConfigurationManager: FileConfigurationManager,
	handles: (uri: vscode.Uri) => Promise<boolean>,
) {
	return new VersionDependentRegistration(client, UpdateImportsOnFileRenameHandler.minVersion, () =>
		new UpdateImportsOnFileRenameHandler(client, fileConfigurationManager, handles));
}
