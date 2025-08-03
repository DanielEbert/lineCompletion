import requests
import json

prompt = '''\
<|fim_prefix|>def quicksort(arr):
    if len(arr) <= 1:
        return arr
    pivot = arr[len(arr) // 2]
    <|fim_suffix|>
    middle = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quicksort(left) + middle + quicksort(right)<|fim_middle|>
'''

url = 'http://localhost:11434/api/generate'
payload = {
    'model': 'hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:UD-Q4_K_XL',
    'prompt': prompt,
}

response = requests.post(url, data=json.dumps(payload))
print(response.text)
