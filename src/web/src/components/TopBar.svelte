<script>
  // The top bar (T-0140; relaid out T-0143; title fixed to the product's name T-0144): a large
  // title, top left, with the File/Edit/Tools/Help menu beside it on the same row -- the
  // first piece of the shell that turns the renderer into a design planner.
  //
  // #app-title is the PRODUCT's name and never changes -- it used to track the open design
  // (T-0140's setDesignTitle, removed), but the user asked instead for a fixed
  // "Houseki Design Studio" (2026-09-18). Nothing on the page now shows which stone is
  // loaded: the panel's own "Stone: <file>" hint line was already removed earlier the same
  // day, so this is the second place that information has gone. Not replaced here -- if the
  // user wants it back, it belongs somewhere a planner would put it (see the left pane,
  // T-0142), not spliced back into the product title.
  //
  // Independent of GemApp -- it needs no wasm, no stone and no `app` -- so it works immediately
  // and still works if the wasm module fails to load. The Edit menu's Undo and Redo are live
  // once the session exists (the history reads as "nothing to undo" before then).
  //
  // The menu is shadcn-svelte's Menubar (Bits UI), which brings the Google Docs behaviour this
  // bar was hand-written to have: a click opens a menu and another click on its button closes
  // it, Escape and a click elsewhere close it, and while one is open the pointer moving to the
  // next button opens that one; plus arrow-key navigation, focus return and menu roles the
  // hand-written version lacked. Its dropdowns are portalled to <body>, so each carries the id
  // `menu-dropdown-<name>` it always had, on the dropdown itself.
  import { canUndo, canRedo, renameRequest } from '../lib/stores.js';
  import { fullscreen } from '../lib/fullscreen.js';
  import { eventTargetIsEditable, eventTargetTakesText, isMacPlatform } from '../lib/keys.js';
  import { sessionReady, undo, redo, stepHistory } from '../lib/session.js';
  import { ariaDisabled } from '../lib/native.js';
  // T-0206's own imports, kept separate from the pre-existing stores.js import above so this
  // ticket's edit never touches a line a sibling export-format agent might also be touching.
  import { get } from 'svelte/store';
  import { cutMeta } from '../lib/stores.js';
  import { getDesign } from '../lib/tier_controller.js';
  import { designToAscText } from '../lib/export_asc.js';
  import { saveFileAs } from '../lib/export_file.js';
  // Edit > Scale height (T-0231): what it needs to know to be live or inert, and the mode it opens.
  import { tierView } from '../lib/tier_controller.js';
  import { editing } from '../lib/edit_mode.js';
  import { scaleHeightOpen, enterScaleHeightMode } from '../lib/scale_height_mode.js';
  // Tools > Cutting assistant (T-0234): the mode it opens, and whether it is open.
  import { cutting, enterCuttingAssistant } from '../lib/cutting_assistant_mode.js';
  // Edit > Resize girdle (T-0237), likewise.
  import { resizeGirdleOpen, enterResizeGirdleMode } from '../lib/resize_girdle_mode.js';
  // T-0204/T-0205/T-0207 originally wired these three through onSelect={() => import(...)},
  // a dynamic import, each deliberately avoiding this file's own top-level import lines so three
  // concurrent agents' edits could never collide on the same line. That safely built and tested
  // under `deno task build` (Vite), but broke the page's OTHER build path: make_page.py's
  // check_template() refuses ANY dynamic import() (it can only ever resolve via a chunk fetch,
  // and the built page is one self-contained file:// document with nothing left to fetch), so
  // `build.sh`/`make_page.py` failed for the whole page with a confusing acorn error about
  // import.meta rather than a message naming the real cause. Static imports, like exportAsc's
  // own designToAscText above, are the only shape make_page.py's minifier accepts.
  import { exportGem } from '../lib/export_gem.js';
  import { exportObj } from '../lib/export_obj.js';
  import { exportGcs } from '../lib/export_gcs.js';
  import { exportCurrentStoneAsStl } from '../lib/export_stl.js';
  import { exportPdf } from '../lib/export_pdf.js';
  import * as Menubar from '$lib/components/ui/menubar/index.js';
  import SettingsDialog from './SettingsDialog.svelte';
  // The logo, directly left of the title (2026-09-19): the same file the landing and docs pages
  // inline (site/logo.svg), bundled as text by Vite so the page still loads nothing at runtime.
  import logoSvg from '../../../site/logo.svg?raw';
  // Help > Documentation's target (T-0236): `docs` from the site's own settings, the one value
  // the landing page's documentation link is built from too (make_page.py's @@DOCS_URL@@). Vite
  // bundles the JSON, so nothing is fetched at runtime.
  import { docs as docsUrl } from '../../../site/site.json';

  // Help > Bug report's target: the project's issue tracker.
  const ISSUES_URL = 'https://github.com/0xDECAFC0FFEE/HousekiDesignStudio/issues';

  const isMac = isMacPlatform();

  function openFilePicker() {
    document.getElementById('obj-file').click();
  }

  // File > Export > GemCad (.asc), T-0206. Writes the loaded design's polar description (its
  // own tiers/gear/headers -- design.js, not the rendered geometry, which a .asc never stores)
  // back out as GemCad ASCII text, and hands it to saveFileAs, which opens the OS's own Save
  // dialog when the browser supports one (letting the user pick where it goes and confirm or
  // change its type/extension) and otherwise falls back to a plain download -- see
  // export_file.js's own doc comment. A no-op without a loaded design (the built-in stone, or a
  // plain .obj, has none to export), the same guard the tier toolbar's Comments button uses
  // (tier_controller.js's toolbarState).
  async function exportAsc() {
    const design = getDesign();

    if (!design) {
      return;
    }

    const meta = get(cutMeta);
    const text = designToAscText(design, { title: meta.name, author: meta.author, date: meta.date });
    // The cut-header name becomes the filename, with characters no common filesystem accepts
    // in a filename replaced -- the same handful `export_file.js`'s downloadFile fallback hands
    // straight to `<a download>`, which does no sanitising of its own; the Save dialog path
    // sanitises for the identical reason, since `suggestedName` reaches the same filesystem.
    const filename = `${(meta.name || 'design').replace(/[\\/:*?"<>|]/g, '_')}.asc`;

    await saveFileAs(filename, text, {
      description: 'GemCad design (text)',
      mimeType: 'text/plain',
      extensions: ['.asc'],
    });
  }

  // Rename opens the cut-name editor and puts the caret in it. A menu returns focus to its button
  // when it closes, which would land AFTER the editor took the focus and blur it (an editor
  // applies on blur, and closes), so that one item asks the menu not to.
  let keepFocusOnClose = false;

  function rename() {
    keepFocusOnClose = true;
    renameRequest.update(n => n + 1);
  }

  // File > Settings opens the settings dialog, which takes the focus itself; the menu must not
  // give it back to its button as it closes, for the same reason as Rename.
  let settingsDialog;

  function openSettings() {
    keepFocusOnClose = true;
    settingsDialog.open();
  }

  function onCloseAutoFocus(event) {
    if (keepFocusOnClose) {
      keepFocusOnClose = false;
      event.preventDefault();
    }
  }

  function onDocumentKeydown(event) {
    // Never intercept typing: the slider readouts and the cut-header fields open a real
    // <input>, and native copy/paste and other editing must keep working there untouched.
    // Open (Cmd/Ctrl+O) is handled here (F2/Rename is the cut header's, using the same guard);
    // Escape closing a menu is the menubar's own.
    if (!eventTargetIsEditable(event)) {
      const modifierHeld = isMac ? event.metaKey : event.ctrlKey;

      if (modifierHeld && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        openFilePicker();
        return;
      }
    }

    // Undo/Redo: Cmd+Z / Shift+Cmd+Z on a Mac, Ctrl+Z / Ctrl+Shift+Z elsewhere, where Ctrl+Y is
    // also taken as Redo. Not while typing into a text box, whose own text undo those keys
    // belong to (eventTargetTakesText), and only once GemApp exists.
    if (!sessionReady()) {
      return;
    }

    // Nor while a modal dialog (the gear dialog) is open, which would be undone behind it. A
    // colour editor's popover is a `role="dialog"` too, but not modal: Undo closes it first
    // (stepHistory), as it always closed the stone color's sliders.
    if (eventTargetTakesText(event) ||
        document.querySelector('[role="dialog"][data-state="open"]:not([data-slot="popover-content"])') ||
        event.altKey || !(isMac ? event.metaKey : event.ctrlKey)) {
      return;
    }

    const key = event.key.toLowerCase();

    if (key === 'z') {
      event.preventDefault();
      stepHistory(!event.shiftKey);
    } else if (key === 'y' && !isMac && !event.shiftKey) {
      event.preventDefault();
      stepHistory(false);
    }
  }

  // The dropdown items. A shortcut is written for the platform the page is running on (`⌘`/`⇧⌘`
  // on a Mac, `Ctrl+`/`Ctrl+Shift+` elsewhere); Rename's "F2" has no such split (there is no
  // single cross-platform modifier convention for rename the way there is for copy/paste).
  // Inert items carry aria-disabled, not Bits UI's `disabled` (set from outside, see
  // ariaDisabled in native.js): muted text, no hover highlight, and clicking one does nothing but
  // close the menu, as it always did.
  // `opacity-45` is the same fade the tier toolbar's inactive buttons use (TierToolbar's TOOL),
  // added for T-0208: the muted colour ALONE is nord4 against nord6, which measures as a
  // difference (rgb(216,222,233) against rgb(236,239,244)) but does not read as one -- greyed
  // items looked very nearly live. It applies to File > New and Save, and to Undo/Redo with
  // nothing to step, as well as to the ten new placeholders: one "this cannot be used" look
  // across the whole page, rather than two that disagree.
  const INERT = 'aria-disabled:text-muted-foreground aria-disabled:opacity-45 ' +
    'aria-disabled:focus:bg-transparent';
  // Every placeholder item's tip ends with this (T-0208). Greying an item says it cannot be used
  // but not why, and "New" or "Save" can be guessed where "Tilt performance" cannot -- so each of
  // the ten new items explains itself and then says plainly that it is not there yet.
  const PLACEHOLDER_TIP = 'Not built yet.';
  const ITEM = 'px-2.5 py-1.5 text-xs';
  const MENU = 'min-w-[200px] p-1';
  // Two sizes (2026-09-22). T-0226 made the bar compact ("top bar is definitely too large,
  // especially on mobile devices when landscape"): 13px text in a 26px-tall button. The user
  // then asked the same day to "make the top bar 50% taller", so on a screen at least 40rem wide
  // AND more than 500px tall the buttons are 15px text in a 32px button, scaled with the bar
  // (topbar.css). A phone, in either orientation, keeps the compact 13px, the size the complaint
  // was about. The media condition is an arbitrary Tailwind variant, and it must match
  // topbar.css's own small-screen query exactly: these utilities sit in a cascade layer above
  // topbar.css, so they cannot be written as a rule in that file.
  // hover:bg-[var(--hover)] / aria-expanded:bg-[var(--hover)] override the Menubar CLI file's own
  // `hover:bg-muted aria-expanded:bg-muted` (2026-09-22, found while checking "every button
  // highlights on hover" with a screenshot): `--topbar` is `--raised` in dark mode
  // (base.css), and shadcn's `muted` is ALSO mapped straight onto `--raised` (tailwind.css's
  // `@theme inline`), so a trigger hovered or a menu left open painted its own background back
  // over itself -- a highlight that was there in the DOM and invisible on screen. The menu
  // ITEMS never had this problem (their hover is `accent`, the translucent teal `--hover`, not
  // `muted`); this makes the trigger match them instead of shadcn's plain default.
  const TRIGGER = 'rounded-md border border-transparent font-normal hover:bg-[var(--hover)] aria-expanded:bg-[var(--hover)] ' +
    'h-[26px] px-2.5 py-0 text-[13px] ' +
    '[@media(min-width:40rem)_and_(min-height:500.02px)]:h-8 [@media(min-width:40rem)_and_(min-height:500.02px)]:px-3 [@media(min-width:40rem)_and_(min-height:500.02px)]:text-[15px]';
  const SHORTCUT = 'font-mono text-[11px] tracking-normal';

  // Scale height's tip (T-0231), in the voice of the placeholders it replaced, plus why it is
  // inert when it is: no design to scale (the built-in mesh or a plain .obj), or another mode
  // already open -- one session at a time, as edit mode has it. A greyed item that cannot say
  // why is exactly what T-0208's tips were written against.
  const SCALE_HEIGHT_TIP = 'Makes the crown or the pavilion taller or flatter, each by its own ratio: every facet turns so the tangent of its angle is multiplied by the ratio, and moves so its meets still meet. The girdle stays where it is.';
  const scaleHeightInert = $derived(!$tierView.hasDesign || $editing !== null || $scaleHeightOpen || $cutting.open || $resizeGirdleOpen);
  const scaleHeightTip = $derived(
    !$tierView.hasDesign ? `${SCALE_HEIGHT_TIP} There is no design loaded to scale.`
      : $editing !== null ? `${SCALE_HEIGHT_TIP} Finish editing the tier first: Done, or Cancel.`
        : $scaleHeightOpen ? `${SCALE_HEIGHT_TIP} It is already open.`
          : $cutting.open ? `${SCALE_HEIGHT_TIP} Close the cutting assistant first: Done, or Escape.`
            : $resizeGirdleOpen ? `${SCALE_HEIGHT_TIP} Finish resizing the girdle first: Done, or Cancel.`
              : SCALE_HEIGHT_TIP);

  // Tools > Cutting assistant (T-0234): live, and inert, saying why, in the same cases as scale
  // height -- no design to walk through, or another mode open -- or while it is already open.
  const CUTTING_TIP = 'Walks you through cutting the stone from a rough, one facet at a time: each step shows the angle and tooth to set and the rock as it will look once that facet is cut, on its dop. The design is not changed.';
  const cuttingInert = $derived(!$tierView.hasDesign || $editing !== null || $scaleHeightOpen || $cutting.open || $resizeGirdleOpen);
  const cuttingTip = $derived(
    !$tierView.hasDesign ? `${CUTTING_TIP} There is no design loaded to cut.`
      : $editing !== null ? `${CUTTING_TIP} Finish editing the tier first: Done, or Cancel.`
        : $scaleHeightOpen ? `${CUTTING_TIP} Finish scaling the height first: Done, or Cancel.`
          : $cutting.open ? `${CUTTING_TIP} It is already open.`
            : $resizeGirdleOpen ? `${CUTTING_TIP} Finish resizing the girdle first: Done, or Cancel.`
              : CUTTING_TIP);

  // Edit > Resize girdle (T-0237), the same way: what it does, then why it is inert when it is.
  const RESIZE_GIRDLE_TIP = 'Cuts every facet deeper or shallower by the same ratio while the girdle facets stay where they are, so the girdle band grows or shrinks against the rest of the stone. Every angle stays as cut.';
  const resizeGirdleInert = $derived(!$tierView.hasDesign || $editing !== null || $scaleHeightOpen || $cutting.open || $resizeGirdleOpen);
  const resizeGirdleTip = $derived(
    !$tierView.hasDesign ? `${RESIZE_GIRDLE_TIP} There is no design loaded to resize.`
      : $editing !== null ? `${RESIZE_GIRDLE_TIP} Finish editing the tier first: Done, or Cancel.`
        : $scaleHeightOpen ? `${RESIZE_GIRDLE_TIP} Finish scaling the height first: Done, or Cancel.`
          : $cutting.open ? `${RESIZE_GIRDLE_TIP} Close the cutting assistant first: Done, or Escape.`
            : $resizeGirdleOpen ? `${RESIZE_GIRDLE_TIP} It is already open.`
              : RESIZE_GIRDLE_TIP);

  // Mode status (moved here from two places, 2026-09-24): SettingsPanel's own pinned footer,
  // "Mode: Overview" (added 2026-09-22, the user: "at the bottom of the render settings section
  // can you add a bit about the mode"), and each mode panel's own <h2> title ("Editing {id}",
  // EditPanel; "Scaling height", ScaleHeightPanel; "Cutting assistant", CuttingAssistantPanel;
  // "Resizing girdle", ResizeGirdlePanel) -- four call sites all naming the same thing, the
  // mode the page is in right now. The user asked to "move the mode status information to the
  // top right of the menu bar"; this single readout replaces all four, always on screen (as
  // SettingsPanel's footer always was) rather than only while a mode panel is mounted, so a
  // glance at the bar answers "which mode am I in" from anywhere on the page.
  //
  // The four live modes are mutually exclusive (kb/application-modes-current-and-planned.md:
  // each refuses to open while another is), so at most one of the four branches below is ever
  // true; the order does not matter, but it is written to match the panels' own stacking order
  // in App.svelte.
  const editTier = $derived($editing?.tier ?? null);
  // EditPanel's own `id` lookup, verbatim: the tier's row id (C1, P2, ...), the way the cutting
  // instructions name it, not the tier object itself.
  const editTierId = $derived(editTier
    ? ([...$tierView.pavilion, ...$tierView.crown].find(row => row.tier === editTier)?.id ?? '')
    : '');
  const modeStatus = $derived(
    editTier !== null ? `Editing ${editTierId}`
      : $scaleHeightOpen ? 'Scaling height'
        : $cutting.open ? 'Cutting assistant'
          : $resizeGirdleOpen ? 'Resizing girdle'
            : 'Overview');
