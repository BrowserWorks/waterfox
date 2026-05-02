import os
import re

def process_file(filepath):
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()

    original = content
    # Replace Mozilla telemetry endpoint
    content = content.replace("incoming.telemetry.mozilla.org", "telemetry.foxxite.workers.dev")
    # Replace Mozilla identity/sync endpoint
    content = content.replace("identity.mozilla.com", "sync.foxxite.workers.dev")

    if content != original:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Patched {filepath}")

for root, dirs, files in os.walk('.'):
    # Exclude version control and build dirs
    if any(exclude in root for exclude in ['.git', 'obj-', 'build/']):
        continue
    for file in files:
        if file.endswith(('.js', '.mjs', '.cpp', '.h', '.rs', '.kt', '.java')):
            process_file(os.path.join(root, file))

print("Patching complete.")
