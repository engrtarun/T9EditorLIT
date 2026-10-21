import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { layout } from './lib/stores/layout.svelte';
import { cloud } from './lib/stores/cloud.svelte';
import { app } from './lib/stores/app.svelte';
import { isTauri } from './lib/ipc';

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
