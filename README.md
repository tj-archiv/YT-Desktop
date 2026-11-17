# YT Desktop

A dedicated, lightweight, and modern standalone desktop client for YouTube on Windows built with Electron and Chromium.

---

## ✨ Features

- **Chrome-Grade Multi-Tabbing**:
  - Dynamically responsive tab strip that scales smoothly as tabs open.
  - Chrome-parity text & link drag-and-drop search anywhere across the tab bar with insertion caret.
  - Fluid tab reordering physics with smooth entrance and collapse animations.
  - Floating tab title hover previews.
  - Preserves video timestamps when switching tabs (auto-pauses in background and resumes on return).
- **Embedded Chrome-Style Navigation**:
  - Integrated Back (`←`), Forward (`→`), and Reload (`↻`) buttons.
  - History dropdown menu on right-click of navigation arrows.
- **Rich Channel Hovercards**:
  - Floating channel preview cards with banner, avatar, subscriber count, and bio across video feeds and sidebars (suppressed in comments for distraction-free reading).
- **Balanced Gallery Preview Audio**:
  - Capped inline hover audio on feed thumbnails at 25% volume to protect your ears while browsing.
- **Always-on-Top & Mini-Player (PiP)**:
  - Pin the window over other apps with `Ctrl + Shift + T` or the top bar pin button.
  - Compact Picture-in-Picture mode with `Ctrl + M`.
- **System Tray & Background Playback**:
  - Minimize to tray to keep music and podcasts playing in the background.
  - Right-click tray menu for quick playback controls.
- **Global Hardware Media Keys**:
  - Control playback seamlessly using keyboard `Play/Pause`, `Next`, `Previous` keys across Windows.
- **Auto Ad-Skip & Clean Experience**:
  - Automatically clicks "Skip Ad" buttons instantly.
  - Fast-forwards unskippable ads.
  - Automatically dismisses "Are you still watching?" prompts.
- **External Link Handling**:
  - Non-YouTube external links automatically open in your default system browser.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl + T` | New Tab |
| `Ctrl + W` | Close Tab |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | Next / Previous Tab |
| `Ctrl + 1` .. `Ctrl + 8` | Switch to Tab 1–8 |
| `Ctrl + 9` | Switch to Last Tab |
| `Alt + ←` / `Alt + →` | Back / Forward Navigation |
| `Ctrl + R` / `F5` | Reload Active Tab |
| `Ctrl + Shift + T` | Toggle Always-on-Top |
| `Ctrl + M` | Toggle Mini-Player (PiP Mode) |
| `F11` | Toggle Fullscreen |
| `Media Play / Pause` | Global Play / Pause |
| `Media Next / Prev` | Next / Previous Track |

---

## 🛠️ Building & Running from Source

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- Windows 10 / 11

### Setup & Run
```bash
# 1. Clone the repository
git clone https://github.com/tj-archiv/YT-Desktop.git
cd YT-Desktop

# 2. Install dependencies
npm install

# 3. Start development app
npm start
```

### Packaging Windows Binary
```bash
npm run package
```
The compiled, standalone portable application will be generated in `release/YT Desktop-win32-x64/YT Desktop.exe`.

---

## 📄 License

This project is licensed under the MIT License.

---

## ⚖️ Disclaimer

*YT Desktop is an independent, open-source project and is not affiliated with, endorsed, or sponsored by Google LLC or YouTube.*
