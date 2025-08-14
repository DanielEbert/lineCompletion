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

export function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

interface TreeNode {
	type: 'file' | 'folder';
	path: string;
	children: { [key: string]: TreeNode };
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
				case 'openUrl': {
					if (data.url) {
						await this.copyAllContextToClipboard();
						vscode.env.openExternal(vscode.Uri.parse(data.url));
						if (process.platform === 'darwin') {
							setTimeout(() => {
								exec(
									'osascript -e \'tell application "System Events" to keystroke "v" using command down\' -e \'tell application "System Events" to key code 36 using command down\'',
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

		this._view.webview.postMessage({ type: 'updateState', state });
		this._view.badge = {
			value: contextLength,
			tooltip: `${contextLength} context items`
		};
	}

	private async copyAllContextToClipboard() {
		const activeInstance = this.getActiveInstance();
		if (!activeInstance || activeInstance.context.length === 0) {
			vscode.window.showInformationMessage("No context to copy.");
			return;
		}

		const llmContext = activeInstance.context;
		const mainIndex = activeInstance.mainContextIndex;

		if (llmContext.length === 0) {
			vscode.window.showInformationMessage("No context to copy.");
			return;
		}

		let mainText: string | null = null;
		const supplementaryText: string[] = []
		const urls: string[] = []
		const filepaths: string[] = []

		console.log(llmContext)

		llmContext.forEach((item, index) => {
			if (item.ignored) {
				return;
			}
			console.log(item.type === 'File' + ' ' + item.type)
			if (index === mainIndex) {
				mainText = item.context;
				return;
			}

			if (item.type === 'Text') {
				supplementaryText.push(item.context)
			} else if (item.type === 'File') {
				console.log(item.type)
				filepaths.push(item.context);
			} else if (item.type === 'Url') {
				urls.push(item.context)
			}
		});

		console.log(filepaths)

		const workspaceFolders = vscode.workspace.workspaceFolders;
		const workspaceRoot = workspaceFolders ? workspaceFolders[0].uri.fsPath : null;


		const formattedContext = await fetchContext({
			main_text: mainText,
			supplementary_text: supplementaryText,
			urls,
			filepaths,
			symbol_implementations: [],
			web_search_enabled: activeInstance.webSearchEnabled,
			workspace_root: workspaceRoot,
		});
		if (formattedContext == null) return;  // log called in fetchContext

		await vscode.env.clipboard.writeText(formattedContext);
		vscode.window.showInformationMessage("All context items copied to clipboard!");
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

/**
 * Checks if a line is semantically empty for Python code.
 * A line is considered semantically empty if it contains only whitespace,
 * or if it contains only whitespace followed by a comment.
 * @param line The line of text to check.
 */
function isLineSemanticallyEmpty(line: string): boolean {
	// The regex explained:
	// ^\s*      - Matches any whitespace at the start of the line.
	// (#.*)?    - Optionally matches a group:
	//   #       - A literal '#' character.
	//   .*      - Any character, zero or more times (the rest of the comment).
	// $         - Matches the end of the line.
	return /^\s*(#.*)?$/.test(line);
}

function insertAtPosition(text: string, insertLine: number, insertChar: number, insertText: string) {
	const lines = text.split('\n');

	// If the line doesn't exist, add empty lines up to that point
	while (lines.length <= insertLine) {
		lines.push('');
	}

	let line = lines[insertLine];
	if (insertChar > line.length) {
		line += ' '.repeat(insertChar - line.length);
	}
	const newLine = line.slice(0, insertChar) + insertText + line.slice(insertChar);
	lines[insertLine] = newLine;

	return lines.join('\n');
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


let llmCompletionTriggered = false;

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

	const provider: vscode.InlineCompletionItemProvider = {
		async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, completionContext: vscode.InlineCompletionContext, token: vscode.CancellationToken) {
			if (!llmCompletionTriggered) {
				return;
			}
			llmCompletionTriggered = false;

			let contextLine = position.line;
			for (let i = contextLine; i >= Math.max(0, contextLine - 3); i--) {
				if (!isLineSemanticallyEmpty(document.lineAt(i).text)) {
					contextLine = i;
					break;
				}
			}

			console.log('Context line ' + contextLine)
			const contextPosition = new vscode.Position(contextLine, 0);

			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				document.uri
			);

			const enclosingFunctionSymbol = findEnclosingFunctionSymbol(symbols, contextPosition);

			let startLine: number;
			let endLine: number;

			if (enclosingFunctionSymbol) {
				startLine = enclosingFunctionSymbol.range.start.line;
				endLine = Math.max(enclosingFunctionSymbol.range.end.line, position.line + 1);
			} else {
				console.log('no enclosing function found, using 10 lines around cursor as fallback context')
				startLine = Math.max(0, position.line - 10);
				endLine = position.line + 10;
			}

			const closeContextSource = await fetchSymbolImplementation([{
				name: '',
				path: document.uri.fsPath,
				startLine: position.line,
				startCol: 0,
				endLine: position.line,
				endCol: 100000,
				expand_to_class: true
			}]);
			if (!closeContextSource) {
				console.error('failed to fetch close context implementation')
				return [];
			}

			const closeContext = insertAtPosition(closeContextSource[0].text, position.line - closeContextSource[0].start_line, position.character, '/*@@*/')
			console.log(closeContext)

			if (enclosingFunctionSymbol) {
				let referenceLocations = await vscode.commands.executeCommand<vscode.Location[]>(
					'vscode.executeReferenceProvider',
					document.uri,
					enclosingFunctionSymbol.selectionRange.start
				);
				referenceLocations = referenceLocations.filter(
					location => location.range.start.line !== enclosingFunctionSymbol.selectionRange.start.line || location.uri.fsPath !== document.uri.fsPath
				)
				console.log(referenceLocations)
				const referenceImplementations = await fetchSymbolImplementation(referenceLocations.map(ref => ({
					name: '',
					path: ref.uri.fsPath,
					startLine: ref.range.start.line,
					startCol: ref.range.start.character,
					endLine: ref.range.end.line,
					endCol: ref.range.end.character,  // exclusive
				})))
				// for each referenceLocation, get the surrounding function or class or context (if in global context)
				console.log(referenceImplementations)
				// TODO: store all contexts and their uri and line range in dict, so that we can later easily remove duplicates
			}

			const symbolLocations = await fetchSymbolLocations(document.uri.fsPath, startLine, endLine);
			const symbolImplementationLocations = await getSymbolLocations(symbolLocations, document);
			const symbolImplementations = await fetchSymbolImplementation(symbolImplementationLocations);
			console.log(symbolImplementations)
			if (symbolImplementations == null) {
				console.error('failed to fetch symbol implementations')
				return [];
			}

			// symbolImplementations.unshift({text: closeContext})

			// 			const wrappedSymbolImplementations = symbolImplementations.map(impl => {
			// 				return `\`\`\`python
			// ${impl.text}
			// \`\`\``;
			// 			});

			// const prompt = wrappedSymbolImplementations.join('\n\n')
			// console.log(prompt)

			console.log('starting fetch')
			const suggestions = await fetchSuggestions({
				closeContext,
				symbolImplementations,
				llmContext: context.workspaceState.get<any>('llmContext', []),
				webSearchenabled: context.workspaceState.get<any>('llmContextWebSearchEnabled', false),
			});
			console.log('fetched ' + suggestions)

			if (!suggestions || suggestions.length == 0) {
				vscode.window.showInformationMessage('No suggestion returned from backend.');
				return [];
			}

			return suggestions.map((suggestion) => {
				return new vscode.InlineCompletionItem(suggestion)
			});
		}
	};

	vscode.languages.registerInlineCompletionItemProvider({ language: 'python' }, provider);

	const triggerCommand = vscode.commands.registerCommand('linecompletion.suggestFromContext', () => {
		llmCompletionTriggered = true;
		vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
	});

	context.subscriptions.push(triggerCommand)
}

async function fetchContext(context: any): Promise<string | null> {
	try {
		const response = await fetch('http://127.0.0.1:7524/context', {
			method: 'POST',
			body: JSON.stringify(context),
			headers: { 'Content-Type': 'application/json' }
		});

		if (!response.ok) {
			console.error('Backend returned error: ', response.status)
			console.error(response.text)
			return null;
		}

		return await response.json();
	} catch (err) {
		console.error('Error contacting backend:', err);
		return null;
	}
}

// TODO: typing
async function fetchSymbolImplementation(symbolImplementationLocations: any): Promise<any[] | null> {
	try {
		const response = await fetch('http://127.0.0.1:7524/symbol_source', {
			method: 'POST',
			body: JSON.stringify(symbolImplementationLocations),
			headers: { 'Content-Type': 'application/json' }
		});

		if (!response.ok) {
			console.error('Backend returned error: ', response.status)
			console.error(response.text)
			return null;
		}

		return await response.json();
	} catch (err) {
		console.error('Error contacting backend:', err);
		return null;
	}
}

async function fetchSymbolLocations(path: string, start_line: number, end_line: number): Promise<any | null> {
	try {
		const response = await fetch('http://127.0.0.1:7524/symbol_locations', {
			method: 'POST',
			body: JSON.stringify({
				path: path,
				start_line: start_line,
				end_line: end_line,
			}),
			headers: { 'Content-Type': 'application/json' }
		});

		if (!response.ok) {
			console.error('Backend returned error: ', response.status)
			console.error(response.text)
			return null;
		}

		return await response.json();
	} catch (err) {
		console.error('Error contacting backend:', err);
		return null;
	}
}

async function fetchSuggestions(body: any): Promise<string[] | null> {
	try {
		const response = await fetch('http://127.0.0.1:7524/suggest', {
			method: 'POST',
			body: JSON.stringify(body),
			headers: { 'Content-Type': 'application/json' }
		});

		if (!response.ok) {
			console.error('Backend returned error: ', response.status)
			console.error(response.text)
			return null;
		}

		const data = await response.json();
		return data.response;
	} catch (err) {
		console.error('Error contacting backend:', err);
		return null;
	}
}

export function deactivate() {
	console.log('linecompletion is deactivated')
}
