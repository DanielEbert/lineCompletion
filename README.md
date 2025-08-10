# LineCompletion

LLM-powered code completion for Python in VS Code, with context-aware suggestions and web search integration.

![Preview](./img/preview.png)

## Features

- Inline code completions for Python using LLMs (Google Gemini)
- Integrates with VS Code's inline suggestion system
- Context View: Add files, URLs, or text as context for better suggestions
- Symbol-aware completions: analyzes your code and related functions
- Optional web search integration for enhanced context
- FastAPI backend for LLM and search orchestration

## Installation

### 1. Backend Setup

Requirements:
- Python 3.9+
- [Google Gemini API key](https://ai.google.dev/)
- pip

Install dependencies and run the backend:

```bash
cd backend
python -m venv venv
. venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY=your-gemini-api-key
python main.py
```

The backend runs at `http://127.0.0.1:7524` by default.

### 2. VS Code Extension

- Open the project in VS Code.
- Press `F5` or go to 'Run and Debug' → 'Run Extension' (green play button) to launch a new VS Code window with the extension loaded.

## Usage

1. Open a Python file.
2. Trigger inline suggestions with `Ctrl+Space` or by running the `LineCompletion: Suggest From Context` command.
3. Use the "LLM Context" sidebar to add files, URLs, or text as additional context for completions.
4. Optionally enable web search in the context view for even richer suggestions.

## Development

- The extension code is in `src/`.
- The backend code is in `backend/`.
- Update the `GEMINI_API_KEY` environment variable as needed.

---

### TODO

- Remove duplicate code
- Improve context extraction (e.g., find usage in tests)
- Fix indentation when inserting text (detect current indentation level)
