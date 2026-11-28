/**
 * Desktop app downloads: every package of the latest release with its size
 * and SHA-256, and the first-launch steps a direct download skips (they are
 * on the GitHub release page, which these links bypass).
 */

import type { Metadata } from 'next';
import CopyCommand from '@/components/CopyCommand';
import DownloadButton from '@/components/DownloadButton';
import PlatformRows from '@/components/PlatformRows';
import Footer from '@/components/Footer';
import SiteHeader from '@/components/SiteHeader';
import {
  APP_INSTALL_NOTES_URL,
  APP_RELEASES_URL,
  APP_REPO,
  APP_REPO_URL,
  APP_SIGNING_POLICY_URL,
  DESKTOP_PLATFORMS,
  PACKAGE_INFO,
  fetchDesktopRelease,
  formatMegabytes,
  linuxInstallCommand,
  windowsChecksumCommand
} from '@/lib/desktop-release';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Desktop app',
  description:
    'Download SQLite Explorer for macOS (Apple Silicon), Windows and Linux: a desktop SQLite browser and editor built on the SQLite Explorer viewer.'
};

const sectionHeading = 'text-2xl font-bold tracking-[-0.025em] sm:text-3xl';
const link = 'font-semibold text-accent underline-offset-2 hover:underline';

export default async function DownloadPage() {
  const release = await fetchDesktopRelease();

  return (
    <>
      <SiteHeader />
      <main className="px-5 sm:px-6">
        <section className="mx-auto grid max-w-6xl items-center gap-12 pb-16 pt-12 md:pt-20 lg:grid-cols-2">
          <div>
            <h1 className="text-[2.75rem] font-bold leading-[1.05] tracking-[-0.035em] sm:text-6xl">
              SQLite Explorer
              <br />
              <span className="text-accent">for your desktop</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-subtle-foreground">
              A SQLite browser and editor for macOS, Windows and Linux, built on the viewer from the
              VS&nbsp;Code extension. It needs no VS&nbsp;Code and no account, and it is open source under the
              MIT license.
            </p>
            <div className="mt-8">
              <DownloadButton release={release} variant="primary" fallbackHref={release ? '#packages' : APP_RELEASES_URL} />
            </div>
          </div>
          {release && (
            <div className="rounded-2xl border border-edge bg-subtle p-3 sm:p-4">
              <PlatformRows release={release} />
            </div>
          )}
        </section>

        <section aria-labelledby="packages" className="mx-auto max-w-6xl border-t border-edge py-14">
          <h2 id="packages" className={`scroll-mt-24 ${sectionHeading}`}>
            {release ? `Version ${release.version}` : 'Packages'}
          </h2>
          {release ? (
            <>
              <div className="relative mt-6 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[0.9375rem]">
                  <thead className="border-b-2 border-foreground">
                    <tr>
                      <th scope="col" className="py-2 pr-4 font-bold">System</th>
                      <th scope="col" className="py-2 pr-4 font-bold">Size</th>
                      <th scope="col" className="py-2 pr-4 font-bold">SHA-256</th>
                      <th scope="col" className="py-2 font-bold"><span className="sr-only">Download</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {DESKTOP_PLATFORMS.map(platform => {
                      const asset = release.assets[platform];
                      const info = PACKAGE_INFO[platform];
                      return (
                        <tr key={platform}>
                          <th scope="row" className="py-4 pr-4 align-top font-semibold">
                            {info.os}
                            <span className="block font-normal text-subtle-foreground">{info.build}</span>
                          </th>
                          <td className="py-4 pr-4 align-top">{formatMegabytes(asset.bytes)}</td>
                          <td className="py-4 pr-4 align-top">
                            <code className="block max-w-[34ch] break-all text-[0.8rem] leading-snug text-subtle-foreground">
                              {asset.sha256}
                            </code>
                          </td>
                          <td className="py-4 text-right align-top">
                            <a href={asset.url} className={link}>
                              Download<span className="sr-only"> for {info.os}</span>
                            </a>
                            <span className="mt-1 block text-xs text-subtle-foreground">{asset.name}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-6 text-[0.9375rem] text-subtle-foreground">
                <a href={release.releaseUrl} className={link}>Release notes</a> list what changed. Older
                versions are on the <a href={`${APP_REPO_URL}/releases`} className={link}>releases page</a>.
              </p>
            </>
          ) : (
            <p className="mt-6 max-w-[60ch]">
              The packages are on the <a href={APP_RELEASES_URL} className={link}>GitHub releases page</a>.
            </p>
          )}
        </section>

        <section aria-labelledby="first-launch" className="mx-auto max-w-6xl border-t border-edge py-14">
          <h2 id="first-launch" className={sectionHeading}>Before you install</h2>
          <p className="mt-4 max-w-[64ch] text-subtle-foreground">
            The packages are not signed with a publisher identity yet, so macOS and Windows warn about
            them. The <a href={APP_SIGNING_POLICY_URL} className={link}>code signing policy</a> explains
            where that stands.
          </p>
          <div className="mt-10 grid grid-cols-1 gap-12 lg:grid-cols-3">
            <div id="macos" className="scroll-mt-24">
              <h3 className="text-xl font-bold">macOS</h3>
              <p className="mt-1 text-sm text-subtle-foreground">Apple Silicon only. There is no Intel build.</p>
              <ol className="mt-4 list-decimal space-y-2 pl-5">
                <li>Open the disk image and drag SQLite Explorer to Applications.</li>
                <li>Open the app. macOS blocks the first launch because the app is not notarized.</li>
                <li>
                  In <strong>System Settings</strong>, open <strong>Privacy &amp; Security</strong> and choose{' '}
                  <strong>Open Anyway</strong> for SQLite Explorer.
                </li>
              </ol>
              <p className="mt-4 text-[0.9375rem] text-subtle-foreground">
                Keep the app in Applications so it can update itself. To remove it, move it to the Trash.
              </p>
            </div>

            <div id="windows" className="scroll-mt-24">
              <h3 className="text-xl font-bold">Windows</h3>
              <p className="mt-1 text-sm text-subtle-foreground">x86-64 installer.</p>
              <ol className="mt-4 list-decimal space-y-2 pl-5">
                <li>Run the setup program.</li>
                <li>
                  SmartScreen says &quot;Windows protected your PC&quot;. Choose <strong>More info</strong>, then{' '}
                  <strong>Run anyway</strong>.
                </li>
              </ol>
              <p className="mt-4 text-[0.9375rem] text-subtle-foreground">
                With <strong>Smart App Control</strong> on, Windows blocks unsigned programs and offers no
                way past it, so this installer cannot run there. To remove the app, use Settings, Apps,
                Installed apps.
              </p>
            </div>

            <div id="linux" className="scroll-mt-24">
              <h3 className="text-xl font-bold">Linux</h3>
              <p className="mt-1 text-sm text-subtle-foreground">
                x86-64 Debian package. It needs glibc 2.39 or newer: Ubuntu 24.04, Debian 13 or later.
              </p>
              <p className="mt-4">Install it from the folder you downloaded it to:</p>
              <CopyCommand command={linuxInstallCommand(release)} className="mt-2" />
              <p className="mt-4 text-[0.9375rem] text-subtle-foreground">
                Remove it with <code>sudo apt remove sqlite-explorer</code>. AppImage packages are not provided.
              </p>
            </div>
          </div>
        </section>

        <section aria-labelledby="verify" className="mx-auto max-w-6xl border-t border-edge py-14">
          <h2 id="verify" className={sectionHeading}>Check the download</h2>
          <p className="mt-4 max-w-[64ch] text-subtle-foreground">
            Download <code>SHA256SUMS</code>
            {release && (
              <>
                {' '}(<a href={release.checksumsUrl} className={link}>this release&apos;s copy</a>)
              </>
            )}{' '}
            into the same folder as the package, then run the command for your system. It prints OK
            for a file that matches.
          </p>
          <div className="mt-6 grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-4">
            <div>
              <p className="mb-2 text-[0.9375rem] font-semibold">macOS</p>
              <CopyCommand command="shasum -a 256 --check --ignore-missing SHA256SUMS" />
            </div>
            <div>
              <p className="mb-2 text-[0.9375rem] font-semibold">Linux</p>
              <CopyCommand command="sha256sum --check --ignore-missing SHA256SUMS" />
            </div>
            <div>
              <p className="mb-2 text-[0.9375rem] font-semibold">Windows (PowerShell, prints True for a match)</p>
              <CopyCommand
                command={windowsChecksumCommand(release)}
              />
            </div>
            <div>
              <p className="mb-2 text-[0.9375rem] font-semibold">
                Any system with the GitHub CLI, to confirm the release workflow built the file
              </p>
              <CopyCommand command={`gh attestation verify <downloaded file> --repo ${APP_REPO}`} />
            </div>
          </div>
        </section>

        <section aria-labelledby="updates" className="mx-auto max-w-6xl border-t border-edge py-14">
          <h2 id="updates" className={sectionHeading}>Updates</h2>
          <div className="mt-4 max-w-[64ch] space-y-4 text-subtle-foreground">
            <p>
              At first launch the app asks whether to check for updates when it starts, at most once a
              day. <strong>Check for Updates…</strong> in the app menu checks at any time. The app asks
              before it installs an update, and installs only a package signed with the project&apos;s
              update key.
            </p>
            <p>
              A check is one request to github.com. GitHub sees your IP address. Nothing about your files
              or settings is sent. The <a href={APP_INSTALL_NOTES_URL} className={link}>install notes</a>{' '}
              cover the details for each system.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
