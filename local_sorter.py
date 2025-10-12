from __future__ import print_function

import os.path
from datetime import datetime, timezone

import shutil


def main():
    """
    MODULE CONFIGS
    """
    folder_path = ""
    """
    MODULE CONFIGS END
    """
    if not os.path.isdir(folder_path):
        print("Folder does not exist:", folder_path)
        return

    moved = 0
    for root, _, files in os.walk(folder_path):
        for fname in files:
            local_path = os.path.join(root, fname)

            # determine month folder name (1-12)
            month = datetime.fromtimestamp(
                os.stat(local_path).st_birthtime, tz=timezone.utc).month
            month_name = str(month)

            target_dir = os.path.join(folder_path, month_name)
            os.makedirs(target_dir, exist_ok=True)

            created_time_date = datetime.fromtimestamp(
                os.stat(local_path).st_birthtime, tz=timezone.utc).isoformat().replace('+00:00', 'Z').split('T')[0]

            _base, ext = os.path.splitext(fname)
            dest_path = os.path.join(target_dir, f"{created_time_date}{ext}")
            i = 1
            while os.path.exists(dest_path):
                dest_path = os.path.join(
                    target_dir, f"{created_time_date}_{i}{ext}")
                i += 1

            shutil.move(local_path, dest_path)
            moved += 1

    print(f"Finished. Moved {moved} files.")


if __name__ == '__main__':
    main()
