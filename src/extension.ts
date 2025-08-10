import * as vscode from 'vscode';
import fetch from 'node-fetch'
import * as fs from 'fs';
import ignore from 'ignore';
import path from 'path';


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

	constructor(private readonly _extensionUri: vscode.Uri, private _context: vscode.ExtensionContext) { }

	public resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken): Thenable<void> | void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'src', 'webview')]
		}

		webviewView.webview.html = this._getHtml()

		webviewView.webview.onDidReceiveMessage(async (data) => {
			const currentContext = this._context.workspaceState.get<any[]>('llmContext', []);

			switch (data.type) {
				case 'getWorkspaceTree': {
					const tree = await this._getWorkspaceTree();
					this._view?.webview.postMessage({ type: 'workspaceTree', tree });
					break;
				}
				case 'addFileToContext': {
					if (data.filePath && !currentContext.some(item => item.type === 'File' && item.context === data.filePath)) {
						console.log('data.filePath', data.filePath)
						const newContext = [...currentContext, { type: 'File', context: data.filePath }];
						await this._context.workspaceState.update('llmContext', newContext);
						this.updateView();
					}
					break;
				}
				case 'removeFileFromContext': {
					if (data.filePath) {
						const newContext = currentContext.filter(item => !(item.type === 'File' && item.context === data.filePath));
						await this._context.workspaceState.update('llmContext', newContext);
						this.updateView();
					}
					break;
				}
				case 'addFile': {
					const fileUri = await vscode.window.showOpenDialog({ canSelectMany: false });
					if (fileUri && fileUri.length > 0) {
						const workspaceFolders = vscode.workspace.workspaceFolders;
						if (workspaceFolders) {
							const workspaceRoot = workspaceFolders[0].uri.fsPath;
							const relativePath = path.relative(workspaceRoot, fileUri[0].fsPath);
							const newContext = [...currentContext, { type: 'File', context: relativePath }]
							await this._context.workspaceState.update('llmContext', newContext);
							this.updateView();
						}
					}
					break;
				}
				case 'addUrl': {
					const url = await vscode.window.showInputBox({ prompt: 'Enter URL' });
					if (url && url.length > 0) {
						// TODO: on backend we want to fetch and summarize/parse website
						const newContext = [...currentContext, { type: 'Url', context: url }]
						await this._context.workspaceState.update('llmContext', newContext);
						this.updateView();
					}
					break;
				}
				case 'addText': {
					// Adding text now defaults to an empty string, allowing inline editing.
					const newContext = [...currentContext, { type: 'Text', context: "" }]
					await this._context.workspaceState.update('llmContext', newContext);
					this.updateView();
					break;
				}
				case 'setMainContext': {
					const mainIndex = this._context.workspaceState.get<number>('llmMainContextIndex', -1);

					// If the clicked index is the current main index, we toggle it off by setting the index to -1.
					// Otherwise, we set the clicked index as the new main index.
					const newIndex = mainIndex === data.index ? -1 : data.index;

					// We only allow 'Text' items to be set as main. Unsetting (when newIndex is -1) is always allowed.
					if (newIndex === -1 || currentContext[newIndex]?.type === 'Text') {
						await this._context.workspaceState.update('llmMainContextIndex', newIndex);
						this.updateView();
					}
					break;
				}
				case 'getLocalFiles': {
					if (!data.query || data.query.length < 1) {
						this._view?.webview.postMessage({ type: 'fileSuggestions', suggestions: [], index: data.index });
						break;
					}
					// Use findFiles - it's async so we need await.
					// We exclude node_modules and limit results to 50 for performance.
					const files = await vscode.workspace.findFiles(`**/*${data.query}*`, '**/node_modules/**', 50);
					const workspaceFolders = vscode.workspace.workspaceFolders;
					if (workspaceFolders) {
						const workspaceRoot = workspaceFolders[0].uri.fsPath;
						const suggestions = files.map(file => path.relative(workspaceRoot, file.path));
						this._view?.webview.postMessage({ type: 'fileSuggestions', suggestions: suggestions, index: data.index });
					}
					break;
				}
				case 'updateTextContext': {
					if (data.index >= 0 && data.index < currentContext.length) {
						const newContext = [...currentContext];
						newContext[data.index].context = data.context;
						await this._context.workspaceState.update('llmContext', newContext);
					}
					break;
				}
				case 'removeContext': {
					const mainIndex = this._context.workspaceState.get<number>('llmMainContextIndex', -1);
					const newContext = currentContext.filter((_, index) => index !== data.index);

					if (data.index === mainIndex) {
						await this._context.workspaceState.update('llmMainContextIndex', -1);
					} else if (data.index < mainIndex) {
						await this._context.workspaceState.update('llmMainContextIndex', mainIndex - 1);
					}

					await this._context.workspaceState.update('llmContext', newContext);
					this.updateView();
					break;
				}
				case 'clearContext': {
					await this._context.workspaceState.update('llmContext', []);
					await this._context.workspaceState.update('llmMainContextIndex', -1);
					this.updateView();
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
					await this._context.workspaceState.update('llmContextWebSearchEnabled', data.enabled);
				}
			}
		})
	}

	public updateView() {
		if (!this._view) return;
		const context = this._context.workspaceState.get('llmContext', []);
		const mainContextIndex = this._context.workspaceState.get('llmMainContextIndex', -1);
		this._view.webview.postMessage({ type: 'update', context, mainContextIndex });
		this._view.badge = {
			value: context.length,
			tooltip: `${context.length} context items`
		};
	}

	private async copyAllContextToClipboard() {
		const llmContext = this._context.workspaceState.get<any[]>('llmContext', []);
		const mainIndex = this._context.workspaceState.get<number>('llmMainContextIndex', -1);

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

		const formattedContext = await fetchContext({
			main_text: mainText,
			supplementary_text: supplementaryText,
			urls,
			filepaths,
			symbol_implementations: [],
			web_search_enabled: this._context.workspaceState.get<any>('llmContextWebSearchEnabled', false)
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
		const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'index.html');
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
