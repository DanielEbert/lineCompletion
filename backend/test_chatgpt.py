from openai import OpenAI
client = OpenAI()

prompt = f'''\
You are a code completion assistant.
Given the following lines of code, what is the single next line?
Only return the code for the very next line and nothing else. Do not use markdown, backticks, or any other formatting.

Code:
```python
import os

# get path to folder where this file is in
```
'''

import time
start_time = time.time()

for _ in range(3):
    response = client.responses.create(
        model="chatgpt-4o-latest",
        input=prompt
    )
    dura = time.time() - start_time
    print(dura)

print(response.output_text)
