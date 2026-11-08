from __future__ import print_function

import mimetypes
import os.path
from datetime import datetime, timezone

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import Resource, build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

from authed_service import getService
from file_sorter import createFolderIfNotExists

service: Resource = None

# folder_path = input("Local folder path to upload: ").strip()
# drive_folder_id = input("Destination Drive folder ID: ").strip()
"""
MODULE CONFIGS
"""
folder_path = ""
drive_folder_id = ''
"""
MODULE CONFIGS END
"""


def uploadFiles(folder_path, parent_folder_id):
    global service

    if not os.path.isdir(folder_path):
        print("Folder does not exist:", folder_path)
        return

    uploaded = 0
    for root, folders, files in os.walk(folder_path):
        if not root == folder_path:
            # gathering files/folders from subfolders happens in recursion. not optimal, idc
            continue

        folders.sort()

        for folder in folders:
            local_path = os.path.join(root, folder)
            next_parent = createFolderIfNotExists(
                folder, parent_folder_id)
            uploadFiles(local_path, next_parent)
            continue

        files.sort()
        for fname in files:
            local_path = os.path.join(root, fname)

            mime, _ = mimetypes.guess_type(local_path)
            if mime is None:
                mime = 'application/octet-stream'
            media = MediaFileUpload(local_path, mimetype=mime, resumable=True)

            created_time = datetime.fromtimestamp(
                os.stat(local_path).st_birthtime, tz=timezone.utc).isoformat().replace('+00:00', 'Z')

            body = {'name': fname, 'parents': [
                parent_folder_id], 'createdTime': created_time}
            try:
                file = service.files().create(body=body, media_body=media,
                                              fields='id, name').execute()

                print(f"Uploaded {local_path} -> {file.get('id')}")
                uploaded += 1
            except HttpError as e:
                print(f"Failed to upload {local_path}: {e}")
    print(f"Finished. Uploaded {uploaded} files from {folder_path}.")


def main():
    global service
    service = getService()
    uploadFiles(folder_path, drive_folder_id)


if __name__ == '__main__':
    main()
