from __future__ import print_function
import io

import os.path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload

# If modifying these scopes, delete the file token.json.
SCOPES = ['https://www.googleapis.com/auth/drive']

service = None
creds = None
allFoldersFound = []
# use 'root' for id to search root folder
foldersToCheck = [{'id':'root', 'path': None}]
allFilesFound = []


def listFolders(target, nextPageToken=None, prevRequest=None):
    global service, allFoldersFound, foldersToCheck
    if nextPageToken != None and prevRequest != None:
        request = service.files().list_next(
            prevRequest, {"nextPageToken": nextPageToken})
    else:
        request = service.files().list(
            pageSize=10,
            fields="nextPageToken, files(id, name)",
            q=f"'{target['id']}' in parents and mimeType = 'application/vnd.google-apps.folder'",
        )
    results = request.execute()
    folders = results.get('files', [])

    if not folders:
        print('No folders found.')
        return
    print('Folders:')
    for folder in folders:
        print(u'{0} ({1})'.format(folder['name'], folder['id']))
        path = f"{os.curdir}{os.sep}downloads{os.sep}{folder['name']}" if target['path'] is None else f"{target['path']}{os.sep}{folder['name']}"
        if not os.path.exists(path):
            os.makedirs(path)
        allFoldersFound.append({'id':folder['id'], 'path': path})
        foldersToCheck.append({'id': folder['id'], 'path': path})

    nextPageToken = results.get('nextPageToken', None)
    if nextPageToken is not None:
        listFolders(target, nextPageToken, request)
        return


def listFiles(target, nextPageToken=None, prevRequest=None):
    global service, allFilesFound

    if nextPageToken != None and prevRequest != None:
        request = service.files().list_next(
            prevRequest, {"nextPageToken": nextPageToken})
    else:
        request = service.files().list(
            pageSize=20,
            fields="nextPageToken, files(id, name)",
            q=f"'{target['id']}' in parents and mimeType != 'application/vnd.google-apps.folder'",
        )
    results = request.execute()
    files = results.get('files', [])

    if not files:
        print('No files found.')
        return
    print('Files:')
    for file in files:
        print(u'{0} ({1})'.format(file['name'], file['id']))
        allFilesFound.append(
            {"id": file['id'], "name": f"{target['path']}{os.sep}{file['name']}"})

    nextPageToken = results.get('nextPageToken', None)
    if nextPageToken is not None:
        listFiles(target, nextPageToken, request)
        return

def getOldestRevision(file, nextPageToken=None, prevRequest=None):
    global service
    if os.path.exists(file['name']):
            print(f"File {file['name']} already exists")
            return
    
    if nextPageToken != None and prevRequest != None:
        request = service.revisions().list_next(
            prevRequest, {"nextPageToken": nextPageToken})
    else:
        request = service.revisions().list(
            pageSize=10,
            fileId=file['id']
        )
    results = request.execute()
    revisions: list = results.get('revisions', [])

    if not revisions:
        print('No revisions found?')
        return
    print(f"Revisions for file {file['name']}:")
    for rev in revisions:
        print(f"{rev['modifiedTime']}")

    nextPageToken = results.get('nextPageToken', None)
    if nextPageToken is not None:
        getOldestRevision(file, nextPageToken, request)
        return
 
    oldestRevisionId = revisions.pop()['id']
    downloadFile(file, oldestRevisionId)


def downloadFile(file, revisionId):
    global service
    # serviceV2 = build('drive', 'v2', credentials=creds)
    # request = service.files().get_media(fileId=file['id'])
    request = service.revisions().get_media(fileId=file['id'], revisionId=revisionId)
    # res = request.execute()
    # request.uri = res.get('downloadUrl')
    fh = io.BytesIO()
    downloader = MediaIoBaseDownload(fh, request)

    done = False
    while done is False:
        status, done = downloader.next_chunk()
        if status:
            print("Download %d%%." % int(status.progress() * 100))
    with io.open(file['name'], "wb") as f:
        fh.seek(0)
        f.write(fh.read())


def main():
    global creds
    """Shows basic usage of the Drive v3 API.
    Prints the names and ids of the first 10 files the user has access to.
    """
    creds = None
    # The file token.json stores the user's access and refresh tokens, and is
    # created automatically when the authorization flow completes for the first
    # time.
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    # If there are no (valid) credentials available, let the user log in.
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(
                'credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        # Save the credentials for the next run
        with open('token.json', 'w') as token:
            token.write(creds.to_json())

    try:
        global service, allFilesFound, allFoldersFound
        service = build('drive', 'v3', credentials=creds)
        allFoldersFound = [{'id': foldersToCheck[0]['id'], 'path': f"{os.curdir}{os.sep}downloads"}]
        # while len(foldersToCheck) > 0:
        #     listFolders(foldersToCheck.pop())
        for folder in allFoldersFound:
            listFiles(folder)
        for file in allFilesFound:
            getOldestRevision(file)    

        # await listFiles(authClient, foldersToCheck.shift())
    except HttpError as error:
        # TODO(developer) - Handle errors from drive API.
        print(f'An error occurred: {error}')
        pass


if __name__ == '__main__':
    main()
