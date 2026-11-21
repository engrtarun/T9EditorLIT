/**
 * Controls the "What's New" modal that appears when a staged update is
 * waiting. Mounted at the app root so mode isolation cannot unmount it.
 */
import { applyStagedUpdate } from '../ipc';
import { toast } from './toast.svelte';

class WhatsNewStore {
  open = $state(false);
  applying = $state(false);

  show(): void {
    this.open = true;
  }

  hide(): void {
    this.open = false;
  }

  async updateNow(): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    try {
      await applyStagedUpdate();
      // applyStagedUpdate relaunches the app; nothing more to do here.
    } catch (e) {
      this.applying = false;
      toast.push('warn', `Update nahi lag paaya: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export const whatsNew = new WhatsNewStore();
