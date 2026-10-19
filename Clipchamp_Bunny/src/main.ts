import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { project } from './lib/stores/project.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('#app mount point missing');

// Probe the real media (Rust `probe_cached` in the Tauri build).
void project.init();

export default mount(App, { target });
