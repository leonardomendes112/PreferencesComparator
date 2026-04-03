# Optibus Preference Comparison Report

This project now contains the code for an extension-only workflow:

- the browser extension reads the visible preferences from the open Optibus page
- the extension stores `Previous` and `Updated`
- the extension sends both to a backend API
- the backend generates a professional PDF report
- the user downloads the PDF directly from the extension

## Folder overview

- [`backend`](/Users/leonardo.mendes/Documents/Playground/backend): FastAPI backend that parses JSON/YAML, compares preferences, and returns a PDF
- [`extension`](/Users/leonardo.mendes/Documents/Playground/extension): Chrome extension with `Set as Previous`, `Set as Updated`, and `Generate PDF Report`
- [`render.yaml`](/Users/leonardo.mendes/Documents/Playground/render.yaml): optional Render deployment file

## What the user experience looks like

1. Open an Optibus preferences page
2. Click the extension: `Set as Previous`
3. Open the other Optibus preferences page
4. Click the extension: `Set as Updated`
5. Click the extension: `Generate PDF Report`
6. The PDF downloads automatically

The user does not need to run Python locally.

## Step-by-step setup for you

### Part 1: Create a GitHub repository

1. Create a GitHub account if you do not already have one.
2. Create a new repository.
3. Upload the contents of this project to that repository.

### Part 2: Deploy the backend

The easiest option is Render.

1. Go to [Render](https://render.com).
2. Sign in.
3. Click `New +`.
4. Choose `Web Service`.
5. Connect your GitHub repository.
6. When asked for settings, use:
   - Root Directory: `backend`
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
7. Deploy the service.
8. When it finishes, copy the public URL.
   Example: `https://your-app.onrender.com`

You can test it by opening:

```text
https://your-app.onrender.com/health
```

If it works, you should see:

```json
{"status":"ok"}
```

### Part 3: Load the extension in Chrome

1. Open Chrome.
2. Go to:

```text
chrome://extensions
```

3. Turn on `Developer mode` in the top right.
4. Click `Load unpacked`.
5. Select the folder [`extension`](/Users/leonardo.mendes/Documents/Playground/extension).

### Part 4: Connect the extension to your backend

1. In `chrome://extensions`, find the extension.
2. Click `Details`.
3. Click `Extension options`.
4. Paste your backend URL.
   Example:

```text
https://your-app.onrender.com
```

5. Click `Save Settings`.

### Part 5: Use it

1. Open the first Optibus preferences page.
2. Click the extension icon.
3. Click `Set as Previous`.
4. Open the second Optibus preferences page.
5. Click the extension icon again.
6. Click `Set as Updated`.
7. Click `Generate PDF Report`.
8. Save the downloaded PDF.

## Local testing for you

If you want to test everything on your own machine before hosting:

1. Open Terminal
2. Go to the project folder:

```bash
cd /Users/leonardo.mendes/Documents/Playground/backend
```

3. Install dependencies:

```bash
python3 -m pip install -r requirements.txt
```

4. Start the backend:

```bash
uvicorn main:app --reload
```

5. In the extension settings, use:

```text
http://127.0.0.1:8000
```

## What the backend accepts

- JSON
- YAML

The backend compares the two versions in an order-insensitive way, so moved blocks should not be treated as added or removed.

## Important note for clients

For clients, you should not ask them to use `Load unpacked`.
The proper client delivery path is:

1. host the backend
2. publish the extension in the Chrome Web Store

That way they only need to:

1. install the extension once
2. use the three buttons

## Sample files

Sample files are included in [`examples/original.json`](/Users/leonardo.mendes/Documents/Playground/examples/original.json) and [`examples/updated.json`](/Users/leonardo.mendes/Documents/Playground/examples/updated.json).
