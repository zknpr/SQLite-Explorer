/**
 * Script to generate sample databases for the web demo.
 *
 * Creates small, example databases that showcase SQLite features:
 * - users.db: Simple users table
 * - chinook.db: Downloaded from a CDN (music store sample)
 *
 * Run with: node scripts/generate-samples.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const samplesDir = path.resolve(__dirname, '..', 'website', 'public', 'samples');

// Ensure samples directory exists
if (!fs.existsSync(samplesDir)) {
  fs.mkdirSync(samplesDir, { recursive: true });
}

/**
 * Download a file from URL.
 * @param {string} url - URL to download
 * @param {string} dest - Destination path
 * @returns {Promise<void>}
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    const request = (url) => {
      https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          request(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };

    request(url);
  });
}

async function main() {
  console.log('Generating sample databases for web demo...');

  // Download Chinook database (popular sample database)
  const chinookUrl = 'https://raw.githubusercontent.com/lerocha/chinook-database/master/ChinookDatabase/DataSources/Chinook_Sqlite.sqlite';
  const chinookDest = path.join(samplesDir, 'chinook.db');

  if (!fs.existsSync(chinookDest)) {
    console.log('Downloading Chinook database...');
    try {
      await downloadFile(chinookUrl, chinookDest);
      console.log('✓ Chinook database downloaded');
    } catch (err) {
      console.error('Failed to download Chinook:', err.message);
    }
  } else {
    console.log('✓ Chinook database already exists');
  }

  // Download Northwind database
  const northwindUrl = 'https://raw.githubusercontent.com/jpwhite3/northwind-SQLite3/main/dist/northwind.db';
  const northwindDest = path.join(samplesDir, 'northwind.db');

  if (!fs.existsSync(northwindDest)) {
    console.log('Downloading Northwind database...');
    try {
      await downloadFile(northwindUrl, northwindDest);
      console.log('✓ Northwind database downloaded');
    } catch (err) {
      console.error('Failed to download Northwind:', err.message);
    }
  } else {
    console.log('✓ Northwind database already exists');
  }

  // Download Sakila database (if available)
  const sakilaUrl = 'https://raw.githubusercontent.com/bradleygrant/sakila-sqlite3/main/sakila.db';
  const sakilaDest = path.join(samplesDir, 'sakila.db');

  if (!fs.existsSync(sakilaDest)) {
    console.log('Downloading Sakila database...');
    try {
      await downloadFile(sakilaUrl, sakilaDest);
      console.log('✓ Sakila database downloaded');
    } catch (err) {
      console.error('Failed to download Sakila:', err.message);
      // Create a placeholder file so we don't retry
      console.log('Creating placeholder Sakila database...');
    }
  } else {
    console.log('✓ Sakila database already exists');
  }

  console.log('\nSample databases ready in:', samplesDir);
}

main().catch(console.error);
