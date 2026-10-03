<script>
  // Tools > Record rendering's panel (T-0290), in the LEFT pane while the mode is open, in place
  // of the cutting instructions (Workspace.svelte stacks the two, as it does tilt performance's);
  // the render settings stay on the right. The user, 2026-09-29: "the right bar should stay the
  // render settings but the left bar should be the recording settings. we need two tracing boxes,
  // one for the preview and one for the final recorded rendering ... it should allow users to set
  // the fps and resolution. it should also show a loading bar once the user sets the path of the
  // rock and a red record button."
  //
  // Built from the design language's pieces (kb/the-studio-s-design-language.md): two cards
  // (PanelSection) -- Tracing (the Preview and Final renderers) and Video (frames a second and the
  // size) -- then the red Record button with the take's status under it, the progress card while
  // the final render runs (two bars, this frame and the whole video, with its Cancel), and Done
  // pinned at the pane's foot. What happens on each button is record_mode.js's.
  import { get } from 'svelte/store';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import CircleIcon from '@lucide/svelte/icons/circle';
  import SquareIcon from '@lucide/svelte/icons/square';
  import SaveIcon from '@lucide/svelte/icons/save';
  import PanelSection from './PanelSection.svelte';
  import Slider from './Slider.svelte';
  import {
    recording, recordProgress, recordFrame, exitRecording, setRecordSetting, setRecordSize,
    toggleRecord, cancelRender, saveVideo,
  } from '../lib/record_mode.js';
  import {
    FPS_MIN, FPS_MAX, SIZE_MIN, SIZE_MAX, SIZE_PRESETS, RENDERER_MONTE_CARLO, formatSeconds,
    saveMessage, progressBars,
  } from '../lib/recording.js';
  import { engine, ready, accumulationTarget } from '../lib/stores.js';

  // The modes' ways out look and sit alike (EditPanel's buttons, verbatim).
  const ACTION = 'h-8 flex-1 border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--hover)]';
  // The render settings' own select face (SettingsPanel's SELECT_TRIGGER).
  const SELECT_TRIGGER = 'h-7 w-full rounded-md px-2 py-0 text-xs hover:border-[var(--accent)] dark:hover:border-[var(--accent)]';
  const FPS_SPEC = { min: FPS_MIN, max: FPS_MAX, step: 1 };

  const TIPS = {
    preview: 'The renderer the stone is drawn with while you drag it to record the path, and while this mode is open. Pick a fast one, so the stone keeps up with the mouse.',
    final: 'The renderer every frame of the video is drawn with once you let go. Monte Carlo frames each gather the samples the render settings ask for, so they take much longer.',
    fps: 'How many frames each second of video has. The video plays back at the speed you moved the stone, so more frames make a smoother video and take longer to render.',
    size: 'The video\'s width and height in pixels, whatever the size of the window. Both are rounded down to an even number, which MP4 video needs.',
    record: 'Arms the recorder: then press on the stone and drag it along the path you want. Letting go ends the recording and starts rendering the video. Click again to disarm it.',
  };

  const rec = $derived($recording);
  const busy = $derived(['recording', 'rendering', 'encoding'].includes(rec.phase));
  const rendererNames = $derived($ready && engine.app ? engine.app.renderer_names().split('\n') : []);

  // The frame just finished, drawn at its own size into the small picture (CSS scales it down).
  let frameCanvas = $state(null);

  $effect(() => {
    const frame = $recordFrame;

    if (!frameCanvas || !frame) {
      return;
    }

    frameCanvas.width = frame.width;
    frameCanvas.height = frame.height;

    const pixels = frame.pixels;

    frameCanvas.getContext('2d').putImageData(
      new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length), frame.width, frame.height),
      0, 0);
  });

  /** A size field was left or Enter pressed in it: the typed value, fitted (recording.js). */
  function sizeTyped(name, event) {
    setRecordSetting(name, Number(event.currentTarget.value));
    // Show the fitted value, which may differ from what was typed (odd, too big).
    event.currentTarget.value = String(get(recording).settings[name]);
  }

  function sizeKey(name, event) {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    }
  }

  function megabytes(bytes) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
  }

  const saveNote = $derived(saveMessage(rec.save, rec.saveName, rec.saveError));

  // The Video render card's two bars (T-0309): the frame being drawn, and the whole video.
  const bars = $derived(progressBars($recordProgress, rec.phase));
  // A frame bar that can be measured is a new element for every frame, so it starts the next frame
  // empty at once rather than sliding back down from full; a busy one stays the same element, so
  // its sweep runs on smoothly from frame to frame.
  const frameBarKey = $derived(bars.frame.fraction === null ? -1 : $recordProgress.done);

  const recordLabel = $derived(
    rec.phase === 'armed' ? 'Armed: drag the stone'
      : rec.phase === 'recording' ? 'Recording…'
        : rec.phase === 'done' ? 'Record again'
          : 'Record');
