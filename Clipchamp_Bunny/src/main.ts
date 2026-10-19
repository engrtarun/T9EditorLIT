import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { project } from './lib/stores/project.svelte';
import { layout } from './lib/stores/layout.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('#app mount point missing');

// Probe the real media (Rust `probe_cached` in the Tauri build).
void project.init();

// `?help=1` opens the shortcut sheet straight away — handy for a shareable link.
if (new URLSearchParams(location.search).has('help')) layout.helpOpen = true;

export default mount(App, { target });
