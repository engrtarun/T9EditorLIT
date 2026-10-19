<script lang="ts">
  import type { MenuIcon } from '../types';

  let { name, size = 16 }: { name: MenuIcon; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  aria-hidden="true"
>
  {#if name === 'rename'}
    <path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4 16.5z" /><path d="M14 7l3 3" />
  {:else if name === 'folder'}
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  {:else if name === 'plus'}
    <path d="M12 5v14M5 12h14" />
  {:else if name === 'trash'}
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  {:else if name === 'copy'}
    <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />
  {:else if name === 'cloud'}
    <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 9.6 4 4 0 0 0 7 17.9" />
  {:else if name === 'telegram'}
    <path d="M21 5L3 11.5l5 1.7L19 8l-8 7.2.4 4.3 2.4-3.2 4.2 3.1z" />
  {:else if name === 'spark'}
    <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
  {:else if name === 'bolt'}
    <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
  {:else if name === 'disk'}
    <ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
  {:else if name === 'qr'}
    <rect x="3" y="3" width="7" height="7" rx="1" /><rect
      x="14"
      y="3"
      width="7"
      height="7"
      rx="1"
    />
    <rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM18 18h3v3h-3z" />
  {:else if name === 'key'}
    <circle cx="8" cy="14" r="4" /><path d="M11 11l8-8 2 2-2 2 2 2-3 3-2-2-2 2" />
  {/if}
</svg>
