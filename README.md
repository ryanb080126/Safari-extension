# Study Buddy: a Safari extension

Turn it on for a tab and Claude watches what's on screen. When a multiple-choice (or true/false, or short-answer) question is visible, it puts a green ring around the correct option and a small chat bubble next to it with a one- or two-sentence explanation.

## How it works

1. **Toggle on** from the toolbar popup, or press **Control+Shift+W**. A "Watching" pill appears in the bottom-right corner of the page.
2. The content script (`extension/content.js`) reads the text elements visible in the window and tags each one with an id.
3. The background script (`src/background.js`) takes a screenshot of the visible tab and sends both to Claude. It uses structured output, so the reply is a list of `{answer_element_id, answer_text, explanation, confidence}`.
4. The content script draws a ring around each correct option and a bubble next to it. If an answer can't be tied to an element (for example, it only appears in an image), the bubble goes in the bottom-right corner instead.
5. When the page changes (you scroll, or click to the next question), it checks again after about 1.5 seconds. If the visible text hasn't changed, no new request is sent.

Low-confidence answers get a dashed ring. Click the × on a bubble to dismiss it, or click the pill to stop watching.

## Setup on iPad or iPhone (no Mac needed)

You can't build a Safari extension on an iPad, so this version runs inside **Userscripts**, a free, open-source Safari extension. The script is `userscript/study-buddy.user.js`.

1. Install **Userscripts** (by Justin Wasack) from the App Store.
2. Open the Userscripts app once and pick a folder for your scripts (for example, a "Userscripts" folder in On My iPad).
3. Turn it on in **Settings → Apps → Safari → Extensions → Userscripts**. Set **All Websites** to **Allow**.
4. In Safari, open `userscript/study-buddy.user.js` in this GitHub repo and tap **Raw**. Then tap the **aA** (or puzzle-piece) button in the address bar, choose **Userscripts**, and tap **Install**.
   - Another way: open the Userscripts popup on any page, tap **+** to create a new script, delete the template, paste in the contents of the file, and save.
5. Open any page. A **Study Buddy** button and a **⚙︎** button appear in the bottom-right corner. Tap **⚙︎**, paste your Anthropic API key, and tap **Save**.
6. Tap **Study Buddy** to start watching, and tap it again to stop. Watching stays on for that tab and site when the page reloads.

Differences from the Mac version: it sends only the page text, not a screenshot, so it can't read questions that are inside images. There's also no keyboard shortcut.

## Setup on a Mac (requires Xcode)

Safari extensions have to be wrapped in a small macOS/iOS app, and Apple's converter does that for you.

```bash
npm install
npm run build                      # bundles src/background.js -> extension/background.js
xcrun safari-web-extension-converter extension --app-name "Study Buddy" --macos-only
```

Then:

1. Xcode opens the generated project. Press **Run** (⌘R).
2. In Safari, go to **Settings → Advanced** and turn on **Show features for web developers**. Then, under **Develop**, turn on **Allow Unsigned Extensions**. You need to do this again each time Safari restarts while the extension is unsigned.
3. Go to **Safari → Settings → Extensions**, turn on **Study Buddy**, and allow it on all websites.
4. Click the toolbar icon, open **Settings**, paste your Anthropic API key (from console.anthropic.com), and click **Save**.

To get it on iPhone or iPad as well, leave out `--macos-only`.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Model | Claude Opus 5.5 | Most accurate. Sonnet 5.5 and Haiku 5.5 are faster and cheaper. |
| Effort | Medium | Low gives quicker bubbles; High is more careful on hard questions. |
| Send a screenshot | On | Needed for questions in images or diagrams. Turn it off to send only the page text, which is cheaper. |

Each check is one API call, billed to your key. Re-checks happen only when the visible text changes.

## Project layout

```
extension/            the Safari Web Extension (this folder is what gets converted)
  manifest.json
  content.js          reads the page and draws the rings and bubbles (in a shadow DOM)
  background.js       built output, not committed
  popup/              toggle and settings UI
  icons/
userscript/           iPad/iPhone version (runs in the free Userscripts Safari extension)
src/background.js     Claude API calls (@anthropic-ai/sdk), screenshots, per-tab watch state
build.mjs             esbuild bundle step
```

## Privacy

- Your API key is stored only in the extension's local storage on your device.
- While watching is on, the visible text of the page (and a screenshot, if enabled) is sent to the Anthropic API. Nothing is sent while it's off.

## A note on tests

This works well for practice quizzes, homework review and studying. If you're taking a graded test, check your school's rules first: most don't allow outside help, including AI.
