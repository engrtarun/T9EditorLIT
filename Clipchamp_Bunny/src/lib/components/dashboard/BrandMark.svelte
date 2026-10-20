<script lang="ts">
  /**
   * The T9 monogram.
   *
   * The brand board (`T9 Editor LIT Branding Board.png`) shows a sculpted
   * "T9" whose bowl carries a play button. This is the flat, vector version
   * of that mark: it scales to any size without a second asset, and it costs
   * nothing to draw.
   */
  let { size = 30 }: { size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 48 48"
  fill="none"
  role="img"
  aria-label="T9 Editor LIT"
>
  <defs>
    <linearGradient id="t9-brand-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#C6DBFF" />
      <stop offset="0.45" stop-color="#4D8DFF" />
      <stop offset="1" stop-color="#1E45A0" />
    </linearGradient>
  </defs>

  <!-- T -->
  <path d="M1 4h21v7.4h-6.6V44h-7.8V11.4H1z" fill="url(#t9-brand-grad)" />

  <!-- 9: the bowl is a ring, the tail drops out of it -->
  <circle cx="32.5" cy="17.5" r="8.6" stroke="url(#t9-brand-grad)" stroke-width="5.8" />
  <path d="M29.6 26.4h5.8V44h-5.8z" fill="url(#t9-brand-grad)" />

  <!-- the play button inside the bowl -->
  <path d="M30.3 12.9 36.6 17.5l-6.3 4.6z" fill="#0b1020" />
</svg>
