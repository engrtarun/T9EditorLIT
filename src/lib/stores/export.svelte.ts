/**
 * Export store — holds the plan, progress, and result state for the Export
 * panel. Runs entirely on the frontend; the actual render runs in the Rust
 * backend via the `start_export` command.
 */

import { project } from "../stores/project.svelte";
import { transcript } from "../stores/transcript.svelte";
import {
  startExport,
  cancelExport,
  planExport,
  onExportProgress,
  errorMessage,
  defaultDbPath,
} from "../ipc";
import type {
  ExportPlan,
  ExportProgress,
  ExportResult,
  ExportRequest,
  ExportOptions,
  ExportSegment,
} from "../types";
import { segmentsFromTranscript, summarizeSegments, formatDuration } from "../segments";

type ExportMode = "hybrid" | "copy" | "encode";

const DEFAULT_MODE: ExportMode = "hybrid";

class ExportStore {
  // Input state
  mode = $state<ExportMode>(DEFAULT_MODE);
  outputPath = $state<string>("");
  options = $state<ExportOptions>({ mode: DEFAULT_MODE, alignToleranceMs: 40 });

  // Computed from transcript
  segments = $state<ExportSegment[]>([]);
  summary = $state<{ keptSecs: number; cutSecs: number; segmentCount: number }>({
    keptSecs: 0,
    cutSecs: 0,
    segmentCount: 0,
  });

  // Plan / progress / result
  status = $state<"idle" | "planning" | "ready" | "running" | "done" | "cancelled" | "error">(
    "idle",
  );
  currentPlan = $state<ExportPlan | null>(null);
  progress = $state<ExportProgress | null>(null);
  result = $state<ExportResult | null>(null);
  error = $state<string | null>(null);

  // Progress listener cleanup
  private unlisten: (() => void) | null = null;

  private get sourcePath(): string | null {
    return project.info?.path ?? null;
  }

  private get durationSecs(): number {
    return project.info?.durationSecs ?? 0;
  }

  /** Rebuild segments from the current transcript whenever it changes. */
  rebuildSegments(): void {
    if (!this.sourcePath || !transcript.hasTranscript) {
      this.segments = [];
      this.summary = { keptSecs: 0, cutSecs: 0, segmentCount: 0 };
      return;
    }
    const segs = segmentsFromTranscript(transcript.lines, this.durationSecs);
    this.segments = segs;
    this.summary = summarizeSegments(segs, this.durationSecs);
  }

  /** Compute a sensible default output path: <source>_cut.mp4 in the same folder. */
  async computeDefaultOutput(): Promise<string> {
    if (!this.sourcePath) return "";
    const path = await import("path");
    const dir = path.dirname(this.sourcePath);
    const base = path.basename(this.sourcePath, path.extname(this.sourcePath));
    return path.join(dir, `${base}_cut.mp4`);
  }

  /** Called when the project loads to initialise the output field. */
  async prepare(): Promise<void> {
    this.rebuildSegments();
    if (!this.outputPath && this.sourcePath) {
      this.outputPath = await this.computeDefaultOutput();
    }
  }

  /** Ask the backend for the export plan (preview). */
  async buildPlan(): Promise<void> {
    if (!this.sourcePath || this.segments.length === 0) {
      this.error = "no source or no kept segments";
      this.status = "error";
      return;
    }
    this.status = "planning";
    this.error = null;
    try {
      const request = this.buildRequest();
      this.currentPlan = await planExport(request);
      this.status = "ready";
    } catch (err) {
      this.error = errorMessage(err);
      this.status = "error";
    }
  }

  /** Run the export. */
  async run(): Promise<void> {
    if (!this.sourcePath || this.segments.length === 0) {
      this.error = "no source or no kept segments";
      this.status = "error";
      return;
    }
    if (this.status === "running") return;

    this.status = "running";
    this.error = null;
    this.progress = null;
    this.result = null;

    try {
      const request = this.buildRequest();
      this.unlisten = await onExportProgress((p) => {
        this.progress = p;
      });
      this.result = await startExport(request);
      this.status = "done";
    } catch (err) {
      const msg = errorMessage(err);
      if (msg === "export cancelled") {
        this.status = "cancelled";
      } else {
        this.error = msg;
        this.status = "error";
      }
    } finally {
      if (this.unlisten) {
        this.unlisten();
        this.unlisten = null;
      }
    }
  }

  /** Cancel a running export. */
  cancel(): void {
    if (this.status !== "running") return;
    cancelExport();
    // status will flip to "cancelled" when the command resolves
  }

  /** Reset everything for a new export. */
  reset(): void {
    this.status = "idle";
    this.currentPlan = null;
    this.progress = null;
    this.result = null;
    this.error = null;
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
  }

  private buildRequest(): ExportRequest {
    return {
      source: this.sourcePath!,
      segments: this.segments,
      output: this.outputPath,
      options: { ...this.options, mode: this.mode },
      dbPath: null, // default_db_path is resolved on the Rust side
    };
  }

  /** Human-readable labels for the mode radio buttons. */
  static modeLabels: Record<ExportMode, { label: string; hint: string }> = {
    hybrid: {
      label: "Smart Hybrid (default)",
      hint: "Stream-copy aligned cuts, micro-encode only the partial GOPs",
    },
    copy: {
      label: "Stream Copy Only",
      hint: "Snap cuts to keyframes — zero quality loss, may drop short segments",
    },
    encode: {
      label: "Full Re-Encode",
      hint: "Exact cut points, everything re-encoded — slowest, highest compatibility",
    },
  };
}

export const exportStore = new ExportStore();
