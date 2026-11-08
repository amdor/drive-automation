# Drive Batch Organizer

A Manifest V3 Chrome extension for scanning a user-selected directory and uploading image and video files to Google Drive in resumable batches. It does not watch directories or modify local files. Keep the Options page open while a batch is running; the persisted queue can be resumed after reopening it.

## Publisher setup

1. Open `chrome://extensions` and enable Developer mode.
2. Select **Load unpacked** and choose this `extension` directory.
3. Copy the generated extension ID.
4. In Google Cloud Console, enable the Google Drive API and create an OAuth client ID for a Chrome extension using that extension ID.
5. Set the OAuth client ID in the extension manifest as a one-time publisher configuration, then reload the extension before distributing it.

End users do not edit the manifest. They open the dashboard and select **Connect Drive** to sign in, then choose a directory, scan it, and start the upload.

The extension requests only the `https://www.googleapis.com/auth/drive.file` scope. It creates and manages its destination folder and uploads within that app-created Drive space. The restricted scope does not grant general access to arbitrary existing Drive folders.

## Queue and recovery

IndexedDB stores session metadata, directory and file handles, per-file metadata, sampled SHA-256 signatures, generated destination paths/names, state, and resumable upload URLs and byte offsets. Each file and confirmed chunk offset is persisted before continuing. On restart, any interrupted `processing` item returns to `pending`, and its saved upload URL is checked with Drive before more bytes are sent.

Images use EXIF capture timestamps when available. MP4-family videos use the movie header creation timestamp when available. Unsupported or absent embedded timestamps fall back to the file's last-modified time. The signature hashes file metadata plus samples from the beginning and end of the file; it is an identity hint, not a full-file integrity checksum.

## Browser requirements and notes

- Use a current Chrome version with File System Access API and Manifest V3 support.
- The Options page must remain open during an active transfer. Upload work is intentionally coordinated in this tab, not in a time-limited background service worker.
- The directory picker is non-destructive. It grants read access only and never moves, renames, or deletes local files.
- For Chrome Web Store release, configure the OAuth consent screen and verify the Drive scope according to Google's current review requirements.
