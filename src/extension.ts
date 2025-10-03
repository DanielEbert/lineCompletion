import * as vscode from 'vscode';
import fetch from 'node-fetch'
import * as fs from 'fs';
import ignore from 'ignore';
import path from 'path';
import { exec } from 'child_process';
import Fuse from 'fuse.js';


interface ContextInstance {
	id: string;
	name: string;
	context: any[];
	mainContextIndex: number;
	webSearchEnabled: boolean;
}

interface ExtensionState {
	activeInstanceId: string | null;
	instances: ContextInstance[];
}

interface TreeNode {
	type: 'file' | 'folder';
	path: string;
	children: { [key: string]: TreeNode };
}

interface ModelConfig {
	name: string;
	url: string;
	pasteDelay: number;
}


export function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function makeSection(tag: string, title: string, content: string): string {
	return `
# [${tag} Start] - ${title}

${content}

# [${tag} End] - ${title}
`;
}

function makeCodeSection(tag: string, title: string, content: string, language: string): string {
	return `
# [${tag} Start] - ${title}

\`\`\`${language}
${content}
\`\`\`

# [${tag} End] - ${title}
`;
}

async function urlToText(url: string, jinaApiKey: string): Promise<string> {
	const response = await fetch(`https://r.jina.ai/${url}`, {
		headers: jinaApiKey ? { Authorization: `Bearer ${jinaApiKey}` } : {}
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to fetch data: ${response.status} ${response.statusText} - ${text}`);
	}

	const data = await response.text();
	return data;
}

/**
 * Processes context pieces to generate a consolidated context string of all relevant information.
 *
 * @param mainText - The primary text content for the main task.
 * @param supplementaryText - An array of additional text snippets for context.
 * @param urls - An array of URLs to fetch and include.
 * @param filepaths - An array of relative file paths to read and include.
 * @param symbolImplementations - An array of strings representing symbol implementations.
 * @param webSearchEnabled - A boolean indicating if web search is enabled.
 * @param workspaceRoot - The root path of the workspace for resolving file paths.
 * @param jinaApiKey - The Jina API key for fetching URL content.
 * @returns A promise that resolves to the formatted context string.
 */
async function getContext(
	mainText: string | null,
	supplementaryText: string[],
	urls: string[],
	filepaths: string[],
	symbolImplementations: string[],  // TODO
	webSearchEnabled: boolean,  // TODO
	workspaceRoot: string | null,
	jinaApiKey: string
): Promise<string> {
	const sections: string[] = [];

	if (mainText) {
		sections.push(makeSection("TASK", "Main Content", mainText));
	}

	if (supplementaryText.length > 0) {
		const combinedSupplementary = supplementaryText.join("\n\n---\n\n");
		sections.push(makeSection("CONTEXT", "Additional Information", combinedSupplementary));
	}

	for (const relFilepath of filepaths) {
		const filepath = workspaceRoot ? `${workspaceRoot}/${relFilepath}` : relFilepath;

		try {
			const filecontent = fs.readFileSync(filepath, "utf-8");
			const language = relFilepath.endsWith('.py') ? 'python' : '';
			sections.push(makeCodeSection("FILE", relFilepath, filecontent, language));
		} catch (e) {
			console.error(`Failed to read ${filepath}: ${e}`);
		}
	}

	for (const url of urls) {
		try {
			sections.push(makeSection("URL", url, await urlToText(url, jinaApiKey)));
		} catch (e) {
			console.error(`Failed to get page content for ${url}: ${e}`);
		}
	}

	if (mainText) {
		sections.push(makeSection("TASK", "Main Content", mainText));
	}

	return sections.join("\n\n---\n\n");
}


export class ContextViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'llmContextView';
	private _view?: vscode.WebviewView;
	private isInDebugMode: boolean;

	constructor(private readonly _extensionUri: vscode.Uri, private _context: vscode.ExtensionContext) {
		this.isInDebugMode = _context.extensionMode === vscode.ExtensionMode.Development;
		this.initializeState();
	}

	private initializeState() {
		const state = this.getState();
		if (!state || !state.instances || state.instances.length === 0) {
			const newId = this.generateInstanceId();
			const defaultState: ExtensionState = {
				activeInstanceId: newId,
				instances: [{
					id: newId,
					name: 'Default',
					context: [],
					mainContextIndex: -1,
					webSearchEnabled: false,
				}]
			};
			this.setState(defaultState);
		}
	}

	private generateInstanceId(): string {
		return Date.now().toString(36) + Math.random().toString(36).substring(2);
	}

	private getState(): ExtensionState {
		return this._context.workspaceState.get<ExtensionState>('llmContextState', { activeInstanceId: null, instances: [] });
	}

	private setState(state: ExtensionState) {
		return this._context.workspaceState.update('llmContextState', state);
	}

	private getActiveInstance(): ContextInstance | undefined {
		const state = this.getState();
		if (!state.activeInstanceId) return undefined;
		return state.instances.find(inst => inst.id === state.activeInstanceId);
	}

	public async addSelectionToContext() {
		const editor = vscode.window.activeTextEditor;
		const activeInstance = this.getActiveInstance();
		if (!activeInstance) return;

		if (editor && !editor.selection.isEmpty) {
			const selection = editor.selection;
			const selectedText = editor.document.getText(selection);

			activeInstance.context.push({ type: 'Text', context: selectedText, ignored: false });
			this.updateStateAndRefreshView();
		} else {
			vscode.window.showInformationMessage('No text selected in the active editor.');
		}
	}

	public resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken): Thenable<void> | void {
		this._view = webviewView;

		const webviewSource = this.isInDebugMode ? 'src' : 'out';
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, webviewSource, 'webview')]
		}

		webviewView.webview.html = this._getHtml()

		webviewView.webview.onDidReceiveMessage(async (data) => {
			const state = this.getState();
			const activeInstance = this.getActiveInstance();

			switch (data.type) {
				case 'addInstance': {
					const newId = this.generateInstanceId();
					const newInstance: ContextInstance = {
						id: newId,
						name: `Tab ${state.instances.length + 1}`,
						context: [],
						mainContextIndex: -1,
						webSearchEnabled: false,
					};
					state.instances.push(newInstance);
					state.activeInstanceId = newId;
					await this.setState(state);
					this.updateView();
					break;
				}
				case 'removeInstance': {
					const { instanceId } = data;
					const indexToRemove = state.instances.findIndex(inst => inst.id === instanceId);
					if (indexToRemove === -1) break;

					state.instances.splice(indexToRemove, 1);

					if (state.activeInstanceId === instanceId) {
						if (state.instances.length > 0) {
							const newActiveIndex = Math.max(0, indexToRemove - 1);
							state.activeInstanceId = state.instances[newActiveIndex].id;
						} else {
							state.activeInstanceId = null;
						}
					}

					if (state.instances.length === 0) {
						this.initializeState();
					} else {
						await this.setState(state);
					}
					this.updateView();
					break;
				}
				case 'switchInstance': {
					state.activeInstanceId = data.instanceId;
					await this.setState(state);
					this.updateView();
					break;
				}
				case 'renameInstance': {
					const { instanceId, newName } = data;
					const instanceToRename = state.instances.find(inst => inst.id === instanceId);
					if (instanceToRename) {
						instanceToRename.name = newName;
						await this.setState(state);
						this.updateView();
					}
					break;
				}
				case 'getWorkspaceTree': {
					const tree = await this._getWorkspaceTree();
					this._view?.webview.postMessage({ type: 'workspaceTree', tree });
					break;
				}
				case 'addFileToContext': {
					if (!activeInstance) break;
					if (data.filePath && !activeInstance.context.some(item => item.type === 'File' && item.context === data.filePath)) {
						activeInstance.context.push({ type: 'File', context: data.filePath });
						await this.updateStateAndRefreshView();
					}
					break;
				}
				case 'removeFileFromContext': {
					if (!activeInstance) break;
					if (data.filePath) {
						activeInstance.context = activeInstance.context.filter(item => !(item.type === 'File' && item.context === data.filePath));
						await this.updateStateAndRefreshView();
					}
					break;
				}
				case 'addFile': {
					if (!activeInstance) break;
					const fileUri = await vscode.window.showOpenDialog({ canSelectMany: false });
					if (fileUri && fileUri.length > 0) {
						const workspaceFolders = vscode.workspace.workspaceFolders;
						if (workspaceFolders) {
							const workspaceRoot = workspaceFolders[0].uri.fsPath;
							const relativePath = path.relative(workspaceRoot, fileUri[0].fsPath);
							activeInstance.context.push({ type: 'File', context: relativePath });
							await this.updateStateAndRefreshView();
						}
					}
					break;
				}
				case 'addUrl': {
					if (!activeInstance) break;
					const url = await vscode.window.showInputBox({ prompt: 'Enter URL' });
					if (url && url.length > 0) {
						activeInstance.context.push({ type: 'Url', context: url });
						await this.updateStateAndRefreshView();
					}
					break;
				}
				case 'addText': {
					if (!activeInstance) break;
					activeInstance.context.push({ type: 'Text', context: "", ignored: false });
					await this.updateStateAndRefreshView();
					break;
				}
				case 'addSelectionToContext': {
					this.addSelectionToContext();
					break;
				}
				case 'setMainContext': {
					if (!activeInstance) break;
					const newIndex = activeInstance.mainContextIndex === data.index ? -1 : data.index;
					if (newIndex === -1 || activeInstance.context[newIndex]?.type === 'Text') {
						activeInstance.mainContextIndex = newIndex;
						await this.updateStateAndRefreshView();
					}
					break;
				}
				case 'toggleIgnoreContext': {
					if (!activeInstance) break;
					if (data.index >= 0 && data.index < activeInstance.context.length) {
						const item = activeInstance.context[data.index];
						if (item.type === 'Text') {
							item.ignored = !item.ignored;
						}
						await this.updateStateAndRefreshView();
					}
					break;
				}
				case 'getLocalFiles': {
					if (!data.query || data.query.length < 1) {
						this._view?.webview.postMessage({ type: 'fileSuggestions', suggestions: [], index: data.index });
						break;
					}
					const files = await this.findWorkspaceFiles();
					const workspaceFolders = vscode.workspace.workspaceFolders;
					if (workspaceFolders) {
						const workspaceRoot = workspaceFolders[0].uri.fsPath;
						const allFilePaths = files.map(file => path.relative(workspaceRoot, file.path));

						const fuse = new Fuse(allFilePaths, { threshold: 0.4 });
						const searchResults = fuse.search(data.query);
						const suggestions = searchResults.map(result => result.item).slice(0, 20);

						this._view?.webview.postMessage({ type: 'fileSuggestions', suggestions: suggestions, index: data.index });
					}
					break;
				}
				case 'updateTextContext': {
					if (!activeInstance) break;
					if (data.index >= 0 && data.index < activeInstance.context.length) {
						activeInstance.context[data.index].context = data.context;
						await this.setState(state);
					}
					break;
				}
				case 'removeContext': {
					if (!activeInstance) break;
					const mainIndex = activeInstance.mainContextIndex;
					activeInstance.context = activeInstance.context.filter((_, index) => index !== data.index);

					if (data.index === mainIndex) {
						activeInstance.mainContextIndex = -1;
					} else if (data.index < mainIndex) {
						activeInstance.mainContextIndex = mainIndex - 1;
					}

					await this.updateStateAndRefreshView();
					break;
				}
				case 'clearContext': {
					if (!activeInstance) break;
					activeInstance.context = [];
					activeInstance.mainContextIndex = -1;
					await this.updateStateAndRefreshView();
					break;
				}
				case 'copyAllContext': {
					this.copyAllContextToClipboard();
					break;
				}
				case 'requestUpdate': {
					this.updateView();
					break;
				}
				case 'toggleWebSearch': {
					if (activeInstance) {
						activeInstance.webSearchEnabled = data.enabled;
						await this.updateStateAndRefreshView();
					}
					break;
				}
				case 'setJinaApiKey': {
					if (typeof data.apiKey === 'string') {
						await this._context.workspaceState.update('jinaApiKey', data.apiKey);
					}
					break;
				}
				case 'setModelConfigs': {
					if (data.models) {
						await this._context.workspaceState.update('modelConfigs', data.models);
					}
					break;
				}
				case 'openUrl': {
					if (data.url) {
						const success = await this.copyAllContextToClipboard();
						if (!success) break;
						vscode.env.openExternal(vscode.Uri.parse(data.url));
						if (process.platform === 'darwin') {
							setTimeout(() => {
								exec(
									'osascript -e \'tell application "System Events" to keystroke "v" using command down\' -e \'delay 0.5\' -e \'tell application "System Events" to key code 36\'',
									(error) => {
										if (error) {
											console.error(`Failed to execute paste+enter command: ${error}`);
											vscode.window.showErrorMessage('Auto-paste failed. Please paste manually (Cmd+V).');
										}
									}
								);
							}, data.pasteDelay);
						}
					}
					break;
				}
			}
		})
	}

	private async updateStateAndRefreshView() {
		// This is not a noop - we modified activeInstance via a pointer before, which is now dirty and not yet persisted.
		// We call setState on the dirty activeInstance to tell vscode to persist the modified data.
		const state = this.getState();
		await this.setState(state);
		this.updateView();
	}

	public updateView() {
		if (!this._view) return;
		const state = this.getState();
		const activeInstance = this.getActiveInstance();
		const contextLength = activeInstance ? activeInstance.context.length : 0;
		const jinaApiKey = this._context.workspaceState.get<string>('jinaApiKey', '');

		const defaultModels: ModelConfig[] = [
			{ name: 'Gemini', url: 'https://aistudio.google.com/prompts/new_chat?hl=de', pasteDelay: 1500 },
			{ name: 'GLM-4.5', url: 'https://chat.z.ai/', pasteDelay: 6000 }
		];
		const modelConfigs = this._context.workspaceState.get<ModelConfig[]>('modelConfigs', defaultModels);

		this._view.webview.postMessage({
			type: 'update',
			state: state,
			settings: { jinaApiKey, modelConfigs }
		});

		this._view.badge = {
			value: contextLength,
			tooltip: `${contextLength} context items`
		};
	}

	private async copyAllContextToClipboard(): Promise<boolean> {
		const activeInstance = this.getActiveInstance();
		if (!activeInstance || activeInstance.context.length === 0) {
			vscode.window.showInformationMessage("No context to copy.");
			return true;
		}

		const llmContext = activeInstance.context;
		const mainIndex = activeInstance.mainContextIndex;

		let mainText: string | null = null;
		const supplementaryText: string[] = [];
		const urls: string[] = [];
		const filepaths: string[] = [];

		console.log(llmContext);

		llmContext.forEach((item, index) => {
			if (item.ignored) {
				return;
			}
			console.log(item.type === 'File' + ' ' + item.type);
			if (index === mainIndex) {
				mainText = item.context;
				return;
			}

			if (item.type === 'Text') {
				supplementaryText.push(item.context);
			} else if (item.type === 'File') {
				console.log(item.type);
				filepaths.push(item.context);
			} else if (item.type === 'Url') {
				urls.push(item.context);
			}
		});

		const jinaApiKey = this._context.workspaceState.get<string>('jinaApiKey');

		console.log(filepaths);

		const workspaceFolders = vscode.workspace.workspaceFolders;
		const workspaceRoot = workspaceFolders ? workspaceFolders[0].uri.fsPath : null;

		const formattedContext = await getContext(
			mainText,
			supplementaryText,
			urls,
			filepaths,
			[],
			activeInstance.webSearchEnabled,
			workspaceRoot,
			jinaApiKey || '',
		);
		if (formattedContext == null) {
			return false;
		}

		await vscode.env.clipboard.writeText(formattedContext);
		vscode.window.showInformationMessage("All context items copied to clipboard!");
		return true;
	}

	private async findWorkspaceFiles() {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return [];
		}

		const workspaceRoot = workspaceFolders[0].uri.fsPath;
		const gitignorePath = path.join(workspaceRoot, '.gitignore');

		if (fs.existsSync(gitignorePath)) {
			// Load and parse .gitignore
			const ig = ignore();
			ig.add(fs.readFileSync(gitignorePath, 'utf8'));
			ig.add('.git');

			// Find all files and filter via .gitignore
			const allFiles = await vscode.workspace.findFiles('**/*', null);
			return allFiles.filter(uri => !ig.ignores(path.relative(workspaceRoot, uri.fsPath)));
		} else {
			// Fall back to hardcoded exclude
			return vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/venv/**}');
		}
	}

	private async _getWorkspaceTree() {
		const files = await this.findWorkspaceFiles();
		const tree = {};

		const insertIntoTree = (parts: string[], filePath: string): void => {
			let currentLevel: { [key: string]: TreeNode } = tree;
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				const isFile = i === parts.length - 1;
				if (!currentLevel[part]) {
					currentLevel[part] = {
						type: isFile ? 'file' : 'folder',
						path: isFile ? filePath : '',
						children: {}
					};
				}
				currentLevel = currentLevel[part].children;
			}
		};

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
		if (!workspaceRoot) return [];

		files.forEach(file => {
			const relativePath = path.relative(workspaceRoot, file.fsPath).replace(/\\/g, "/");
			const parts = relativePath.split('/');
			insertIntoTree(parts, relativePath);
		});

		const convertTreeToArray = (node: { [key: string]: TreeNode }): Array<{ name: string; type: string; path: string; children: any[] }> => {
			return Object.entries(node).map(([name, value]) => {
				const child = value as TreeNode;
				return {
					name,
					type: child.type,
					path: child.path,
					children: convertTreeToArray(child.children)
				};
			}).sort((a, b) => {
				if (a.type === b.type) {
					return a.name.localeCompare(b.name);
				}
				return a.type === 'folder' ? -1 : 1;
			});
		};

		return convertTreeToArray(tree);
	}

	private _getHtml() {
		const webviewSource = this.isInDebugMode ? 'src' : 'out';
		const htmlPath = vscode.Uri.joinPath(this._extensionUri, webviewSource, 'webview', 'index.html');
		let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
		return htmlContent;
	}
}


function findEnclosingFunctionSymbol(symbols: vscode.DocumentSymbol[], pos: vscode.Position): vscode.DocumentSymbol | undefined {
	for (const symbol of symbols) {
		if (symbol.range.contains(pos)) {
			// might also be inside a more specific child symbol
			const childSymbol = findEnclosingFunctionSymbol(symbol.children, pos);
			if (childSymbol) return childSymbol;

			if (symbol.kind === vscode.SymbolKind.Function || symbol.kind === vscode.SymbolKind.Method) {
				return symbol;
			}
		}
	}
	return undefined;
}

async function getSymbolLocations(symbolLocations: any, document: vscode.TextDocument) {
	const timeoutMs = 5000;
	const ctsImplementations = new vscode.CancellationTokenSource();
	const implementationTimeout = setTimeout(() => ctsImplementations.cancel(), timeoutMs);

	const implementationPromises = symbolLocations.map((symbol: any) => {
		const position = new vscode.Position(symbol[1], symbol[2]);
		try {
			return vscode.commands.executeCommand<vscode.Location[]>(
				'vscode.executeImplementationProvider',
				document.uri,
				position,
				ctsImplementations.token
			)
				.then(locations => locations || [])
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				console.log(`Implementation search for '${symbol.name}' was cancelled.`);
				return [];
			}
			// Handle other potential errors
			console.error(`Error finding implementation for ${symbol.name}:`, error);
			return [];
		}
	})

	let nestedLocations = null;
	try {
		nestedLocations = await Promise.all(implementationPromises)
		// TODO: deduplicate
		// return nestedLocations;
		console.log(nestedLocations)
	} finally {
		clearTimeout(implementationTimeout)
		ctsImplementations.dispose()
	}

	const symbolImplementationLocations = [];
	for (let i = 0; i < symbolLocations.length; i++) {
		if (nestedLocations[i].length < 1) continue;
		const name = symbolLocations[i][0];
		const location = nestedLocations[i][0];
		const path = location.uri.path;
		if (path.includes('/stdlib/')) continue;
		symbolImplementationLocations.push({
			name,
			path,
			startLine: location.range.start.line,
			startCol: location.range.start.character,
			endLine: location.range.end.line,
			endCol: location.range.end.character,  // exclusive
		})
	}

	return symbolImplementationLocations;
}


export function activate(context: vscode.ExtensionContext) {
	console.log('linecompletion is active');

	const contextProvider = new ContextViewProvider(context.extensionUri, context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ContextViewProvider.viewType, contextProvider)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('linecompletion.addSelectionToContext', () => {
			contextProvider.addSelectionToContext();
		})
	);
}

export function deactivate() {
	console.log('linecompletion is deactivated')
}
