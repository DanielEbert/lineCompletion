import os
from google import genai
from google.genai import types
from fastapi import FastAPI
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
import uvicorn


class ContextText(BaseModel):
    context: str

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# TODO: fix language
# TODO: if suggestion returns import, add to prompt and propmt again with max 3 iterations
def get_prompt(code_lines: str):
    return f"""
You are a code completion assistant.
Given the following lines of code, what is the single next line?
Only return the code for the very next line and nothing else. Do not use markdown, backticks, or any other formatting.

Code:
```python
{code_lines}
```
"""

client = genai.Client(
    api_key=os.environ.get("GEMINI_API_KEY"),
)

def generate(context: str):
    model = "gemini-2.5-flash"

    contents = [
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(text=get_prompt(context)),
            ],
        ),
    ]
    generate_content_config = types.GenerateContentConfig()

    import time
    print('start generating', time.time())
    ret = [client.models.generate_content(
        model=model,
        contents=contents,
        config=generate_content_config,
    ).text]
    print('end generating', time.time())
    return ret

@app.post('/suggest')
async def suggest(contextText: ContextText):
    return {
        'suggestions': generate(contextText.context)
    }

def main():
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=7524,
        workers=1,
        reload=False
    )

if __name__ == '__main__':
    main()
