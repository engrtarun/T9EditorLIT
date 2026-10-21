<script lang="ts">
  /**
   * The shell's one and only `keydown` listener.
   *
   * Mounted once from +page.svelte, outside every `{#key}` block, so the
   * shortcuts survive mode isolation — switching Cut → Polish destroys that
   * panel's tree, but Space still means "play". Components reach the keys by
   * registering with the `shortcuts` store rather than adding their own
   * listeners, which is what keeps this file the single point of dispatch.
   *
   * The `Ctrl + /` cheat sheet renders here too, because it has to sit above
   * every screen — home and editor alike.
   */
  import { shortcuts } from "../../stores/shortcuts.svelte";
  import ShortcutsSheet from "./ShortcutsSheet.svelte";

  function onKeydown(event: KeyboardEvent): void {
    shortcuts.handle(event);
  }

  // `Alt + H` — Clipchamp's "Go to help button". Here it opens the cheat
  // sheet, which is the only help surface this app has. `Ctrl + /` is the
  // same action on its own binding — it was listed in BINDINGS (and therefore
  // in the sheet's own header) without ever being registered, so the flagship
  // key did nothing. Registered here, next to `help`, on both screens.
  $effect(() => {
    const un = [
      shortcuts.bind("help", () => shortcuts.toggleSheet(), "always"),
      shortcuts.bind("shortcuts", () => shortcuts.toggleSheet(), "always"),
    ];
    return () => un.forEach((fn) => fn());
  });

  /**
   * While the sheet is up it owns Escape — otherwise closing the dialog would
   * need a second listener, and Stage's Escape ("leave full screen") would
   * race it. Registered only when open, so the moment it closes the binding
   * goes back to whichever component had it.
   */
  $effect(() => {
    if (!shortcuts.sheetOpen) return;
    return shortcuts.bind("deselect", () => shortcuts.closeSheet(), "always");
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if shortcuts.sheetOpen}
  <ShortcutsSheet />
{/if}
