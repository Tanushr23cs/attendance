code = open('frontend/script.js').read()
stack = []
for i, c in enumerate(code):
    if c == '{':
        stack.append(i)
    elif c == '}':
        if not stack:
            print(f"Extra closing brace at {i}")
        else:
            stack.pop()

if stack:
    print(f"Unclosed braces at {stack}")
else:
    print("Braces matched")
