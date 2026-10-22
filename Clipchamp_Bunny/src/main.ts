import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { layout } from './lib/stores/layout.svelte';
import { cloud } from './lib/stores/cloud.svelte';
import { app } from './lib/stores/app.svelte';
import { mode } from './lib/stores/mode.svelte';
import { project } from './lib/stores/project.svelte';
import { isTauri, logAppEvent, takePendingOpens, onOpenFiles } from './lib/ipc';

const target = document.getElementById('app');
if (!target) throw new Error('#app mount point missing');

// The project is **not** opened here any more.
//
// The app lands on the dashboard, and the dashboard is the one screen that
// must appear instantly. Probing a video, building its waveform and pulling
// its transcript out of SQLite is real work — it happens when the user
// actually asks for that project, not while the home screen is still fading
// in. The dashboard shows the same project list from one SQLite query.

// The provider dots come from the daemon's real health report, not from a
// fake "connect" button.
void cloud.sync();

// The version the user sees has to be the version that is actually running,
// so read it from the binary instead of writing it into the source.
if (isTauri()) {
  void import('@tauri-apps/api/app')
    .then((api) => api.getVersion())
    .then((v) => {
      app.version = v;
    })
    .catch(() => {
      /* the fallback in the store stays */
    });
}

// `?help=1` opens the shortcut sheet straight away — handy for a shareable link.
if (new URLSearchParams(location.search).has('help')) layout.helpOpen = true;

export default mount(App, { target });

/**
 * "Edit with T9 Editor LIT" — the Explorer right-click verb.
 *
 * Two ways a file can arrive:
 *   • this process was **started** with a video path (the verb launched the
 *     exe) — drained once via `takePendingOpens`;
 *   • the app was **already running** and a second launch handed the path
 *     over — the `open-files` event from the single-instance plugin.
 *
 * Either way the editor opens straight on the video, and the heavy lifting
 * stays where it already was: ffprobe metadata comes back as a few hundred
 * bytes, and the waveform / filmstrip / transcript are streamed in by child
 * processes while the UI is already usable. Nothing of the file itself ever
 * enters the webview heap — the `<video>` element streams it from disk.
 */
if (isTauri()) {
  const openPaths = async (paths: string[]) => {
    const path = paths.find((p) =>
      /\.(mp4|mkv|mov|avi|webm|m4v|wmv|mpg|mpeg|m2ts|mts|flv|3gp|ts)$/i.test(p)
    );
    if (!path) return;
    app.openEditor();
    mode.set('cut');
    try {
      await project.loadFromBackend(path);
    } catch (e) {
      logAppEvent('error', 'openwith', `open failed: ${String(e)}`);
    }
  };

  void takePendingOpens().then(openPaths);
  void onOpenFiles(openPaths);
}
