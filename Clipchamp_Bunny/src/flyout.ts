/**
 * The media OSD flyout's entry point — the second page of the app.
 *
 * `index.html` → `main.ts` boots the whole editor; this one mounts exactly
 * one component on an empty shell. It deliberately imports no stores: the
 * flyout is a view of one `browser:media` snapshot, and every store pulled
 * in here would be state the window never uses (the zero-RAM rule applies
 * to webviews too — this page must stay a few hundred kilobytes).
 *
 * Rust decides when the window exists and when it shows or hides
 * (`src-tauri/src/media_flyout.rs`); nothing in here touches the window.
 */
import './app.css';
import { mount } from 'svelte';
import MediaFlyout from './lib/components/browser/MediaFlyout.svelte';

const target = document.getElementById('flyout-app');
if (!target) throw new Error('#flyout-app mount point missing');

mount(MediaFlyout, { target });