</script>

<svelte:document onkeydown={onDocumentKeydown} />

<!-- Hidden, not unmounted, while the settings panel's fullscreen toggle is on (2026-09-20):
     this component's `svelte:document` keydown handler is where Cmd/Ctrl+O, Undo and Redo live,
     and they must keep working with the bar off the screen. Tailwind's `hidden` sits in a cascade
     layer above topbar.css, so it beats `#topbar { display: flex }` with no !important anywhere;
     see fullscreen.js. -->
<div id="topbar" class={$fullscreen ? 'hidden' : ''}>
  <a id="app-logo" href="index.html" aria-label="Houseki Design Studio home">{@html logoSvg}</a>
  <a id="app-title" href="index.html">Houseki Design Studio</a>

  <Menubar.Root id="menu-bar" aria-label="Application menu"
    class="h-auto flex-none gap-0.5 rounded-none border-0 bg-transparent p-0">
    <Menubar.Menu>
      <Menubar.Trigger id="menu-button-file" data-menu="file" class={TRIGGER}>File</Menubar.Trigger>
      <Menubar.Content id="menu-dropdown-file" aria-label="File" class={MENU} align="start"
        sideOffset={4} alignOffset={0} {onCloseAutoFocus}>
        <Menubar.Item {@attach ariaDisabled(() => true)} class="{ITEM} {INERT}" data-shortcut-mac="⌘N"
          data-shortcut-other="Ctrl+N">New
          <Menubar.Shortcut class={SHORTCUT}>{isMac ? '⌘N' : 'Ctrl+N'}</Menubar.Shortcut>
        </Menubar.Item>
        <!-- The only item that does anything: takes over the file picker the panel's
             removed "Open .obj / .asc / .gem…" button used to open. -->
        <Menubar.Item id="menu-item-open" class={ITEM} data-shortcut-mac="⌘O"
          data-shortcut-other="Ctrl+O" onSelect={openFilePicker}>Open
          <Menubar.Shortcut class={SHORTCUT}>{isMac ? '⌘O' : 'Ctrl+O'}</Menubar.Shortcut>
        </Menubar.Item>
        <Menubar.Item {@attach ariaDisabled(() => true)} class="{ITEM} {INERT}" data-shortcut-mac="⌘S"
          data-shortcut-other="Ctrl+S">Save
          <Menubar.Shortcut class={SHORTCUT}>{isMac ? '⌘S' : 'Ctrl+S'}</Menubar.Shortcut>
        </Menubar.Item>
        <!-- Export (2026-09-19): a submenu, one item per file format. Each item starts
             aria-disabled and is wired up by its own format's writer module
             (export_gem.js / export_asc.js / export_obj.js / export_stl.js, web/src/lib/) --
             deliberately left as four independent one-line edits here so the four writers can
             be built without touching each other's line. -->
        <Menubar.Sub>
          <Menubar.SubTrigger id="menu-item-export" class={ITEM}>Export</Menubar.SubTrigger>
          <Menubar.SubContent class={MENU}>
            <Menubar.Item id="menu-item-export-gem" class={ITEM}
              onSelect={exportGem}>GemCad (.gem)</Menubar.Item>
            <Menubar.Item id="menu-item-export-asc" class={ITEM}
              onSelect={exportAsc}>GemCad (.asc)</Menubar.Item>
            <Menubar.Item id="menu-item-export-gcs" class={ITEM}
              onSelect={exportGcs}>Gem Cut Studio (.gcs)</Menubar.Item>
            <Menubar.Item id="menu-item-export-obj" class={ITEM}
              onSelect={exportObj}>Wavefront (.obj)</Menubar.Item>
            <Menubar.Item id="menu-item-export-stl" class={ITEM}
              onSelect={exportCurrentStoneAsStl}>STL (.stl)</Menubar.Item>
            <!-- The printed cutting sheet (export_pdf.js): drawings, proportions and the
                 instructions, laid out after GemCad's own print. -->
            <Menubar.Item id="menu-item-export-pdf" class={ITEM}
              onSelect={exportPdf}>PDF cutting sheet (.pdf)</Menubar.Item>
          </Menubar.SubContent>
        </Menubar.Sub>
        <!-- Live since T-0145: the cut name field IS the rename, so this opens it in place of
             the old placeholder behaviour -- see CutHeader. -->
        <Menubar.Item id="menu-item-rename" class={ITEM} onSelect={rename}>Rename
          <Menubar.Shortcut class={SHORTCUT}>F2</Menubar.Shortcut>
        </Menubar.Item>
        <Menubar.Separator />
        <!-- The settings dialog: light or dark mode, and the angle decimal places. -->
        <Menubar.Item id="menu-item-settings" class={ITEM} onSelect={openSettings}>Settings</Menubar.Item>
      </Menubar.Content>
    </Menubar.Menu>

    <Menubar.Menu>
      <Menubar.Trigger id="menu-button-edit" data-menu="edit" class={TRIGGER}>Edit</Menubar.Trigger>
      <Menubar.Content id="menu-dropdown-edit" aria-label="Edit" class={MENU} align="start"
        sideOffset={4} alignOffset={0}>
        <!-- Live (2026-09-18): step through the edit history. Disabled until there is
             something to undo or redo. -->
        <Menubar.Item id="menu-item-undo" {@attach ariaDisabled(() => !$canUndo)}
          class="{ITEM} {INERT}" data-shortcut-mac="⌘Z" data-shortcut-other="Ctrl+Z"
          onSelect={undo}>Undo
          <Menubar.Shortcut class={SHORTCUT}>{isMac ? '⌘Z' : 'Ctrl+Z'}</Menubar.Shortcut>
        </Menubar.Item>
        <Menubar.Item id="menu-item-redo" {@attach ariaDisabled(() => !$canRedo)}
          class="{ITEM} {INERT}" data-shortcut-mac="⇧⌘Z" data-shortcut-other="Ctrl+Shift+Z"
          onSelect={redo}>Redo
          <Menubar.Shortcut class={SHORTCUT}>{isMac ? '⇧⌘Z' : 'Ctrl+Shift+Z'}</Menubar.Shortcut>
        </Menubar.Item>
        <Menubar.Separator />
        <!-- T-0208, the user's list: the whole-design transforms, all inert for now ("lets grey
             out all of these for now"). Each one rewrites EVERY tier of the design at once --
             which is what separates them from edit mode, whose whole rule is that one tier is
             held and nothing else can be touched (T-0202) -- so they belong in a menu rather
             than in the instructions pane's per-tier toolbar. Each carries the tip that says
             what it will do, ending in PLACEHOLDER_TIP: a greyed item whose name is the only
             thing on screen cannot say why it is greyed. -->
        <Menubar.Item id="menu-item-rotate-index" {@attach ariaDisabled(() => true)}
          class="{ITEM} {INERT}"
          data-tip="Turns the whole design around the index gear, adding the same number of teeth to every facet's index. {PLACEHOLDER_TIP}"
          >Rotate by index</Menubar.Item>
        <Menubar.Item id="menu-item-reverse-index" {@attach ariaDisabled(() => true)}
          class="{ITEM} {INERT}"
          data-tip="Mirrors the design around the index gear, reflecting every facet's index, so a cut made one way round becomes the same cut made the other way. {PLACEHOLDER_TIP}"
          >Reverse index order</Menubar.Item>
        <!-- Resize girdle (T-0237): live, it opens resize_girdle_mode.js. Inert with no design
             loaded, and while edit mode, scale height or this mode is open. -->
        <Menubar.Item id="menu-item-resize-girdle" {@attach ariaDisabled(() => resizeGirdleInert)}
          class="{ITEM} {INERT}" data-tip={resizeGirdleTip}
          onSelect={() => { if (!resizeGirdleInert) enterResizeGirdleMode(); }}
          >Resize girdle</Menubar.Item>
        <Menubar.Item id="menu-item-flip-crown-pavilion" {@attach ariaDisabled(() => true)}
          class="{ITEM} {INERT}"
          data-tip="Turns the design over: the crown becomes the pavilion and the pavilion the crown. {PLACEHOLDER_TIP}"
          >Flip crown and pavilion</Menubar.Item>
        <!-- Scale height (T-0231, 2026-09-23, the user: "can you delete the scale x-y and scale
             z and only have a scale height? when this is selected, we need to enter the 'scale
             height mode'"). The first of these transforms to be built, and so the first live one:
             it opens scale_height_mode.js. Inert with no design loaded, and while edit mode or
             this mode is open. -->
        <Menubar.Item id="menu-item-scale-height" {@attach ariaDisabled(() => scaleHeightInert)}
          class="{ITEM} {INERT}" data-tip={scaleHeightTip}
          onSelect={() => { if (!scaleHeightInert) enterScaleHeightMode(); }}
          >Scale height</Menubar.Item>
        <!-- Manual optimizer (T-0208), moved here from Tools on 2026-09-23 (the user: "can you
             move the manual optimizer to the edit menu"): it changes the design's angles, which
             makes it an edit rather than a window onto the design. Inert for now. -->
        <Menubar.Item id="menu-item-manual-optimizer" {@attach ariaDisabled(() => true)}
          class="{ITEM} {INERT}"
          data-tip="Adjust the angles by hand and watch what it does to the stone's light return, keeping the changes that help. {PLACEHOLDER_TIP}"
          >Manual optimizer</Menubar.Item>
      </Menubar.Content>
    </Menubar.Menu>

    <Menubar.Menu>
      <Menubar.Trigger id="menu-button-tools" data-menu="tools" class={TRIGGER}>Tools</Menubar.Trigger>
      <Menubar.Content id="menu-dropdown-tools" aria-label="Tools" class={MENU} align="start"
        sideOffset={4} alignOffset={0}>
        <!-- T-0208, the user's list, plus Record rendering added later, less Manual optimizer, which
             moved to Edit (2026-09-23). All but the Cutting assistant (live since T-0234) are
             inert for now, but the menu reads as "things are coming". Each is a WINDOW onto the design rather than a change to it, which is why
             none of them is in Edit above. Each of these, like Edit's six transforms, is
             planned to become its own mode once it is built (see
             kb/application-modes-current-and-planned.md). -->
        <Menubar.Item id="menu-item-tilt-performance" {@attach ariaDisabled(() => true)}
          class="{ITEM} {INERT}"
          data-tip="How much light the stone returns as it is tilted away from face-up, so a cut can be judged the way it is actually looked at rather than only straight on. {PLACEHOLDER_TIP}"
          >Tilt performance</Menubar.Item>
        <Menubar.Item id="menu-item-size-yield" {@attach ariaDisabled(() => true)}
          class="{ITEM} {INERT}"
          data-tip="The finished stone's measurements and weight, and how much of a piece of rough this design would use. {PLACEHOLDER_TIP}"
          >Size/yield calculator</Menubar.Item>
        <!-- Live since T-0234 (2026-09-23, the user: "its purpose is to tell users the steps to
             cut the rock and what the rock will look like at each step"): opens
             cutting_assistant_mode.js. -->
        <Menubar.Item id="menu-item-cutting-assistant" {@attach ariaDisabled(() => cuttingInert)}
          class="{ITEM} {INERT}" data-tip={cuttingTip}
          onSelect={() => { if (!cuttingInert) enterCuttingAssistant(); }}
          >Cutting assistant</Menubar.Item>
        <Menubar.Item id="menu-item-record-rendering" {@attach ariaDisabled(() => true)}
          class="{ITEM} {INERT}"
          data-tip="Records the render as a video while you orbit, tilt or step through the design, for sharing outside the page. {PLACEHOLDER_TIP}"
          >Record rendering</Menubar.Item>
      </Menubar.Content>
    </Menubar.Menu>

    <Menubar.Menu>
      <Menubar.Trigger id="menu-button-help" data-menu="help" class={TRIGGER}>Help</Menubar.Trigger>
      <Menubar.Content id="menu-dropdown-help" aria-label="Help" class={MENU} align="start"
        sideOffset={4} alignOffset={0}>
        <!-- Documentation (T-0236): the site's docs page, in a new tab so the design in this one
             is not navigated away from. A real link (Bits UI's `child` snippet renders the item
             as the <a>), so a click, Enter (the item clicks itself), a middle-click and "copy
             link" all behave as a link does. The target is `docs` in src/site/site.json, the
             same value make_page.py substitutes for the landing page's @@DOCS_URL@@, so the two
             cannot drift apart. It is relative (docs.html, today) and the app is written beside the
             docs page in build/www, so it resolves both on the deployed site and from file://. -->
        <Menubar.Item id="menu-item-documentation" class={ITEM}>
          {#snippet child({ props })}
            <a {...props} href={docsUrl} target="_blank" rel="noopener">Documentation</a>
          {/snippet}
        </Menubar.Item>
        <!-- Bug report (2026-09-23): the project's GitHub issues, in a new tab, a real link like
             Documentation above. Only the app links it, so the URL lives here, not in site.json. -->
        <Menubar.Item id="menu-item-bug-report" class={ITEM}>
          {#snippet child({ props })}
            <a {...props} href={ISSUES_URL} target="_blank" rel="noopener">bug report 💀</a>
          {/snippet}
        </Menubar.Item>
      </Menubar.Content>
    </Menubar.Menu>
  </Menubar.Root>

  <!-- The mode status (see the comment above `modeStatus`): pushed to the bar's right end by its
       own `margin-left: auto` (topbar.css), the same technique `#app-title` uses to give way
       rather than push a menu button off screen -- both can shrink, and the menu bar itself
       never does. -->
  <div id="topbar-mode" data-tip="Which mode the page is in right now.">Mode: {modeStatus}</div>
</div>

<SettingsDialog bind:this={settingsDialog} />
