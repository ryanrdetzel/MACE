# tools/atomic_write.py
import json
import fcntl
import os
import tempfile


def atomic_update_index(new_entry, index_path="debates/index.json"):
    # Ensure file exists
    if not os.path.exists(index_path):
        with open(index_path, "w") as f:
            json.dump({"debates": []}, f)

    with open(index_path, "r+") as f:
        # Acquire exclusive lock
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            data = json.load(f)
            data["debates"].append(new_entry)

            # Write to a temporary file first
            fd, temp_path = tempfile.mkstemp(dir=os.path.dirname(index_path))
            with os.fdopen(fd, "w") as temp_file:
                json.dump(data, temp_file, indent=2)

            # Atomic replace
            os.replace(temp_path, index_path)
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
