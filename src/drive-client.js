const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class DriveClient {
  constructor() {
    // Reuses your existing Google Sheets auth setup
    const credsKey = process.env.GOOGLE_CREDENTIALS_JSON; 
    if (!credsKey) throw new Error("Missing GOOGLE_CREDENTIALS_JSON secret.");
    
    const credentials = JSON.parse(credsKey);
    this.auth = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      ['https://www.googleapis.com/auth/drive']
    );
    this.drive = google.drive({ version: 'v3', auth: this.auth });
    this.folderName = "Tola Edge Brief";
  }

  // Locates the specific folder ID or creates it if it doesn't exist
  async getOrCreateFolder() {
    const res = await this.drive.files.list({
      q: `name='${this.folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    });
    
    if (res.data.files.length > 0) return res.data.files[0].id;

    console.log(`[Drive] Creating dedicated folder: "${this.folderName}"`);
    const folder = await this.drive.files.create({
      resource: { name: this.folderName, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    });
    return folder.data.id;
  }

  // Saves the date-stamped file directly to the folder[cite: 2]
  async saveBrief(dateStr, briefData) {
    const folderId = await this.getOrCreateFolder();
    const fileName = `TEB_${dateStr}.json`; // JSON for structure, easily readable by engine[cite: 2]

    await this.drive.files.create({
      resource: {
        name: fileName,
        parents: [folderId],
        mimeType: 'application/json'
      },
      media: {
        mimeType: 'application/json',
        body: JSON.stringify(briefData, null, 2),
      },
    });
    console.log(`[Drive] Successfully archived ${fileName} to Knowledge Vault[cite: 2]`);
  }

  // Downloads the last N briefs to pass down as memory context[cite: 2]
  async getRecentBriefsContext(limit = 3) {
    try {
      const folderId = await this.getOrCreateFolder();
      const res = await this.drive.files.list({
        q: `'${folderId}' in parents and name entryWith 'TEB_' and trashed=false`,
        orderBy: 'name desc',
        pageSize: limit,
        fields: 'files(id, name)',
      });

      const historicalContext = [];
      for (const file of res.data.files || []) {
        const content = await this.drive.files.get({ fileId: file.id, alt: 'media' });
        historicalContext.push(content.data);
      }
      return historicalContext;
    } catch (e) {
      console.warn('[Drive] Failed to pull memory context, running clean brief:', e.message);
      return [];
    }
  }
}

module.exports = DriveClient;
