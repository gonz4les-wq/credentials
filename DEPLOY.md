# Deploying to GitHub Pages → installing on iPhone

The app is a self-contained Progressive Web App. All paths are relative — drop the folder anywhere on the web and it just runs.

## 1. Put the folder on GitHub

```powershell
cd C:\Users\resxh\Documents\Credentials2k
git init
git add .
git commit -m "Credentials PWA"
gh repo create credentials --public --source=. --push
```

(If you don't have `gh`, create an empty repo named `credentials` on github.com, then `git remote add origin https://github.com/<you>/credentials.git`, `git branch -M main`, `git push -u origin main`.)

## 2. Turn on GitHub Pages

On the repo page → **Settings** → **Pages** → **Source:** `Deploy from a branch` → **Branch:** `main`, **Folder:** `/` (root) → Save.

After ~30s your app is live at `https://<you>.github.io/credentials/`.

## 3. Install on iPhone

1. Open the URL in **Safari** (must be Safari for the install option — Chrome on iOS doesn't expose it).
2. Tap the **Share** button (the square with the arrow at the bottom).
3. Scroll down → **Add to Home Screen** → **Add**.
4. A real-looking app icon lands on your home screen. Tapping it launches full-screen, with no Safari chrome, and works offline.

The first time you launch on the home screen it'll ask you to create a 6-digit PIN. The vault lives only on that device — to copy it to another, use Settings → Export, then transfer the `.creds` file and Import.

## Updating after changes
After editing files locally, `git add . && git commit -m "update" && git push`. The service worker auto-detects new versions and reloads with fresh code on next launch.
