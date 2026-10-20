<script lang="ts">
  /**
   * The world clock.
   *
   * The status bar shows Delhi's time; clicking it opens this panel, where
   * every city shows its own wall clock and can be **pushed to the machine**.
   *
   * Setting the system clock is a privileged operation on Windows, so this
   * can fail — and when it does, the real reason is shown instead of a
   * pretend success.
   */
  import { setSystemClock } from '../ipc';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  interface City {
    label: string;
    zone: string;
    /** The Windows time-zone id, used when the clock is pushed to the OS. */
    win: string;
  }

  const CITIES: City[] = [
    { label: 'Delhi', zone: 'Asia/Kolkata', win: 'India Standard Time' },
    { label: 'London', zone: 'Europe/London', win: 'GMT Standard Time' },
    { label: 'New York', zone: 'America/New_York', win: 'Eastern Standard Time' },
    { label: 'Los Angeles', zone: 'America/Los_Angeles', win: 'Pacific Standard Time' },
    { label: 'Singapore', zone: 'Asia/Singapore', win: 'Singapore Standard Time' },
    { label: 'Tokyo', zone: 'Asia/Tokyo', win: 'Tokyo Standard Time' },
    { label: 'Sydney', zone: 'Australia/Sydney', win: 'AUS Eastern Standard Time' }
  ];

  /** Ticks once a second so the clocks move while the panel is open. */
  let now = $state(new Date());
  let busy = $state<string | null>(null);
  let message = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);

  $effect(() => {
    if (!open) return;
    now = new Date();
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });

  /** The wall-clock parts of `at` in `zone`. */
  function partsIn(zone: string, at: Date) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const out: Record<string, string> = {};
    for (const part of fmt.formatToParts(at)) {
      if (part.type !== 'literal') out[part.type] = part.value;
    }
    return {
      year: Number(out.year),
      month: Number(out.month),
      day: Number(out.day),
      // Some engines hand back 24 for midnight in 12-hour-off mode.
      hour: Number(out.hour) % 24,
      minute: Number(out.minute),
      second: Number(out.second)
    };
  }

  /** How far `zone` is ahead of UTC, in milliseconds, at `at`. */
  function offsetMs(zone: string, at: Date): number {
    const p = partsIn(zone, at);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(at.getTime() / 1000) * 1000;
  }

  function clockIn(zone: string, at: Date): string {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    const parts = fmt.formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const hour = get('hour').replace(/^0/, '');
    return `${hour}:${get('minute')}:${get('second')} ${get('dayPeriod').toUpperCase()}`;
  }

  function dayIn(zone: string, at: Date): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'short',
      day: '2-digit',
      month: 'short'
    }).format(at);
  }

  /** Push a city's wall clock to the machine. */
  async function apply(city: City) {
    if (busy) return;
    busy = city.label;
    message = null;
    try {
      // The machine is set to the city's **current** wall time, expressed in
      // UTC so no timezone maths has to happen in the shell.
      const target = new Date(now.getTime() + offsetMs(city.zone, now));
      const text = await setSystemClock(city.win, target.toISOString());
      message = { kind: 'ok', text: `${city.label} ka time set ho gaya · ${text}` };
    } catch (e) {
      message = { kind: 'err', text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = null;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <!-- click-away catcher -->
  <button
    class="fixed inset-0 z-[290] cursor-default"
    aria-label="Close the world clock"
    onclick={() => (open = false)}
  ></button>

  <div
    class="fixed right-3 bottom-11 z-[300] w-[268px] rounded-lg border border-nc-line-2 bg-[#1E1E29] p-2 shadow-2xl"
    role="dialog"
    aria-label="World clock"
  >
    <div class="flex items-center gap-2 px-1.5 pt-0.5 pb-1.5">
      <h3 class="text-[10px] font-bold tracking-widest text-nc-mut">WORLD CLOCK</h3>
      <div class="flex-1"></div>
      <span class="font-mono text-[9px] text-nc-mut-2">IST · UTC+5:30</span>
    </div>

    <ul class="space-y-px">
      {#each CITIES as city (city.label)}
        <li
          class="flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-nc-panel-2"
        >
          <span class="w-[74px] shrink-0 truncate text-[12px] text-nc-txt">{city.label}</span>
          <span class="font-mono text-[12px] text-nc-txt tabular-nums">
            {clockIn(city.zone, now)}
          </span>
          <span class="w-[62px] shrink-0 truncate text-[10px] text-nc-mut-2">
            {dayIn(city.zone, now)}
          </span>
          <button
            onclick={() => apply(city)}
            disabled={busy !== null}
            class="ml-auto shrink-0 rounded border border-nc-line px-1.5 py-0.5 text-[10px] text-nc-mut
                   transition-colors duration-150 hover:border-nc-gold/50 hover:text-nc-gold
                   disabled:opacity-40"
            title="Set the machine's clock to {city.label}'s time"
          >
            {busy === city.label ? '…' : 'Set'}
          </button>
        </li>
      {/each}
    </ul>

    {#if message}
      <p
        class="mt-1.5 rounded border border-nc-line bg-nc-panel px-2 py-1.5 text-[10.5px] leading-relaxed
               {message.kind === 'ok' ? 'text-nc-green' : 'text-nc-red'}"
      >
        {message.text}
      </p>
    {/if}

    <p class="mt-1.5 px-1.5 pb-0.5 text-[9.5px] leading-relaxed text-nc-mut-2">
      System clock set karne ke liye administrator privileges chahiye hote hain.
    </p>
  </div>
{/if}
