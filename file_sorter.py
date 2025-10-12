from __future__ import print_function


from googleapiclient.discovery import Resource
from googleapiclient.errors import HttpError
from datetime import datetime, timezone

from authed_service import getService


service: Resource = None
"""
MODULE CONFIGS
"""
# use 'root' for id to search root folder, otherwise navigate to the folder in your browser and copy the id from the url's end
foldersToCheck = [{'id': ''}]
# {types: "months"; targetFolderId: "the folder to make modifications in (create subfolders and move files to)"}
sortConfig = {"type": 'months',
              "targetFolderId": ""}
"""
MODULE CONFIGS END
"""

allFilesFound = []


def listFiles(target, nextPageToken=None, prevRequest=None):
    global service, allFilesFound

    if nextPageToken != None and prevRequest != None:
        request = service.files().list_next(
            prevRequest, {"nextPageToken": nextPageToken})
    else:
        request = service.files().list(
            pageSize=20,
            fields="nextPageToken, files",
            q=f"'{target['id']}' in parents and mimeType != 'application/vnd.google-apps.folder'",
        )
    results = request.execute()
    files = results.get('files', [])

    if not files:
        print('No files found.')
        return
    print('Files:')
    for file in files:
        print(u'{0} ({1}), Created at: {2}'.format(
            file['name'], file['id'], file['createdTime']))
        created_str = file['createdTime']
        try:
            created_dt = datetime.fromisoformat(
                created_str.replace('Z', '+00:00'))
        except ValueError:
            try:
                created_dt = datetime.strptime(
                    created_str, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
            except ValueError:
                created_dt = datetime.strptime(
                    created_str, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)

        created_month = created_dt.month  # integer 1-12

        allFilesFound.append({
            "id": file['id'],
            "name": file['name'],
            "created_month": created_month
        })

    nextPageToken = results.get('nextPageToken', None)
    if nextPageToken is not None:
        listFiles(target, nextPageToken, request)
        return


def createFolderIfNotExists(folderName, parentFolderId):
    global service
    if service is None:
        service = getService()
    # Check if folder already exists in parant, where parent is identified by parentFolderId
    query = f"mimeType='application/vnd.google-apps.folder' and name='{folderName}' and '{parentFolderId}' in parents and trashed=false"
    response = service.files().list(q=query, fields="files(id, name)").execute()
    folders = response.get('files', [])

    if folders:
        print(
            f"Folder '{folderName}' already exists with ID: {folders[0]['id']}")
        return folders[0]['id']
    else:
        file_metadata = {
            'name': folderName,
            'mimeType': 'application/vnd.google-apps.folder',
            'parents': [parentFolderId]
        }
        folder = service.files().create(body=file_metadata, fields='id').execute()
        print(f"Folder '{folderName}' created with ID: {folder.get('id')}")
        return folder.get('id')


def main():
    try:
        global service, allFilesFound
        service = getService()
        for folder in foldersToCheck:
            listFiles(folder)

        foldersToSortTo = {}

        for file in allFilesFound:
            if sortConfig['type'] == 'months':
                month = file['created_month']
                if month not in foldersToSortTo:
                    monthFolderId = createFolderIfNotExists(
                        str(month), sortConfig['targetFolderId'])
                    foldersToSortTo[month] = monthFolderId

                # move file to the month folder
                print(
                    f"Moving file {file['name']} to folder {month}, folder id: {foldersToSortTo[month]}")
                file = service.files().update(
                    fileId=file['id'],
                    addParents=foldersToSortTo[month],
                    removeParents=",".join([f['id'] for f in foldersToCheck]),
                    fields='id, parents'
                ).execute()
                print(f"File moved, new id: {file.get('id')}")
    except HttpError as error:
        # TODO(developer) - Handle errors from drive API.
        print(f'An error occurred: {error}')
        pass


if __name__ == '__main__':
    main()
