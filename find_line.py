code = open('frontend/script.js').read()
err_idx = 24123
line_num = code[:err_idx].count('\n') + 1
col_num = err_idx - code.rfind('\n', 0, err_idx)
print(f"Unclosed brace is around line {line_num}, col {col_num}")
