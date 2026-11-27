/**
 * The social preview image, rendered at build time. The previous metadata
 * pointed at /og-image.png, which was never in public/, so shared links had
 * no image.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';

export const alt = 'SQLite Explorer: a SQLite viewer and editor for VS Code, the desktop and the browser';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage() {
  const icon = await readFile(path.join(process.cwd(), 'public/icon.png'));
  const iconSrc = `data:image/png;base64,${icon.toString('base64')}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background: '#0f2a3f',
          color: '#e8f0f6'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <img src={iconSrc} width={96} height={96} alt="" />
          <div style={{ fontSize: 44, fontWeight: 700 }}>SQLite Explorer</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 84, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.03em' }}>
            Look inside any SQLite file.
          </div>
          <div style={{ marginTop: 28, fontSize: 34, color: '#a8bdcd' }}>
            In VS Code, as a desktop app, or in your browser.
          </div>
        </div>
      </div>
    ),
    size
  );
}
