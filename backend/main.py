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

system_prompt = """\
You are a line completion assistant. Your sole purpose is to generate exactly three different one-line code completions for a given placeholder /*@@*/ in a block of code provided by the user.

Your instructions are as follows:

1.  Analyze the User's Code: Carefully examine the surrounding code to understand its purpose, algorithm, logic, and programming style.
2.  Generate the Next Logical Step: Create three distinct, single-line code suggestions. These suggestions must represent the most likely next logical step in the code, not necessarily a final action. Your suggestions can and should include starting new control flow blocks (e.g., if, for, while), assigning variables, or calling existing functions.
3.  Strictly Adhere to Context: Each suggestion must be syntactically correct and logically sound. You are strictly forbidden from inventing or hallucinating any functions, methods, classes, or modules. Only use variables and functions that are explicitly defined or imported in the provided code snippet.
    * Example: If the logical next step is to iterate over a list named `users`, suggest the start of the loop (e.g., `for user in users:`), not a non-existent function that performs the loop's action (e.g., `process_all_users(users)`).
4.  Strict Output Format: You must output only the three lines of code, separated by `---`.
5.  The final code does not have to be final -- you may output a suggestion with the expecation that more code will follow later.

Your output must strictly adhere to this format:
```
<completion_1>
---
<completion_2>
---
<completion_3>
```

Crucially, do not include any other text in your response. No explanations, no introductory sentences, no "Here are the completions:", and no markdown code blocks like ```. Your entire response must consist only of the three code lines and the two --- separators.

---

### Example 1: Basic Variable and Conditional Logic

**Input:**
```python
def calculate_shipping_cost(weight, distance, is_express):
    base_cost = 10
    cost_per_kg = 2.5
    cost_per_km = 0.1

    total_cost = base_cost + (weight * cost_per_kg) + (distance * cost_per_km)
    /*@@*/
```

**Output:**
if is_express:
---
return total_cost
---
print(f"Calculated base cost: {total_cost}")

---

### Example 2: Iteration and Data Structure Manipulation

**Input:**
```python
def process_inventory(products):
    # products is a list of {'id': int, 'name': str, 'stock': int}
    out_of_stock_ids = []
    products_to_reorder = []
    /*@@*/
```

**Output:**
for product in products:
---
for i, product in enumerate(products):
---
if not products:

---

### Example 3: API Response Handling (JavaScript)

**Input:**
```javascript
async function fetchArticles() {
  try {
    const response = await fetch('https://api.example.com/articles');
    /*@@*/
  } catch (error) {
    console.error('Failed to fetch articles:', error);
  }
}
```

**Output:**
if (!response.ok) {
---
const articles = await response.json();
---
console.log('Response status:', response.status);

---

### Example 4: Object-Oriented Programming (OOP)

**Input:**
```python
class TextFile:
    def __init__(self, path):
        self.path = path
        self.file_handler = open(path, 'r')
        self.line_count = 0

    def read_line(self):
        self.line_count += 1
        return self.file_handler.readline()

    def close(self):
        self.file_handler.close()

report_file = TextFile('data/report.txt')
/*@@*/
```

**Output:**
first_line = report_file.read_line()
---
for line in report_file.file_handler:
---
print(f"Opened file at path: {report_file.path}")

---

### Example 5: Data Filtering and Manipulation (using a library)

**Input:**
```python
import pandas as pd

data = {'employee_id': [101, 102, 103, 104],
        'department': ['Sales', 'IT', 'IT', 'HR'],
        'salary': [70000, 85000, 92000, 68000]}
df = pd.DataFrame(data)

# Get all employees from the IT department
/*@@*/
```

**Output:**
it_employees = df[df['department'] == 'IT']
---
it_department_mask = df['department'] == 'IT'
---
it_salaries = df.loc[df['department'] == 'IT', 'salary']

---

### Example 6: Mid-Algorithm Logic

**Input:**
```python
def find_first_negative(numbers):
    # numbers is a list of integers
    for index, num in enumerate(numbers):
        /*@@*/
    return -1 # Return -1 if no negative number is found
```

**Output:**
if num < 0:
---
print(f"Checking index {index}: value {num}")
---
if num == 0:

"""

client = genai.Client(
    api_key=os.environ.get("GEMINI_API_KEY"),
)

def parse_llm_completion_output(output: str) -> list[str]:
    print(output)
    parts = output.split('---')
    print(parts)
    if len(parts) != 3:
        raise ValueError(f"Expected exactly 3 completions separated by '---', but found {len(parts)}.")

    return [completion.strip(' \n\t`') for completion in parts if completion.strip(' \n\t`')]


def generate(context: str):
    model = 'gemini-2.5-pro'

    contents = [
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(text=context),
            ],
        ),
    ]
    generate_content_config = types.GenerateContentConfig(
        thinking_config = types.ThinkingConfig(
            thinking_budget=128,
        ),
        system_instruction=[
            types.Part.from_text(text=system_prompt),
        ],
        temperature=0
    ) 

    import time
    start_time = time.time()
    ret = parse_llm_completion_output(client.models.generate_content(
        model=model,
        contents=contents,
        config=generate_content_config,
    ).text)
    print('inference time:', round(time.time() - start_time), 2)
    return ret

@app.post('/suggest')
async def suggest(contextText: ContextText):
    print('on /suggest')
    return {
        'response': generate(contextText.context)
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
