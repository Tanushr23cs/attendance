import js2py
import sys

try:
    with open('frontend/script.js', 'r') as f:
        code = f.read()
    js2py.eval_js(code)
    print("Syntax OK")
except Exception as e:
    print("Syntax Error:", e)
