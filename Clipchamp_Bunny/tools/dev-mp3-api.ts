// @ts-nocheck
/**
 * The dev server's MP3 endpoint — the **browser preview's** export engine.
 *
 * The desktop app renders through Rust + FFmpeg. The browser preview has no
 * Rust, but it runs on the very same machine, so the dev server can run
 * FFmpeg itself. This plugin is the browser's stand-in for the Rust command,
 * and it is **development only**: `configureServer` never runs in a build, so
 * nothing here ships inside the bundle.
 *
 * It answers one request:
 *
 *   POST /api/mp3-export   { source, segments, options, output }
 *     → the MP3 bytes, with `X-T9-Duration` telling the panel how long it is
 *
 * The source has to be a file inside `public/` — that is the baked demo the
 * browser preview plays. Nothing outside the project folder is ever read.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { audioFilter } from '../src/lib/export-presets';

/** Read the whole request body — the panel posts a small JSON document. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The FFmpeg invocation — the same filter graph the Rust engine builds. */
function buildArgs(source, segments, options, output) {
  const filter = audioFilter(segments ?? []);
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', source];

  if (filter) {
    args.push('-filter_complex', filter, '-map', '[aout]');
  } else {
    args.push('-map', '0:a:0');
  }

  args.push('-vn', '-c:a', 'libmp3lame');
  args.push('-b:a', `${options.bitrateKbps ?? 192}k`);
  args.push('-ar', String(options.sampleRate ?? 44100));
  args.push('-ac', String(options.channels ?? 2));

  if (options.normalize) {
    args.push('-af', 'loudnorm=I=-14:TP=-1.5:LRA=11');
  }

  args.push('-id3v2_version', '3');
  args.push(output);
  return args;
}

/** Run FFmpeg and resolve with its stderr (empty when it worked). */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => {
      if (stderr.length < 8192) stderr += c.toString();
    });
    child.on('error', (e) => reject(new Error(`could not start ffmpeg: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve('');
      else reject(new Error(stderr.trim() || `ffmpeg exited with ${code}`));
    });
  });
}

/**
 * Resolve the browser's media URL to a file on disk.
 *
 * Only files inside `public/` are allowed — that is where the baked demo
 * lives, and a path that escapes the project folder is refused.
 */
function resolveSource(root, url) {
  if (typeof url !== 'string' || !url) return null;
  const rel = url.replace(/^\/+/, '').split('?')[0];
  const publicDir = path.resolve(root, 'public');
  const full = path.resolve(publicDir, rel);
  if (!full.startsWith(publicDir + path.sep)) return null;
  if (!existsSync(full)) return null;
  return full;
}

/** The Vite plugin. */
export function mp3DevApi() {
  return {
    name: 't9-mp3-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/mp3-export', async (req, res) => {
        const fail = (code, message) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(message);
        };

        try {
          if (req.method !== 'POST') {
            fail(405, 'POST only');
            return;
          }

          const body = JSON.parse((await readBody(req)) || '{}');
          const options = body.options ?? {};
          const segments = Array.isArray(body.segments) ? body.segments : [];

          const source = resolveSource(server.config.root, body.source);
          if (!source) {
            fail(400, `the dev server only renders files inside public/ (got ${body.source})`);
            return;
          }

          const name = (body.output || 't9-editor-lit (audio).mp3').split(/[\\/]/).pop();
          const outDir = path.join(tmpdir(), 't9-mp3-dev');
          const output = path.join(outDir, name.endsWith('.mp3') ? name : `${name}.mp3`);

          try {
            mkdirSync(outDir, { recursive: true });
          } catch (e) {
            fail(500, `could not create the render folder ${outDir}: ${e.message}`);
            return;
          }

          try {
            rmSync(output, { force: true });
          } catch {
            /* an old file that will not go is overwritten by ffmpeg -y anyway */
          }

          try {
            await runFfmpeg(buildArgs(source, segments, options, output));
          } catch (e) {
            fail(500, e.message || 'the mp3 render failed');
            return;
          }

          if (!existsSync(output)) {
            fail(500, 'ffmpeg finished but wrote no file');
            return;
          }

          const bytes = readFileSync(output);
          const seconds = segments.length
            ? segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0)
            : 0;

          res.statusCode = 200;
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Content-Length', String(bytes.length));
          res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
          res.setHeader('X-T9-Duration', String(seconds));
          res.end(bytes);
        } catch (e) {
          fail(500, e?.message || 'the mp3 render failed');
        }
      });
    }
  };
}