</script>

<div id="record-panel" inert={!rec.open}>
  <PanelSection title="Tracing" id="record-tracing-section">
    <div class="record-field" data-tip={TIPS.preview}>
      <span class="name">Preview</span>
      <Select.Root type="single" disabled={busy}
        bind:value={() => String(rec.settings.preview), value => setRecordSetting('preview', parseInt(value, 10))}>
        <Select.Trigger id="record-preview" class={SELECT_TRIGGER}>{rendererNames[rec.settings.preview] ?? ''}</Select.Trigger>
        <Select.Content>
          {#each rendererNames as name, index}
            <Select.Item value={String(index)} label={name} class="py-1 text-xs" />
          {/each}
        </Select.Content>
      </Select.Root>
    </div>

    <div class="record-field" data-tip={TIPS.final}>
      <span class="name">Final</span>
      <Select.Root type="single" disabled={busy}
        bind:value={() => String(rec.settings.final), value => setRecordSetting('final', parseInt(value, 10))}>
        <Select.Trigger id="record-final" class={SELECT_TRIGGER}>{rendererNames[rec.settings.final] ?? ''}</Select.Trigger>
        <Select.Content>
          {#each rendererNames as name, index}
            <Select.Item value={String(index)} label={name} class="py-1 text-xs" />
          {/each}
        </Select.Content>
      </Select.Root>
    </div>

    {#if rec.settings.final === RENDERER_MONTE_CARLO}
      <p class="record-hint" id="record-samples-hint">Each frame gathers {$accumulationTarget} samples per pixel, the render settings' “Samples to accumulate”.</p>
    {/if}
  </PanelSection>

  <PanelSection title="Video" id="record-video-section">
    <Slider id="record-fps" label="Frames per second" tip={TIPS.fps} spec={FPS_SPEC}
      value={rec.settings.fps} text={`${rec.settings.fps} fps`}
      oninput={v => setRecordSetting('fps', v)}
      readoutRead={() => get(recording).settings.fps}
      readoutWrite={value => setRecordSetting('fps', value)} />

    <div class="setting" data-tip={TIPS.size}>
      <div class="row"><span class="name">Resolution</span></div>
      <div class="record-size">
        <input id="record-width" class="record-number" type="number" min={SIZE_MIN} max={SIZE_MAX} step="2"
          value={rec.settings.width} disabled={busy} aria-label="Width in pixels"
          onchange={event => sizeTyped('width', event)} onkeydown={event => sizeKey('width', event)} />
        <span class="record-times">×</span>
        <input id="record-height" class="record-number" type="number" min={SIZE_MIN} max={SIZE_MAX} step="2"
          value={rec.settings.height} disabled={busy} aria-label="Height in pixels"
          onchange={event => sizeTyped('height', event)} onkeydown={event => sizeKey('height', event)} />
        <span class="record-unit">px</span>
      </div>
      <div class="record-presets">
        {#each SIZE_PRESETS as preset (preset.label)}
          <button type="button" class="record-preset" id="record-size-{preset.label.toLowerCase()}"
            disabled={busy}
            aria-pressed={rec.settings.width === preset.width && rec.settings.height === preset.height}
            onclick={() => setRecordSize(preset)}>{preset.label}</button>
        {/each}
      </div>
    </div>
  </PanelSection>

  {#if rec.support.state === 'unsupported'}
    <p class="record-note record-error" id="record-unsupported" role="alert">{rec.support.reason}</p>
  {/if}

  <!-- The red Record button. aria-pressed while armed or recording (solid red, its dot pulsing; a
       click while recording does nothing, the release ends the take). Off while the final render
       runs, and where this browser cannot make an MP4 (the note above says why). -->
  <button type="button" id="record-button" class="record-button"
    class:record-live={rec.phase === 'armed' || rec.phase === 'recording'}
    aria-pressed={rec.phase === 'armed' || rec.phase === 'recording'}
    disabled={rec.support.state !== 'ok' || rec.phase === 'rendering' || rec.phase === 'encoding'}
    data-tip={TIPS.record} onclick={toggleRecord}>
    <CircleIcon class="record-dot size-3.5" aria-hidden="true" />{recordLabel}
  </button>

  <div class="record-status" id="record-status" aria-live="polite">
    {#if rec.support.state === 'checking'}
      Checking this browser can make MP4 video…
    {:else if rec.phase === 'armed'}
      Press on the stone and drag it along the path you want. Let go to finish.
    {:else if rec.phase === 'recording'}
      <span class="record-mono">{formatSeconds(rec.captured.seconds)}</span> · {rec.captured.frames} frames
    {:else if rec.phase === 'rendering'}
      Rendering frame <span class="record-mono">{Math.min($recordProgress.done + 1, $recordProgress.total)}</span> of <span class="record-mono">{$recordProgress.total}</span>…
    {:else if rec.phase === 'encoding'}
      Finishing the video…
    {:else if rec.phase === 'done' && rec.result}
      <span class="record-mono">{rec.result.frames}</span> frames, <span class="record-mono">{formatSeconds(rec.result.seconds)}</span>, {rec.result.width} × {rec.result.height}, {megabytes(rec.result.bytes)}
    {:else if rec.message}
      {rec.message}
    {:else}
      Click Record, then drag the stone.
    {/if}
  </div>

  {#if ['rendering', 'encoding', 'done'].includes(rec.phase)}
    <PanelSection title="Video render" id="record-render-section">
      <!-- Two bars (T-0309; the user: "one for each frame's rendering and one for the overall
           render"), each labelled, with a readout (recording.js's progressBars). This frame fills
           as a Monte Carlo frame's samples are gathered and starts again for the next; a frame
           drawn in one step (Deterministic, Flat) cannot be measured part way, so its bar sweeps
           to say it is busy, with no value. Whole video is the frames finished plus the part of
           the one being drawn. Both are full once every frame is drawn. -->
      <div class="record-bar">
        <div class="record-bar-row">
          <span id="record-frame-progress-label">This frame</span>
          <span id="record-frame-progress-value">{#if bars.frame.samplesTotal !== null}<span class="record-mono">{bars.frame.samples}</span> of <span class="record-mono">{bars.frame.samplesTotal}</span> samples{:else}{bars.frame.text}{/if}</span>
        </div>
        <div class="record-progress" class:record-busy={bars.frame.fraction === null} id="record-frame-progress"
          role="progressbar" aria-labelledby="record-frame-progress-label" aria-valuemin="0" aria-valuemax="100"
          aria-valuenow={bars.frame.percent ?? undefined} aria-valuetext={bars.frame.text}>
          {#key frameBarKey}
            <div style:width={bars.frame.fraction === null ? null : `${bars.frame.fraction * 100}%`}></div>
          {/key}
        </div>
      </div>
      <div class="record-bar">
        <div class="record-bar-row">
          <span id="record-progress-label">Whole video</span>
          <span id="record-progress-value"><span class="record-mono">{bars.video.percent}%</span></span>
        </div>
        <div class="record-progress" id="record-progress" role="progressbar" aria-labelledby="record-progress-label"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow={bars.video.percent} aria-valuetext={bars.video.text}>
          <div style:width="{bars.video.fraction * 100}%"></div>
        </div>
      </div>
      <canvas id="record-frame" class="record-frame" bind:this={frameCanvas}
        style:aspect-ratio="{rec.settings.width} / {rec.settings.height}"></canvas>

      {#if rec.phase === 'rendering' || rec.phase === 'encoding'}
        <Button variant="outline" size="sm" id="record-cancel" class="{ACTION} w-full"
          data-tip="Stops rendering the video. Nothing is saved; the settings and the stone stay as they are. Escape does the same."
          onclick={cancelRender}>Cancel</Button>
      {:else if rec.phase === 'done'}
        <!-- What became of the last save, in words (recording.js's saveMessage): the file's name
             once saved, and a cancel or a failure said plainly, never looking like a save (T-0297).
             A failure is an alert, in the error colour. -->
        {#if saveNote}
          <p class="record-note" class:record-error={rec.save === 'failed'} id="record-save-note"
            role={rec.save === 'failed' ? 'alert' : 'status'} data-save={rec.save}>{saveNote}</p>
        {/if}
        <Button variant="outline" size="sm" id="record-save" class="{ACTION} w-full gap-1.5 border-[var(--accent)] text-[var(--accent)] dark:border-[var(--accent)]"
          data-tip="Saves the video as an MP4 file, asking where it should go where the browser can."
          disabled={rec.save === 'saving'}
          onclick={saveVideo}><SaveIcon class="size-3.5" aria-hidden="true" />Save video</Button>
      {/if}
    </PanelSection>
  {/if}

  <div class="record-actions">
    <Button variant="outline" size="sm" id="record-done" class={ACTION + ' border-[var(--accent)] text-[var(--accent)] dark:border-[var(--accent)]'}
      data-tip="Closes record rendering: stops any render, and brings back the cutting instructions and your own renderer. Escape does the same, one step at a time."
      onclick={exitRecording}>Done</Button>
  </div>
</div>

<style>
  #record-panel {
    width: 100%;
    height: 100%;
    background: var(--panel);
    /* The same hairline, padding and scrolling column as #instructions-pane, whose place it takes. */
    border-right: 1px solid var(--panel-edge);
    padding: var(--pane-pad) var(--pane-pad) 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .record-field {
    display: grid;
    grid-template-columns: 52px 1fr;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 12px;
    color: var(--text);
  }

  .record-field:last-child {
    margin-bottom: 0;
  }

  .record-hint {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 15px;
  }

  .record-size {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }

  .record-number {
    width: 0;
    flex: 1;
    min-width: 0;
    height: 26px;
    padding: 0 6px;
    border: 1px solid var(--panel-edge);
    border-radius: var(--radius-control);
    background: var(--raised);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .record-number:hover {
    border-color: var(--accent);
  }

  .record-number:disabled,
  .record-preset:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .record-times,
  .record-unit {
    color: var(--muted);
    font-size: 12px;
  }

  .record-presets {
    display: flex;
    gap: 4px;
    margin-top: 6px;
  }

  .record-preset {
    flex: 1;
    height: 22px;
    border: 1px solid var(--panel-edge);
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    cursor: pointer;
  }

  .record-preset:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--text);
  }

  .record-preset[aria-pressed='true'] {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* The red Record button: the user's "red record button". Red (--error, nord11) with a filled
     dot; while armed or recording the dot pulses, so it reads as live. */
  .record-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex: none;
    height: 36px;
    margin-top: 2px;
    border: 1px solid var(--error);
    border-radius: var(--radius-control);
    background: color-mix(in srgb, var(--error) 14%, transparent);
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .record-button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 26%, transparent);
  }

  .record-button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .record-button :global(.record-dot) {
    color: var(--error);
    fill: var(--error);
  }

  .record-live {
    background: var(--error);
    color: var(--on-accent);
  }

  .record-live:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 85%, white);
  }

  .record-live :global(.record-dot) {
    color: var(--on-accent);
    fill: var(--on-accent);
    animation: record-pulse 1s ease-in-out infinite;
  }

  @keyframes record-pulse {
    50% {
      opacity: 0.3;
    }
  }

  .record-status {
    min-height: 16px;
    margin: 8px 0 12px;
    color: var(--muted);
    font-size: 11px;
    line-height: 15px;
  }

  .record-mono {
    font-family: var(--font-mono);
    color: var(--text);
  }

  .record-note {
    margin: 0 0 10px;
    color: var(--muted);
    font-size: 11px;
    line-height: 15px;
  }

  .record-error {
    color: var(--error);
  }

  /* The Video render card's two bars (T-0309), each under a row like a slider's: its name on the
     left, its readout on the right, in the status line's small type (numbers in the number face,
     .record-mono). */
  .record-bar + .record-bar {
    margin-top: 8px;
  }

  .record-bar-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 4px;
    color: var(--muted);
    font-size: 11px;
    line-height: 15px;
  }

  .record-progress {
    height: 4px;
    border-radius: 2px;
    background: var(--panel-edge);
    overflow: hidden;
  }

  .record-progress > div {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }

  /* A frame drawn in one step: no share to show, so a short segment sweeps across to say the frame
     is being drawn. Without motion, a dim full bar says the same. */
  .record-busy > div {
    width: 30%;
    transition: none;
    animation: record-sweep 1.2s ease-in-out infinite;
  }

  @keyframes record-sweep {
    from {
      transform: translateX(-100%);
    }

    to {
      /* The segment's own widths: 100 / 30 of them is the whole track. */
      transform: translateX(334%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .record-busy > div {
      width: 100%;
      opacity: 0.35;
      animation: none;
    }
  }

  .record-frame {
    display: block;
    width: 100%;
    height: auto;
    margin: 10px 0;
    border: 1px solid var(--panel-edge);
    border-radius: var(--radius-control);
    background: var(--raised);
  }

  .record-actions {
    display: flex;
    gap: 8px;
    /* Pinned to the pane's foot, as the tier toolbar is in the cutting instructions. */
    position: sticky;
    bottom: 0;
    margin: auto calc(-1 * var(--pane-pad)) 0;
    padding: var(--pane-pad);
    background: var(--panel);
  }
</style>
