import './style.css';

interface BuildInfo {
  environment: string;
  build: { shortSha: string };
  release: { version: string } | null;
}

// Placeholder: shows which build is deployed, so both URLs can be checked after a deploy.
async function showBuild(): Promise<void> {
  const footer = document.getElementById('build');
  if (!footer) return;
  try {
    const res = await fetch('/build-info.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const info = (await res.json()) as BuildInfo;
    const version = info.release ? `v${info.release.version} · ` : '';
    footer.textContent = `${version}${info.build.shortSha} · ${info.environment}`;
  } catch {
    // No build info in dev; nothing to show.
  }
}

void showBuild();
